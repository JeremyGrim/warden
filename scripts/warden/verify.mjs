#!/usr/bin/env node
// The repository checks, on the workstation. Nothing goes online: no CI verifies the repository in place of the
// workstation. What gets verified is in config/factory.json, section `verify`.
//
//   node scripts/warden/verify.mjs push         what a push touches; the pre-push hook runs it
//   node scripts/warden/verify.mjs all          the whole repository
//   node scripts/warden/verify.mjs files        the files named on standard input, one per line (the train)
//   node scripts/warden/verify.mjs advisories   the dependency advisories alone, whatever changed (the train, on main)
//
// A failing step stops the verification. Exit code: 0 passed, 1 a gap, 3 (`files`, `advisories`, `all`) everything
// that ran passed but a check asked for did not run; a push applies `verify.when_missing` itself. Each failed step gets
// a class (outcome.mjs): an incident of the workstation is replayed once; a tool that is not there is "not run", never
// passed. With WARDEN_REPORT set, each step is also written there, one JSON line each: the train reads it.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory, ROOT, runCaptured, stationSetting } from './config.mjs';
import { appendHistory, historyPath } from './history.mjs';
import { t } from './messages.mjs';
import { advisoryDatabase } from './npm-audit.mjs';
import { EXIT_INCOMPLETE, missingTool, transientCause } from './outcome.mjs';
import { refresh, release, releaseOnArrival, slotFolder, take } from './slot.mjs';

const ZERO = /^0+$/;
const posix = (path) => path.replaceAll('\\', '/');
const patterns = (list) => (list ?? []).map((p) => new RegExp(p));

// The Rust workspace packages: their name, relative folder, and the workspace packages they depend on (normal, dev
// and build dependencies: a broken test in a dependent counts too).
export function workspacePackages(metadata) {
  const root = metadata.workspace_root;
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((p) => members.has(p.id));
  const names = new Set(packages.map((p) => p.name));
  return packages.map((p) => ({
    name: p.name,
    dir: posix(relative(root, dirname(p.manifest_path))),
    dependencies: [...new Set(p.dependencies.filter((d) => d.path && names.has(d.name)).map((d) => d.name))],
  }));
}

// The package of a file: the one whose folder is the longest prefix of the path. A package at the root (empty folder)
// takes whatever no other package takes.
function packageOf(file, packages) {
  let found = null;
  for (const p of packages) {
    const inside = p.dir === '' || file === p.dir || file.startsWith(`${p.dir}/`);
    if (inside && (!found || p.dir.length > found.dir.length)) found = p;
  }
  return found;
}

// The packages that depend, even transitively, on the given ones; the given ones included.
export function withDependents(names, packages) {
  const reached = new Set(names);
  let added = true;
  while (added) {
    added = false;
    for (const p of packages) {
      if (!reached.has(p.name) && p.dependencies.some((d) => reached.has(d))) {
        reached.add(p.name);
        added = true;
      }
    }
  }
  return [...reached].sort();
}

// What a push asks for, given the files it changes and the `verify` section.
export function pushPlan(files, packages, verify) {
  const paths = files.map(posix);
  const touches = (list) => paths.some((f) => patterns(list).some((p) => p.test(f)));
  const conf = verify.rust;
  let rust = { all: false, clippy: [], tests: [] };
  if (conf && packages) {
    const touched = [...new Set(paths.map((f) => packageOf(f, packages)?.name).filter(Boolean))].sort();
    rust = touches(conf.full_on) ? { all: true, clippy: [], tests: [] } : { all: false, clippy: withDependents(touched, packages), tests: touched };
    if (!rust.all && packages.length && rust.clippy.length === packages.length) rust = { all: true, clippy: [], tests: [] };
  }
  return {
    rust,
    // An added or bumped dependency goes through the dependency check: advisories, licenses, sources.
    dependencies: Boolean(conf?.deny) && paths.some((f) => /(^|\/)Cargo\.(toml|lock)$/.test(f) || f === conf.deny),
    // A changed npm lockfile goes through the npm advisories, compared on the workstation.
    npmAdvisories: Boolean(verify.npm_advisories) && paths.includes(verify.npm_advisories.lockfile),
    steps: (verify.steps ?? []).filter((s) => touches(s.when)),
  };
}

// The commits a push sends, from what Git gives the hook on standard input.
export function pushedRefs(input) {
  return input.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((words) => words.length === 4)
    .map(([localRef, local, remoteRef, remote]) => ({ localRef, local, remoteRef, remote }))
    .filter((ref) => !ZERO.test(ref.local));
}

function git(args) {
  const out = spawnSync('git', args, { windowsHide: true, cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr.trim()}`);
  return out.stdout.trim();
}

const exists = (commit) => spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { windowsHide: true, cwd: ROOT }).status === 0;

// The tests a `cargo test` output reports as failed.
export function failedTests(output) {
  return [...new Set([...output.matchAll(/^test (\S+) \.\.\. FAILED\r?$/gm)].map((m) => m[1]))];
}

// What this run verified, step by step, and what it could not run.
const records = [];
function record(entry) {
  records.push(entry);
  if (process.env.WARDEN_REPORT) appendFileSync(process.env.WARDEN_REPORT, `${JSON.stringify(entry)}\n`);
}
const notRunTitles = () => records.filter((r) => r.kind === 'not_run').map((r) => r.title);

// A check asked for that cannot run is said and recorded: it never counts as passed.
function notRun(title, reason) {
  console.log(t('verify.not_run', { title, reason }));
  record({ kind: 'not_run', title, reason });
}

// A step: `{ title, command, unchanged }`. `unchanged`: paths the command must not change (generated files, never
// edited by hand). Returns `pass`, `fail` or `incomplete`.
async function step({ title, command, unchanged = [] }, extra = []) {
  console.log(`\n▶ ${title}`);
  const start = Date.now();
  const duration = () => `${Math.round((Date.now() - start) / 1000)} s`;
  const done = (ok, cls = null, retried = null) => {
    record({ kind: 'step', title, ok, class: cls, seconds: (Date.now() - start) / 1000, retried });
    return ok ? 'pass' : 'fail';
  };
  let out = await runCaptured(command);
  if (out.status !== 0 && missingTool(out)) {
    notRun(title, t('verify.tool_missing', { program: command.slice(0, 2).join(' ') }));
    return 'incomplete';
  }
  // An incident of the workstation (memory, a file held, the network) is not the code: the step is replayed once.
  const retried = out.status === 0 ? null : transientCause(out, extra);
  if (retried) {
    console.log(`\n${t('verify.incident_retry', { title, incident: retried })}`);
    out = await runCaptured(command);
    const again = out.status === 0 ? null : transientCause(out, extra);
    if (again) {
      console.error(t('verify.incident_failed', { title, duration: duration(), incident: again }));
      return done(false, 'transient', retried);
    }
  }
  if (out.status === 0) {
    const changes = unchanged.length ? git(['status', '--porcelain', '--', ...unchanged]) : '';
    if (changes) {
      console.error(t('verify.unchanged_changed', { title, changes }));
      spawnSync('git', ['checkout', '--', ...unchanged], { windowsHide: true, cwd: ROOT });
      return done(false, 'violation', retried);
    }
    console.log(`✔ ${title} (${duration()})${retried ? ` — ${t('verify.after_incident')}` : ''}`);
    return done(true, null, retried);
  }
  // A timed test fails on a saturated workstation: each failed test is replayed once, alone with the other failed ones.
  // It only counts as passed if it passes; the report names it.
  const tests = command[0] === 'cargo' && command[1] === 'test';
  const failed = tests ? failedTests(out.text) : [];
  if (failed.length && failed.length <= 20) {
    console.log(`\n${t('verify.retry', { count: failed.length, tests: failed.join(', ') })}`);
    const filtered = command.filter((a) => a !== '--no-fail-fast');
    const separator = filtered.indexOf('--');
    const before = separator < 0 ? filtered : filtered.slice(0, separator);
    const after = separator < 0 ? [] : filtered.slice(separator + 1);
    const second = await runCaptured([...before, '--no-fail-fast', '--', ...after, '--exact', ...failed]);
    const still = failedTests(second.text);
    if (second.status === 0 && !still.length) {
      console.log(t('verify.retry_ok', { title, duration: duration(), tests: failed.join(', ') }));
      return done(true, null, failed.join(', '));
    }
    console.error(t('verify.retry_failed', { title, duration: duration(), tests: (still.length ? still : failed).join(', ') }));
    return done(false, 'defect', failed.join(', '));
  }
  console.error(t('verify.failed', { title, duration: duration() }));
  return done(false, 'defect', retried);
}

const cargoP = (names) => names.flatMap((name) => ['-p', name]);

// Security advisories (public RustSec database, compared to the lockfile on the workstation), licenses, sources.
const dependencyStep = (conf) => ({ title: t('verify.step.deny'), command: ['cargo', 'deny', '--config', conf.deny, 'check'] });

// The npm advisories of the lockfile, compared on the workstation to a clone of the GitHub Advisory Database: nothing
// goes online. With no clone on the workstation, the step is not run, and says so: never passed.
function npmSteps(conf) {
  if (!advisoryDatabase()) {
    notRun(t('verify.step.npm'), t('verify.npm_no_database'));
    return [];
  }
  return [{ title: t('verify.step.npm'), command: ['node', 'scripts/warden/npm-audit.mjs', '--lockfile', conf.lockfile] }];
}

// Packages tested separately (`separate`): a shell that is only tested with its own arguments.
function rustSteps(rust, conf) {
  const separate = conf.separate ?? [];
  const steps = [];
  if (conf.clippy !== false) {
    steps.push({ title: t('verify.step.clippy'), command: ['cargo', 'clippy', ...(rust.all ? ['--workspace'] : cargoP(rust.clippy)), '--all-targets', '--locked', '--', '-D', 'warnings'] });
  }
  if (conf.tests === false) return steps;
  if (rust.all) {
    steps.push({ title: t('verify.step.workspace_tests'), command: ['cargo', 'test', '--workspace', ...separate.flatMap((s) => ['--exclude', s.package]), '--locked', '--no-fail-fast'] });
    for (const s of separate) steps.push({ title: t('verify.step.tests_of', { packages: s.package }), command: ['cargo', 'test', '-p', s.package, ...(s.args ?? []), '--locked'] });
    return steps;
  }
  const alone = rust.tests.filter((name) => !separate.some((s) => s.package === name));
  if (alone.length) steps.push({ title: t('verify.step.tests_of', { packages: alone.join(', ') }), command: ['cargo', 'test', ...cargoP(alone), '--locked', '--no-fail-fast'] });
  for (const s of separate.filter((x) => rust.tests.includes(x.package))) {
    steps.push({ title: t('verify.step.tests_of', { packages: s.package }), command: ['cargo', 'test', '-p', s.package, ...(s.args ?? []), '--locked'] });
  }
  return steps;
}

// The steps in order; the first failure stops. `incomplete` when everything that ran passed and something was not run.
async function play(steps, verify) {
  for (const s of steps) if ((await step(s, verify.transient_patterns ?? [])) === 'fail') return 'fail';
  return notRunTitles().length ? 'incomplete' : 'pass';
}

function metadata() {
  const out = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], { windowsHide: true, cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(`cargo metadata: ${out.stderr.trim()}`);
  return JSON.parse(out.stdout);
}

// What is verified is the working tree: it must be the pushed commit, with no tracked modification.
function treeIsCommit(local) {
  const head = git(['rev-parse', 'HEAD']);
  if (head !== local) return t('verify.tree_not_commit', { pushed: local.slice(0, 7), head: head.slice(0, 7) });
  if (git(['status', '--porcelain', '--untracked-files=no'])) return t('verify.tree_modified');
  return null;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function stationSlot(factory = readFactory(), root = ROOT) {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true, cwd: root, encoding: 'utf8' }).stdout?.trim() || null;
  return slotFolder({ configured: stationSetting('slot', root), commonGitDir: common, name: factory.slot.name, workDir: factory.work_dir });
}

export const slotLog = (folder, factory = readFactory()) => (factory.slot.log ? join(dirname(folder), factory.slot.log) : null);

// While this process lives, a separate process refreshes the slot time every 5 minutes: the verification blocks this
// one, and a slot older than 50 minutes would look abandoned.
export function keepSlot(folder) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'keep-slot', folder, String(process.pid)], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// The hook ends before Git sends: a detached process gives the slot back when the main branch carries the commit.
function releaseAfterPush(folder, commit) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'release-slot', folder, commit], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function pushCommand(input) {
  const factory = readFactory();
  const { main_branch: main, remote } = factory;
  const refs = pushedRefs(input);
  if (!refs.length) return true;
  for (const ref of refs) {
    const refusal = treeIsCommit(ref.local);
    if (refusal) {
      console.error(t('verify.refused', { reason: refusal }));
      return false;
    }
  }
  // One push to the main branch at a time on the workstation: the slot is taken before any verification.
  const toMain = refs.find((ref) => ref.remoteRef === `refs/heads/${main}`);
  const folder = toMain ? stationSlot(factory) : null;
  if (toMain && !folder) console.warn(t('verify.no_slot', { work: factory.work_dir }));
  if (folder) {
    const got = await take({ folder, tree: ROOT, commit: toMain.local, sleep, say: (text) => console.log(text), log: slotLog(folder, factory) });
    if (!got.taken) {
      console.error(t('verify.push_refused', { reason: got.reason }));
      return false;
    }
    console.log(got.takenBack ? t('verify.slot_taken_back', { holder: got.takenBack }) : t('verify.slot_taken'));
    keepSlot(folder);
  }
  let passed = false;
  let result = null;
  const begin = Date.now();
  try {
    if (toMain) {
      const fetched = spawnSync('git', ['fetch', '--quiet', remote, main], { windowsHide: true, cwd: ROOT, encoding: 'utf8' });
      // A first push to an empty remote has nothing to fetch; any other failure stops.
      if (fetched.status !== 0 && git(['ls-remote', '--heads', remote, main])) throw new Error(`git fetch ${remote} ${main}: ${fetched.stderr.trim()}`);
      const tracking = `${remote}/${main}`;
      if (exists(tracking) && spawnSync('git', ['merge-base', '--is-ancestor', tracking, toMain.local], { windowsHide: true, cwd: ROOT }).status !== 0) {
        console.error(t('verify.main_moved', { branch: main, tracking }));
        return false;
      }
    }
    // The train has just verified this exact commit, in this tree, under this slot: it is not verified again.
    if (toMain && refs.length === 1 && alreadyVerified(toMain.local)) {
      console.log(t('verify.already', { commit: toMain.local.slice(0, 7) }));
      result = 'already';
      passed = true;
    } else {
      result = await verifyPush(refs, factory);
      // A check that could not run: the push goes said "not run", or waits, as the project chose. Never "passed".
      const block = factory.verify.when_missing === 'block';
      if (result === 'incomplete') console.log(t(block ? 'verify.incomplete_block' : 'verify.incomplete_record', { steps: notRunTitles().join(', ') }));
      passed = result === 'pass' || (result === 'incomplete' && !block);
    }
    return passed;
  } finally {
    if (result) {
      const steps = records.filter((r) => r.kind === 'step').map(({ title, seconds, ok, class: c, retried }) => ({ title, seconds, ok, class: c, retried }));
      appendHistory(historyPath(stationSlot(factory)), {
        kind: 'push', tree: ROOT, ref: refs[0].remoteRef, commit: refs[0].local, to_main: Boolean(toMain), result,
        class: steps.find((s) => !s.ok)?.class ?? null, steps, not_run: notRunTitles(), seconds: (Date.now() - begin) / 1000,
      }, { keepDays: factory.history.keep_days });
    }
    if (folder && passed) releaseAfterPush(folder, toMain.local);
    else if (folder) release(folder, ROOT);
  }
}

// The train's witness: the commit it verified, in the Git folder of this tree (nothing of it is committed).
const trainWitness = () => git(['rev-parse', '--git-path', 'warden-train-verified']);
export function markVerified(commit) {
  writeFileSync(resolve(ROOT, trainWitness()), `${commit}\n`);
}
function alreadyVerified(commit) {
  try {
    return readFileSync(resolve(ROOT, trainWitness()), 'utf8').trim() === commit;
  } catch {
    return false;
  }
}

async function verifyPush(refs, factory) {
  const tracking = `${factory.remote}/${factory.main_branch}`;
  let files = [];
  for (const ref of refs) {
    let base = !ZERO.test(ref.remote) && exists(ref.remote) ? ref.remote : null;
    if (!base && exists(tracking)) base = git(['merge-base', ref.local, tracking]);
    // A first push, with nothing on the other side: everything the commit carries.
    const changed = base ? git(['diff', '--name-only', base, ref.local]) : git(['ls-tree', '-r', '--name-only', ref.local]);
    files = files.concat(changed.split('\n').filter(Boolean));
  }
  return verifyFiles(files, factory);
}

const hasRust = (verify) => Boolean(verify.rust) && spawnSync('git', ['ls-files', '--error-unmatch', 'Cargo.toml'], { windowsHide: true, cwd: ROOT }).status === 0;

// What a list of changed files asks for, played on the working tree as it is: `pass`, `fail` or `incomplete`.
export async function verifyFiles(files, factory = readFactory()) {
  const { verify } = factory;
  const plan = pushPlan(files, hasRust(verify) ? workspacePackages(metadata()) : null, verify);
  const steps = [];
  if (plan.dependencies) steps.push(dependencyStep(verify.rust));
  if (plan.npmAdvisories) steps.push(...npmSteps(verify.npm_advisories));
  steps.push(...plan.steps);
  if (plan.rust.all || plan.rust.clippy.length) steps.push(...rustSteps(plan.rust, verify.rust));
  if (!steps.length) {
    console.log(t('verify.nothing'));
    return notRunTitles().length ? 'incomplete' : 'pass';
  }
  const scope = plan.rust.all ? t('verify.scope.rust_all') : plan.rust.clippy.length ? t('verify.scope.rust_some', { count: plan.rust.clippy.length }) : t('verify.scope.rust_none');
  console.log(t('verify.scope', { count: files.length, scope, steps: plan.steps.length }));
  return play(steps, verify);
}

// The advisories alone, whatever changed: a new advisory turns the main branch red without any branch, and the train
// runs this on the main branch before each batch (19 November).
function advisoriesCommand() {
  const { verify } = readFactory();
  const steps = [];
  if (hasRust(verify) && verify.rust.deny) steps.push(dependencyStep(verify.rust));
  if (verify.npm_advisories) steps.push(...npmSteps(verify.npm_advisories));
  if (!steps.length && !records.length) {
    console.log(t('verify.no_advisories'));
    return 'pass';
  }
  return play(steps, verify);
}

function allCommand() {
  const { verify } = readFactory();
  const steps = [
    { title: t('verify.step.rules'), command: ['node', 'scripts/warden/rules.mjs'] },
    { title: t('verify.step.guards'), command: ['node', '--test', 'scripts/**/*.test.mjs'] },
  ];
  const rust = hasRust(verify);
  if (rust && verify.rust.deny) steps.push(dependencyStep(verify.rust));
  if (verify.npm_advisories) steps.push(...npmSteps(verify.npm_advisories));
  steps.push(...(verify.steps ?? []));
  if (rust) steps.push(...rustSteps({ all: true }, verify.rust));
  steps.push(...(verify.all ?? []));
  return play(steps, verify);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'push') return pushCommand(readFileSync(0, 'utf8'));
  if (command === 'keep-slot') {
    // It checks often whether the verification still lives, to end with it; it refreshes the time every 5 minutes.
    const [folder, pid] = rest;
    let last = Date.now();
    while (alive(Number(pid))) {
      if (Date.now() - last >= 5 * 60 * 1000) {
        if (!refresh(folder, ROOT)) break;
        last = Date.now();
      }
      await sleep(5 * 1000);
    }
    return true;
  }
  if (command === 'release-slot') {
    const [folder, commit] = rest;
    const { remote, main_branch: main } = readFactory();
    const remoteHead = () => spawnSync('git', ['ls-remote', remote, `refs/heads/${main}`], { windowsHide: true, cwd: ROOT, encoding: 'utf8' }).stdout?.split(/\s/)[0];
    await releaseOnArrival({ folder, tree: ROOT, commit, remoteHead, sleep });
    return true;
  }
  if (command === 'all') return allCommand();
  if (command === 'files') return verifyFiles(readFileSync(0, 'utf8').split(/\r?\n/).map((f) => f.trim()).filter(Boolean));
  if (command === 'advisories') return advisoriesCommand();
  console.error(t('verify.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    const outcome = await main(process.argv.slice(2));
    process.exitCode = outcome === 'incomplete' ? EXIT_INCOMPLETE : outcome === true || outcome === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(t('verify.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
