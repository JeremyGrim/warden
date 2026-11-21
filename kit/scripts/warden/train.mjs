#!/usr/bin/env node
// The train to the main branch: the factory, the only tree that pushes there, brings ready branches in by batches.
//
//   node scripts/warden/train.mjs run --agent <name> [--with <local branch>] [--batch N]   takes the slot and runs one batch
//   node scripts/warden/train.mjs run --dry-run                                           stacks and says what would go up, verifying and pushing nothing
//   node scripts/warden/train.mjs watch                                                   returns as soon as a branch is waiting
//   node scripts/warden/train.mjs recover                                                 puts the tree back after an interrupted train
//
// A ready branch is docked in the dock folder next to the slot: a `<session>.txt` file giving `tree`, `branch`,
// `commit` (the train takes exactly that commit), `tasks`, `docked`, `scenario` when the change shows on screen, and
// `priority` when the person orders the dock. The driver takes at most `train.max_batch` branches, stacks them on the
// main branch, sets aside a branch that conflicts with the main branch without resolving it in place of its author,
// then verifies and builds once for the batch, and pushes. When the trial fails, it looks for the culprit by halves,
// takes it out and pushes the rest; when every branch fails, it verifies the main branch alone before blaming any.
// Branches beyond the batch wait for the next train. Install and build commands are in config/factory.json, `train`;
// each train writes its log in `train-logs/`, next to the dock.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FACTORY_DEFAULTS, readFactory, ROOT, run, stationCommand, stationSetting } from './config.mjs';
import { freeMemory, stationProcesses } from './disk.mjs';
import { t } from './messages.mjs';
import { adjust, projectTrees, restorePriorities, stationTrees } from './priority.mjs';
import { release, take } from './slot.mjs';
import { keepSlot, markVerified, slotLog, stationSlot } from './verify.mjs';

// A batch of thirteen that fails costs up to four extra verifications; a batch of four, two (11 November 2026).
export const MAX_BATCH = FACTORY_DEFAULTS.train.max_batch;
const GIB = 1024 ** 3;

// A deposit: `key = value` lines. The docking moment `dd/mm hh:mm` takes the year that puts it closest to now (a deposit
// of 31 December read on 1 January stays first); with no moment, the file date.
export function readDeposit(name, text, fileDate = 0, now = Date.now()) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const found = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (found) fields[found[1].toLowerCase()] = found[2];
  }
  const when = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(fields.docked ?? '');
  let moment = fileDate;
  if (when) {
    const year = new Date(now).getFullYear();
    const at = (y) => new Date(y, Number(when[2]) - 1, Number(when[1]), Number(when[3]), Number(when[4])).getTime();
    moment = [year - 1, year, year + 1].map(at).reduce((best, m) => (Math.abs(m - now) < Math.abs(best - now) ? m : best));
  }
  return {
    name,
    tree: fields.tree,
    branch: fields.branch,
    commit: fields.commit || null,
    tasks: (fields.tasks ?? '').split(/[,\s]+/).filter(Boolean),
    scenarios: (fields.scenario ?? '').split(/[,\s]+/).filter(Boolean),
    priority: /^-?\d+$/.test(fields.priority ?? '') ? Number(fields.priority) : null,
    refused: fields.refused ?? null,
    moment,
  };
}

// The deposits that leave: complete, with no pending refusal. A deposit with a `priority` leaves first, the lowest
// number first (the person's order of value); then arrival order.
export function readyDeposits(deposits) {
  const rank = (d) => d.priority ?? Number.POSITIVE_INFINITY;
  return deposits.filter((d) => d.tree && d.branch && !d.refused)
    .sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) - rank(b)) || a.moment - b.moment || a.name.localeCompare(b.name));
}

// The dock as it is: every deposit, ready ones first, then the refused. Deposits that went up live in `taken/`.
export function readDock(dock) {
  const files = existsSync(dock) ? readdirSync(dock).filter((f) => f.endsWith('.txt')) : [];
  return files.map((f) => readDeposit(f, readFileSync(join(dock, f), 'utf8'), statSync(join(dock, f)).mtimeMs));
}

// This train's batch: the candidates in order, each stacked on the previous ones (`stack(deposit)` returns what blocks
// it, or null). A blocked candidate goes out; the batch fills up with the next ones up to `max`. The factory's own
// branch (`own`, from --with) is always taken and never counts in the batch: a release version once waited behind a
// full dock (20 November).
export function chooseBatch(candidates, stack, max = MAX_BATCH) {
  const batch = [];
  const conflicts = [];
  let counted = 0;
  for (const deposit of candidates) {
    if (!deposit.own && counted >= max) continue;
    const cause = stack(deposit);
    if (cause) {
      conflicts.push({ deposit, cause });
    } else {
      batch.push(deposit);
      if (!deposit.own) counted += 1;
    }
  }
  return { batch, conflicts };
}

// The search by halves: `attempt(list)` says whether the list passes. Returns what goes up and what goes out. Kept
// branches stay in order; each trial carries the kept ones, then the candidates. When the left half passes whole, the
// failure of the whole comes from the right: it is not verified again.
export async function sortOut(candidates, attempt, kept = [], knownFailure = false) {
  if (!candidates.length) return { up: kept, out: [] };
  if (!knownFailure && (await attempt([...kept, ...candidates]))) return { up: [...kept, ...candidates], out: [] };
  if (candidates.length === 1) return { up: kept, out: candidates };
  const middle = Math.ceil(candidates.length / 2);
  const left = await sortOut(candidates.slice(0, middle), attempt, kept);
  const right = await sortOut(candidates.slice(middle), attempt, left.up, left.out.length === 0);
  return { up: right.up, out: [...left.out, ...right.out] };
}

// The commits of a deposit the train does not have yet, by `git cherry` ("-": the same patch is already in the train).
// A branch stacked on another deposit carries its commits: replayed after a later commit touching the same lines, an
// already taken commit would look like a conflict (12 November, 09:08).
export function notYetTaken(commits, cherry) {
  const taken = new Set(cherry.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()));
  return commits.filter((c) => !taken.has(c));
}

// The task tool follows the tracking contract: `<tool> note <task> <text> --agent <name>`. A Node script goes through
// Node; any other program runs as is.
export function noteCommand(tool, agent, task, text) {
  const args = ['note', task, text, '--agent', agent];
  return /\.(mjs|cjs|js)$/i.test(tool) ? ['node', tool, ...args] : [tool, ...args];
}

// What a failed step says first, so that its author knows what to fix without the log: a compiler error, a rule
// finding, a failed test, with the summary line of a Warden step when there is one (the cause used to be one generic
// sentence, 21 November). Each part is cut to 200 characters.
export function firstError(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cut = (l) => (l.length > 200 ? `${l.slice(0, 197)}...` : l);
  const summary = lines.findLast((l) => l.startsWith('✖'));
  const specific = lines.find((l) => /^error(\[\w+\])?:/.test(l) && !/^error: (test failed|could not compile|aborting)/.test(l))
    ?? lines.find((l) => /^\[[a-z][\w-]*\] \S+: /.test(l))
    ?? lines.find((l) => /^test \S+ \.\.\. FAILED$/.test(l))
    ?? lines.find((l) => /^✖ (?!failing tests:)/.test(l) && l !== summary)
    ?? lines.find((l) => /^not ok \d/.test(l));
  const parts = [summary, specific].filter(Boolean).map(cut);
  return parts.length ? parts.join(' — ') : cut(lines.at(-1) ?? '');
}

// The train's build jobs: every core, bounded by the memory free to commit. A build that runs out of it fails
// (os error 1455, 19 November). Unknown memory: every core.
export function jobsFor(free, cores, perJobGib) {
  if (free === null || !perJobGib) return cores;
  return Math.max(1, Math.min(cores, Math.floor(free / (perJobGib * GIB))));
}

function git(args, options = {}) {
  const out = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, ...options });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim(), error: (out.stderr ?? '').trim() };
}

function must(args) {
  const r = git(args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.error}`);
  return r.out;
}

// A step's command, printed live and written to the train log; its output is kept to name the cause of a failure.
function runLogged(command, { log, input = null }) {
  const { program, args, shell } = stationCommand(command);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  void NODE_TEST_CONTEXT;
  return new Promise((done) => {
    let text = '';
    const child = spawn(program, args, { cwd: ROOT, env, shell, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const keep = (stream) => (chunk) => {
      stream.write(chunk);
      if (log) appendFileSync(log, chunk);
      if (text.length < 1 << 23) text += chunk.toString('utf8');
    };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));
    if (input !== null) child.stdin.end(input);
    child.on('error', (error) => done({ status: 1, text: `${text}\n${error.message}` }));
    child.on('close', (status) => done({ status, text }));
  });
}

const clockTime = () => new Date().toTimeString().slice(0, 5);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const fileList = (files) => (files.length ? `: ${files.slice(0, 4).join(', ')}` : '');
const sameTree = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
export const dockFolder = (slot, factory) => join(dirname(slot), factory.train.dock);

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// Where the train left from, and its process, in the Git folder of this tree while it runs: what `recover` needs after
// an interruption.
const startRecord = () => resolve(ROOT, must(['rev-parse', '--git-path', 'warden-train-start']));
function readStart(file) {
  try {
    const [start, pid] = readFileSync(file, 'utf8').split(/\r?\n/);
    return { start: start || null, pid: Number(pid) || null };
  } catch {
    return null;
  }
}

// One factory at a time: once a factory tree is declared for the workstation, the train runs only there.
function checkFactoryTree() {
  const factoryTree = stationSetting('factory');
  if (factoryTree && !sameTree(factoryTree, ROOT)) throw new Error(t('train.not_factory', { tree: factoryTree }));
}

async function runTrain(argv, factory) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const agent = value('--agent') ?? 'train';
  const dryRun = argv.includes('--dry-run');
  const { main_branch: main, remote, train } = factory;
  const tracking = `${remote}/${main}`;
  checkFactoryTree();
  const max = Number(value('--batch') ?? train.max_batch);
  if (!Number.isInteger(max) || max < 1) throw new Error(t('train.batch_arg'));
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  // An interrupted train leaves its tree on the train branch, sometimes mid cherry-pick: `recover` puts it back.
  const record = startRecord();
  const previous = readStart(record);
  if (previous) throw new Error(alive(previous.pid) ? t('train.still_running', { pid: previous.pid }) : t('train.interrupted', { start: previous.start }));
  if (git(['status', '--porcelain', '--untracked-files=no']).out) throw new Error(t('train.dirty'));
  const head = must(['rev-parse', '--abbrev-ref', 'HEAD']);
  // A detached factory tree comes back to the very commit it left from.
  const start = head === 'HEAD' ? must(['rev-parse', 'HEAD']) : head;

  let log = null;
  if (!dryRun) {
    mkdirSync(join(dirname(slot), 'train-logs'), { recursive: true });
    log = join(dirname(slot), 'train-logs', `${stamp()}.log`);
  }
  const say = (text) => {
    console.log(text);
    if (log) appendFileSync(log, `${text}\n`);
  };

  // A branch stacked on the train as it is. Returns the conflicting files, or null when it stacks.
  const stackFiles = (deposit) => {
    if (!deposit.commits.length) return null;
    const cherry = git(['cherry', 'HEAD', deposit.tip]);
    const commits = cherry.ok ? notYetTaken(deposit.commits, cherry.out) : deposit.commits;
    if (!commits.length) return null;
    const picked = git(['cherry-pick', '--empty=drop', '--allow-empty', ...commits]);
    if (picked.ok) return null;
    const files = git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    git(['cherry-pick', '--abort']);
    return files;
  };
  // `-f`: a previous trial can leave a tracked file modified (a tool rewriting a lockfile during the trial, 20 November,
  // 02:25). Each trial starts again from the main branch, clean.
  const restart = (base = tracking) => must(['checkout', '--quiet', '-f', '-B', train.branch, base]);
  const build = (deposits) => {
    restart();
    return deposits.map((deposit) => ({ deposit, files: stackFiles(deposit) })).filter((c) => c.files);
  };
  // Where a deposit's commits are: fetched from its tree, or this repository's own branch when the tree is gone (a
  // removed worktree whose branch lives on). The docked commit is the one taken: commits added after docking were
  // neither verified nor declared by their author (16 November). A deposit that cannot be read is set aside alone.
  const locate = (deposit) => {
    const ref = `refs/warden-train/${deposit.name.replace(/[^\w.-]+/g, '-')}`;
    if (!deposit.own && !existsSync(deposit.tree)) {
      const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${deposit.branch}^{commit}`]);
      if (!local.ok) return { cause: t('train.branch_missing', { error: t('train.tree_absent', { tree: deposit.tree }) }) };
      must(['update-ref', ref, local.out]);
      say(t('train.tree_gone', { branch: deposit.branch, tree: deposit.tree }));
    } else {
      const fetched = git(['fetch', '--quiet', deposit.tree, `+${deposit.branch}:${ref}`]);
      if (!fetched.ok) return { cause: t('train.branch_missing', { error: fetched.error.split('\n')[0] }) };
    }
    const tipOfBranch = must(['rev-parse', ref]);
    let tip = tipOfBranch;
    if (deposit.commit) {
      const named = git(['rev-parse', '--verify', '--quiet', `${deposit.commit}^{commit}`]);
      if (!named.ok || !git(['merge-base', '--is-ancestor', named.out, tipOfBranch]).ok) return { cause: t('train.commit_gone', { commit: deposit.commit }) };
      tip = named.out;
      if (tip !== tipOfBranch) say(t('train.branch_moved', { branch: deposit.branch, commit: tip.slice(0, 7) }));
    } else if (!deposit.own) {
      say(t('train.no_commit', { branch: deposit.branch, commit: tipOfBranch.slice(0, 7) }));
    }
    const base = git(['merge-base', tracking, tip]);
    const list = base.ok ? git(['rev-list', '--reverse', '--no-merges', `${base.out}..${tip}`]) : base;
    if (!list.ok) return { cause: t('train.no_common_base', { branch: main }) };
    return { tip, commits: list.out.split('\n').filter(Boolean) };
  };

  const got = await take({ folder: slot, tree: ROOT, commit: 'train', sleep: (ms) => new Promise((f) => setTimeout(f, ms)), say, log: slotLog(slot, factory) });
  if (!got.taken) throw new Error(got.reason);
  writeFileSync(record, `${start}\n${process.pid}\n`);
  say(t('train.slot_taken'));
  keepSlot(slot);
  const tool = stationSetting('tasks');
  const note = (task, text) => tool && run(noteCommand(tool, agent, task, text), { encoding: 'utf8' });
  let pushed = false;
  try {
    if (!dryRun) {
      // The memory left to commit decides whether the train leaves, and bounds its jobs (19 November). Nothing is ever
      // stopped to free memory: the person is told.
      const free = freeMemory();
      const gib = free === null ? '?' : (free / GIB).toFixed(1);
      if (free !== null && free < train.min_free_memory_gib * GIB) {
        say(t('train.memory_low', { free: gib, min: train.min_free_memory_gib }));
        return false;
      }
      // The factory keeps the machine for its builds, and the CPU priority is its own while it runs. A train compiles once
      // per trial: the incremental cache serves it nothing, weighed 50 GiB in a factory tree and keeps the shared cache
      // from serving the workspace crates (12 November).
      if (!process.env.CARGO_BUILD_JOBS) process.env.CARGO_BUILD_JOBS = String(jobsFor(free, availableParallelism(), train.memory_per_job_gib));
      if (process.env.CARGO_INCREMENTAL === undefined) process.env.CARGO_INCREMENTAL = '0';
      say(t('train.budget', { jobs: process.env.CARGO_BUILD_JOBS, free: gib }));
      say(t('train.log', { path: log }));
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'priority', String(process.pid)], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    must(['fetch', '--quiet', remote, main]);
    const deposits = readyDeposits(readDock(dock));
    const withBranch = value('--with');
    if (withBranch) deposits.push({ name: `${agent}.txt`, tree: ROOT, branch: withBranch, commit: null, tasks: [], scenarios: [], priority: null, refused: null, moment: Date.now(), own: true });
    if (!deposits.length) {
      say(t('train.nothing'));
      return true;
    }

    const refused = [];
    const candidates = [];
    for (const deposit of deposits) {
      const found = locate(deposit);
      if (found.cause) refused.push({ deposit, cause: found.cause });
      else candidates.push({ ...deposit, ...found });
    }
    // Conflicts show without verifying: stack in order until the batch is full. A branch that conflicts with the main
    // branch alone is set aside; one that only conflicts with another branch of the batch waits, since that one may go
    // out (21 November).
    restart();
    const { batch, conflicts } = chooseBatch(candidates, stackFiles, max);
    const pending = [];
    for (const { deposit } of conflicts) {
      restart();
      const files = stackFiles(deposit);
      if (files) refused.push({ deposit, cause: t('train.conflict', { branch: main, files: fileList(files) }) });
      else pending.push(deposit);
    }
    const waiting = candidates.length - batch.length - conflicts.length + pending.length;
    say(t('train.summary', { branches: batch.map((d) => `${d.branch} (${d.commits.length})`).join(', ') || t('train.none'), refused: refused.length, waiting }));

    if (dryRun) {
      for (const { deposit, cause } of refused) say(t('train.set_aside', { branch: deposit.branch, cause }));
      for (const deposit of pending) say(t('train.conflict_waits', { branch: deposit.branch }));
      say(t('train.dry_run', { count: batch.length, base: must(['rev-parse', '--short', tracking]) }));
      return true;
    }

    // Each step prints live, goes to the log, and names its cause when it fails.
    const step = async (title, command, input = null) => {
      say(`\n▶ ${title}`);
      const begin = Date.now();
      const out = await runLogged(command, { log, input });
      const ok = out.status === 0;
      say(ok ? `✔ ${title} (${Math.round((Date.now() - begin) / 1000)} s)` : t('train.step_failed', { title }));
      return ok ? { ok } : { ok, cause: t('train.cause_step', { step: title, detail: firstError(out.text), log }) };
    };
    let installedLock = null;
    const install = async () => {
      if (!train.install) return { ok: true };
      const lock = git(['rev-parse', `HEAD:${train.install.lockfile}`]).out || 'none';
      if (lock === installedLock) return { ok: true };
      const r = await step(t('train.step.install'), train.install.command);
      installedLock = r.ok ? lock : null;
      return r;
    };
    // The trial, always in this order: the batch dependencies before any guard (a branch that adds some is verified
    // with them, 12 November, 10:27); the rules and the script guards, in seconds (two branches green each can exceed a
    // ceiling together, 11 November, 01:18); the verification of the changed files; the build, once.
    const checks = async (changed) => {
      const steps = [
        install,
        () => step(t('train.step.rules'), ['node', 'scripts/warden/rules.mjs']),
        () => step(t('train.step.guards'), ['node', '--test', '--test-reporter=dot', 'scripts/**/*.test.mjs']),
        () => step(t('train.step.verify'), ['node', 'scripts/warden/verify.mjs', 'files'], changed.join('\n')),
        () => (train.build ? step(train.build.title ?? t('train.step.build'), train.build.command) : { ok: true }),
      ];
      for (const next of steps) {
        const r = await next();
        if (!r.ok) return r;
      }
      return { ok: true };
    };
    const failures = [];
    let batchChanged = [];
    const attempt = async (list) => {
      const names = new Set(list.map((d) => d.name));
      const blocked = build(list);
      if (blocked.length) {
        failures.push({ names, cause: t('train.conflict', { branch: main, files: fileList(blocked[0].files) }) });
        return false;
      }
      const changed = git(['diff', '--name-only', tracking, 'HEAD']).out.split('\n').filter(Boolean);
      if (list.length === batch.length) batchChanged = changed;
      say(`\n${t('train.verifying', { branches: list.map((d) => d.branch).join(' + '), count: changed.length })}`);
      const r = await checks(changed);
      if (!r.ok) failures.push({ names, cause: r.cause });
      return r.ok;
    };

    let up = [];
    let out = [];
    if (batch.length) {
      // The world moves without any branch: a new advisory turns the main branch red (19 November). The advisories run
      // on the main branch alone first; when they fail there, no branch is blamed.
      restart();
      const world = await step(t('train.step.advisories'), ['node', 'scripts/warden/verify.mjs', 'advisories']);
      if (!world.ok) {
        say(t('train.main_red', { branch: main, cause: world.cause }));
        return false;
      }
      ({ up, out } = await sortOut(batch, attempt));
      // Every branch failed: the main branch alone, with the same verification of what the batch changes. When it fails
      // too, the fault is not in the branches: a red main branch, a workstation that changed (an advisory, a browser
      // without a window, 19 and 20 November). The train stops and refuses nobody.
      if (!up.length && out.length) {
        restart();
        say(`\n${t('train.verifying_main', { branch: main, count: batchChanged.length })}`);
        const alone = await checks(batchChanged);
        if (!alone.ok) {
          say(t('train.main_red', { branch: main, cause: alone.cause }));
          return false;
        }
      }
    }
    for (const deposit of out) refused.push({ deposit, cause: failures.findLast((f) => f.names.has(deposit.name))?.cause ?? t('train.cause_unknown', { log }) });

    let top = null;
    if (up.length) {
      build(up);
      top = must(['rev-parse', 'HEAD']);
      markVerified(top);
      const sent = git(['push', remote, `${train.branch}:${main}`], { stdio: 'inherit' });
      if (!sent.ok) throw new Error(t('train.push_failed'));
      pushed = true;
      const short = top.slice(0, 7);
      say(t('train.pushed', { commit: short }));
      // A deposit that went up is kept with what was taken and where: the dock keeps its history (21 November).
      const taken = join(dock, 'taken');
      mkdirSync(taken, { recursive: true });
      for (const deposit of up) {
        if (!deposit.own) {
          const file = join(dock, deposit.name);
          appendFileSync(file, `\ntaken = ${deposit.tip} in ${top} at ${new Date().toISOString()}\n`);
          renameSync(file, join(taken, `${stamp()}-${deposit.name}`));
        }
        const scenario = deposit.scenarios?.length ? t('train.note_scenario', { scenarios: deposit.scenarios.join(', ') }) : t('train.note_no_scenario');
        for (const task of deposit.tasks) note(task, t('train.note_up', { branch: main, time: clockTime(), commit: short, source: deposit.branch, scenario }));
      }
      // The train tree keeps the last trial's build, which may not be what went up: a journey is played on a build of
      // the pushed commit, in a separate tree (21 November).
      const scenarios = [...new Set(up.flatMap((d) => d.scenarios ?? []))];
      if (scenarios.length) say(t('train.scenarios', { commit: short, scenarios: scenarios.join(', ') }));
    }
    // A branch that waited on a conflict: when the branch it conflicted with went up, it conflicts with the new main
    // branch and is set aside; otherwise it waits for the next train, with no refused line.
    for (const deposit of pending) {
      if (top) {
        restart(top);
        const files = stackFiles(deposit);
        if (files) {
          refused.push({ deposit, cause: t('train.conflict', { branch: main, files: fileList(files) }) });
          continue;
        }
      }
      say(t('train.conflict_waits', { branch: deposit.branch }));
    }
    for (const { deposit, cause } of refused) {
      if (!deposit.own) appendFileSync(join(dock, deposit.name), `\nrefused = ${cause} (${t('train.of_time', { time: clockTime() })})\n`);
      for (const task of deposit.tasks) note(task, t('train.note_refused', { time: clockTime(), branch: deposit.branch, cause }));
      say(t('train.set_aside', { branch: deposit.branch, cause }));
    }
    return true;
  } finally {
    if (git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).ok) git(['cherry-pick', '--abort']);
    git(['checkout', '--quiet', '-f', start]);
    try {
      unlinkSync(record);
    } catch {
      // Already gone.
    }
    // After a successful push, the hook handed the slot to its detached process, which gives it back on arrival.
    if (!pushed) release(slot, ROOT);
  }
}

// After an interrupted train (a killed process, a workstation out of memory, a power cut): the tree goes back where the
// train left from, a cherry-pick in progress is aborted, the train references are removed, and the slot held by this
// tree is given back. It is the factory's own tree, never product code: the factory runs it alone.
function recover(factory) {
  checkFactoryTree();
  const record = startRecord();
  const previous = readStart(record);
  if (previous && alive(previous.pid)) throw new Error(t('train.still_running', { pid: previous.pid }));
  const aborted = git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).ok;
  if (aborted) git(['cherry-pick', '--abort']);
  const target = previous?.start ?? `${factory.remote}/${factory.main_branch}`;
  must(['checkout', '--quiet', '-f', ...(previous?.start ? [] : ['--detach']), target]);
  const refs = git(['for-each-ref', '--format=%(refname)', 'refs/warden-train/']).out.split('\n').filter(Boolean);
  for (const ref of refs) git(['update-ref', '-d', ref]);
  try {
    unlinkSync(record);
  } catch {
    // No record: the tree had none.
  }
  const slot = stationSlot(factory);
  if (slot) release(slot, ROOT);
  console.log(t('train.recovered', { start: target, refs: refs.length, aborted: aborted ? t('train.recover_aborted') : '' }));
  return true;
}

// Returns as soon as a branch waits for the train, costing nothing meanwhile: one look at the folder per minute.
async function watch(factory) {
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  for (;;) {
    const ready = readyDeposits(readDock(dock));
    if (ready.length) {
      console.log(t('train.ready', { branches: ready.map((d) => d.branch).join(', ') }));
      return true;
    }
    await new Promise((done) => setTimeout(done, 60 * 1000));
  }
}

// While the train lives: one pass every 10 seconds. When it ends, the previous priorities come back.
async function keepPriority(pid) {
  const others = projectTrees(stationTrees(ROOT));
  const kept = new Map();
  while (alive(pid)) {
    const processes = stationProcesses();
    if (processes) adjust(processes, ROOT, kept, { others });
    await new Promise((done) => setTimeout(done, 10 * 1000));
  }
  restorePriorities(kept);
  return true;
}

async function main([command, ...rest]) {
  if (command === 'run') return runTrain(rest, readFactory());
  if (command === 'watch') return watch(readFactory());
  if (command === 'recover') return recover(readFactory());
  if (command === 'priority') return keepPriority(Number(rest[0]));
  console.error(t('train.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ? 0 : 1;
  } catch (error) {
    console.error(t('train.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
