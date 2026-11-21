#!/usr/bin/env node
// The train to the main branch: the factory, the only tree that pushes there, brings ready branches in by batches.
//
//   node scripts/warden/train.mjs run --agent <name> [--with <local branch>] [--batch N]   takes the slot and runs one batch
//   node scripts/warden/train.mjs run --dry-run                                           stacks and says what would go up, verifying and pushing nothing
//   node scripts/warden/train.mjs watch                                                   returns as soon as a train is worth leaving
//   node scripts/warden/train.mjs recover                                                 puts the tree back after an interrupted train
//
// A ready branch is docked in the dock folder (dock.mjs). The driver takes at most `train.max_batch` branches, stacks
// them on the main branch, sets aside a branch that conflicts with the main branch without resolving it in place of its
// author, then verifies and builds once for the batch, and pushes. When the trial fails, it looks for the culprit by
// halves, takes it out and pushes the rest. Every failure gets a class (outcome.mjs): an incident of the workstation is
// replayed once; when the main branch alone fails, when an incident persists there, or when a check cannot run, the
// train halts and blames nobody (`_halt.json`), then leaves again by itself once the cause can have changed.
// Exit code: 0 done, 1 stopped by an error, 75 halted. Each train writes its log in `train-logs/`, next to the dock, and
// one line in the history (history.mjs).

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FACTORY_DEFAULTS, readFactory, ROOT, run, runCaptured, stationSetting } from './config.mjs';
import { freeMemory, stationProcesses } from './disk.mjs';
import { clearHalt, clearRefusal, dockFolder, dockKey, haltHolds, readDock, readHalt, readyDeposits, whileHalted, writeHalt, writeRefusal } from './dock.mjs';
import { appendHistory, historyPath } from './history.mjs';
import { t } from './messages.mjs';
import { EXIT_HALTED, EXIT_INCOMPLETE, failureClass, firstError, refusal, transientCause } from './outcome.mjs';
import { adjust, projectTrees, restorePriorities, stationTrees } from './priority.mjs';
import { release, take } from './slot.mjs';
import { keepSlot, markVerified, slotLog, stationSlot } from './verify.mjs';

// A batch of thirteen that fails costs up to four extra verifications; a batch of four, two (11 November 2026).
export const MAX_BATCH = FACTORY_DEFAULTS.train.max_batch;
const GIB = 1024 ** 3;

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

// The train's build jobs: every core, bounded by the memory free to commit. A build that runs out of it fails
// (os error 1455, 19 November). Unknown memory: every core.
export function jobsFor(free, cores, perJobGib) {
  if (free === null || !perJobGib) return cores;
  return Math.max(1, Math.min(cores, Math.floor(free / (perJobGib * GIB))));
}

// The class of a halt from the failure that caused it: a red check on the main branch alone is `baseline`.
export const haltClass = (cls) => (cls === 'violation' || cls === 'defect' ? 'baseline' : cls);

// A train that halts blames nobody: the cause is the workstation or the main branch, and it waits for that to change.
class Halt extends Error {
  constructor(cls, result, reason = null) {
    super(result.cause);
    this.halt = { class: cls, reason, step: result.step ?? null, cause: result.cause, first_error: result.error ?? null };
  }
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

const clockTime = () => new Date().toTimeString().slice(0, 5);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const fileList = (files) => (files.length ? `: ${files.slice(0, 4).join(', ')}` : '');
const sameTree = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// Where the train left from, and its process, in the Git folder of this tree while it runs: what a recovery needs.
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

// After an interrupted train (a killed process, a workstation out of memory, a power cut): the tree goes back where the
// train left from, a cherry-pick in progress is aborted, the train references are removed, and the slot held by this
// tree is given back. It is the factory's own tree, never product code.
function recoverTree(factory, previous) {
  const aborted = git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).ok;
  if (aborted) git(['cherry-pick', '--abort']);
  const target = previous?.start ?? `${factory.remote}/${factory.main_branch}`;
  must(['checkout', '--quiet', '-f', ...(previous?.start ? [] : ['--detach']), target]);
  const refs = git(['for-each-ref', '--format=%(refname)', 'refs/warden-train/']).out.split('\n').filter(Boolean);
  for (const ref of refs) git(['update-ref', '-d', ref]);
  rmSync(startRecord(), { force: true });
  const slot = stationSlot(factory);
  if (slot) release(slot, ROOT);
  return { target, refs: refs.length, aborted };
}

async function runTrain(argv, factory) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const agent = value('--agent') ?? 'train';
  const dryRun = argv.includes('--dry-run');
  const { main_branch: main, remote, train } = factory;
  const tracking = `${remote}/${main}`;
  const patterns = factory.verify.transient_patterns ?? [];
  checkFactoryTree();
  const max = Number(value('--batch') ?? train.max_batch);
  if (!Number.isInteger(max) || max < 1) throw new Error(t('train.batch_arg'));
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  // An interrupted train leaves its tree on the train branch, sometimes mid cherry-pick. When its process is gone, the
  // tree is recovered first: it is the factory's own, and nobody needs to be asked.
  const previous = readStart(startRecord());
  if (previous && alive(previous.pid)) throw new Error(t('train.still_running', { pid: previous.pid }));
  if (previous) console.log(t('train.recovered_auto', { start: recoverTree(factory, previous).target }));
  if (git(['status', '--porcelain', '--untracked-files=no']).out) throw new Error(t('train.dirty'));
  const head = must(['rev-parse', '--abbrev-ref', 'HEAD']);
  // A detached factory tree comes back to the very commit it left from.
  const start = head === 'HEAD' ? must(['rev-parse', 'HEAD']) : head;

  const trainStamp = stamp();
  let log = null;
  if (!dryRun) {
    mkdirSync(join(dirname(slot), 'train-logs'), { recursive: true });
    log = join(dirname(slot), 'train-logs', `${trainStamp}.log`);
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
      if (!local.ok) return { class: 'violation', cause: t('train.branch_missing', { error: t('train.tree_absent', { tree: deposit.tree }) }) };
      must(['update-ref', ref, local.out]);
      say(t('train.tree_gone', { branch: deposit.branch, tree: deposit.tree }));
    } else {
      const fetched = git(['fetch', '--quiet', deposit.tree, `+${deposit.branch}:${ref}`]);
      if (!fetched.ok) return { class: 'violation', cause: t('train.branch_missing', { error: fetched.error.split('\n')[0] }) };
    }
    const tipOfBranch = must(['rev-parse', ref]);
    let tip = tipOfBranch;
    if (deposit.commit) {
      const named = git(['rev-parse', '--verify', '--quiet', `${deposit.commit}^{commit}`]);
      if (!named.ok || !git(['merge-base', '--is-ancestor', named.out, tipOfBranch]).ok) return { class: 'violation', cause: t('train.commit_gone', { commit: deposit.commit }) };
      tip = named.out;
      if (tip !== tipOfBranch) say(t('train.branch_moved', { branch: deposit.branch, commit: tip.slice(0, 7) }));
    } else if (!deposit.own) {
      say(t('train.no_commit', { branch: deposit.branch, commit: tipOfBranch.slice(0, 7) }));
    }
    const base = git(['merge-base', tracking, tip]);
    const list = base.ok ? git(['rev-list', '--reverse', '--no-merges', `${base.out}..${tip}`]) : base;
    if (!list.ok) return { class: 'conflict', cause: t('train.no_common_base', { branch: main }) };
    return { tip, commits: list.out.split('\n').filter(Boolean) };
  };

  const got = await take({ folder: slot, tree: ROOT, commit: 'train', sleep, say, log: slotLog(slot, factory) });
  if (!got.taken) throw new Error(got.reason);
  writeFileSync(startRecord(), `${start}\n${process.pid}\n`);
  say(t('train.slot_taken'));
  keepSlot(slot);
  const tool = stationSetting('tasks');
  const note = (task, text) => tool && run(noteCommand(tool, agent, task, text), { encoding: 'utf8' });
  const begin = Date.now();
  const stats = { steps: {}, trials: 0 };
  const notRun = new Set();
  let pushed = false;
  let mainSha = null;
  let readyList = [];
  let halted = null;
  let batch = [];
  let up = [];
  const refused = [];
  const pending = [];

  // The deposits set aside: a refusal the author reads without interpreting (dock.mjs), the `refused` line, the note.
  const setAside = () => {
    for (const { deposit, result } of refused) {
      const record = refusal({ cls: result.class, step: result.step ?? null, text: result.text ?? '', error: result.error ?? null, files: result.files ?? null, log, commit: deposit.tip ?? deposit.commit, base: mainSha, train: trainStamp });
      if (!deposit.own) writeRefusal(dock, deposit.name, record, `${result.cause} (${t('train.of_time', { time: clockTime() })})`);
      for (const task of deposit.tasks) note(task, t('train.note_refused', { time: clockTime(), branch: deposit.branch, cause: result.cause, next: record.next }));
      say(t('train.set_aside', { branch: deposit.branch, cause: result.cause }));
    }
  };

  try {
    if (!dryRun) {
      // The memory left to commit decides whether the train leaves, and bounds its jobs (19 November). Nothing is ever
      // stopped to free memory: the train waits for it.
      const free = freeMemory();
      const gib = free === null ? '?' : (free / GIB).toFixed(1);
      if (free !== null && free < train.min_free_memory_gib * GIB) throw new Halt('transient', { cause: t('train.cause_memory', { free: gib, min: train.min_free_memory_gib }) }, 'memory');
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
    mainSha = must(['rev-parse', tracking]);
    const halt = readHalt(dock);
    const deposits = readyDeposits(readDock(dock));
    readyList = [...deposits];
    const readyKey = dockKey(deposits);
    if (!deposits.length && halt && !dryRun) clearHalt(dock);
    // A red main branch that has not moved, and a dock that has not changed: the same trial would fail the same way.
    if (!dryRun && haltHolds(halt, { main: mainSha, dock: readyKey })) {
      say(t('train.halt_holds', { branch: main, commit: mainSha.slice(0, 7), log: halt.log }));
      return EXIT_HALTED;
    }
    const withBranch = value('--with');
    if (withBranch) deposits.push({ name: `${agent}.txt`, tree: ROOT, branch: withBranch, commit: null, tasks: [], scenarios: [], priority: null, refused: null, moment: Date.now(), own: true });
    if (!deposits.length) {
      say(t('train.nothing'));
      return true;
    }

    const candidates = [];
    for (const deposit of deposits) {
      const found = locate(deposit);
      if (found.cause) refused.push({ deposit, result: { ...found, step: t('train.step.dock') } });
      else candidates.push({ ...deposit, ...found });
    }
    // Conflicts show without verifying: stack in order until the batch is full. A branch that conflicts with the main
    // branch alone is set aside; one that only conflicts with another branch of the batch waits, since that one may go
    // out (21 November).
    restart();
    let conflicts;
    ({ batch, conflicts } = chooseBatch(candidates, stackFiles, max));
    for (const { deposit } of conflicts) {
      restart();
      const files = stackFiles(deposit);
      if (files) refused.push({ deposit, result: { class: 'conflict', files, cause: t('train.conflict', { branch: main, files: fileList(files) }) } });
      else pending.push(deposit);
    }
    const waiting = candidates.length - batch.length - conflicts.length + pending.length;
    say(t('train.summary', { branches: batch.map((d) => `${d.branch} (${d.commits.length})`).join(', ') || t('train.none'), refused: refused.length, waiting }));

    if (dryRun) {
      for (const { deposit, result } of refused) say(t('train.set_aside', { branch: deposit.branch, cause: result.cause }));
      for (const deposit of pending) say(t('train.conflict_waits', { branch: deposit.branch }));
      say(t('train.dry_run', { count: batch.length, base: mainSha.slice(0, 7) }));
      return true;
    }

    // Each step prints live, goes to the log, and names its class and cause when it fails. An incident of the
    // workstation is replayed once; the verification replays its own steps, and reports them in WARDEN_REPORT.
    const step = async (title, command, { input = null, kind = 'check' } = {}) => {
      say(`\n▶ ${title}`);
      const began = Date.now();
      const report = kind === 'verify' ? join(tmpdir(), `warden-report-${process.pid}-${Date.now()}.jsonl`) : null;
      const env = report ? { ...process.env, WARDEN_REPORT: report } : process.env;
      let out = await runCaptured(command, { log, input, env });
      const incident = kind !== 'verify' && out.status !== 0 ? transientCause(out, patterns) : null;
      if (incident) {
        say(t('train.incident_retry', { title, incident }));
        out = await runCaptured(command, { log, input, env });
      }
      let records = [];
      try {
        records = report ? readFileSync(report, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
      } catch {
        // No report: the verification stopped before its first step.
      }
      if (report) rmSync(report, { force: true });
      const seconds = (Date.now() - began) / 1000;
      stats.steps[title] = (stats.steps[title] ?? 0) + seconds;
      const missing = records.filter((r) => r.kind === 'not_run').map((r) => r.title);
      const recorded = out.status === EXIT_INCOMPLETE && factory.verify.when_missing !== 'block';
      if (out.status === 0 || recorded) {
        say(`✔ ${title} (${Math.round(seconds)} s)${incident ? ` — ${t('train.after_incident')}` : ''}`);
        for (const title2 of missing) say(t('train.not_run', { title: title2 }));
        return { ok: true, notRun: missing };
      }
      const cls = out.status === EXIT_INCOMPLETE ? 'incomplete'
        : kind === 'verify' ? (records.findLast((r) => r.kind === 'step' && !r.ok)?.class ?? failureClass('check', out, patterns))
          : failureClass(kind, out, patterns);
      say(t('train.step_failed', { title, cls }));
      const error = cls === 'incomplete' && missing.length ? missing.join(', ') : firstError(out.text);
      return { ok: false, class: cls, step: title, text: out.text, error, cause: t('train.cause_step', { step: title, detail: error, log }) };
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
    // The trial, always in this order: the advisories when the main branch fails them; the batch dependencies before any
    // guard (a branch that adds some is verified with them, 12 November, 10:27); the rules and the script guards, in
    // seconds (two branches green each can exceed a ceiling together, 11 November, 01:18); the verification of the
    // changed files; the build, once.
    let advisoriesRed = false;
    const advisories = () => step(t('train.step.advisories'), ['node', 'scripts/warden/verify.mjs', 'advisories'], { kind: 'verify' });
    const checks = async (changed) => {
      const steps = [
        ...(advisoriesRed ? [advisories] : []),
        install,
        () => step(t('train.step.rules'), ['node', 'scripts/warden/rules.mjs'], { kind: 'rules' }),
        () => step(t('train.step.guards'), ['node', 'scripts/warden/guards.mjs', '--test-reporter=dot']),
        () => step(t('train.step.verify'), ['node', 'scripts/warden/verify.mjs', 'files'], { input: changed.join('\n'), kind: 'verify' }),
        () => (train.build ? step(train.build.title ?? t('train.step.build'), train.build.command) : { ok: true }),
      ];
      const missing = [];
      for (const next of steps) {
        const r = await next();
        if (!r.ok) return r;
        missing.push(...(r.notRun ?? []));
      }
      return { ok: true, notRun: missing };
    };
    const failures = [];
    let batchChanged = [];
    const attempt = async (list) => {
      const names = new Set(list.map((d) => d.name));
      const blocked = build(list);
      if (blocked.length) {
        failures.push({ names, result: { class: 'conflict', files: blocked[0].files, cause: t('train.conflict', { branch: main, files: fileList(blocked[0].files) }) } });
        return false;
      }
      const changed = git(['diff', '--name-only', tracking, 'HEAD']).out.split('\n').filter(Boolean);
      if (list.length === batch.length) batchChanged = changed;
      say(`\n${t('train.verifying', { branches: list.map((d) => d.branch).join(' + '), count: changed.length })}`);
      stats.trials += 1;
      const r = await checks(changed);
      if (r.ok) {
        r.notRun.forEach((n) => notRun.add(n));
        return true;
      }
      // A check that could not run says nothing of the branches: nobody is blamed, nothing goes up unverified.
      if (r.class === 'incomplete') throw new Halt('incomplete', r);
      // The incident outlived its replay: the main branch alone, on the same files, says whose it is. If it fails there
      // too, the train halts; if it passes, the branches brought it (one that exhausts the memory by itself).
      if (r.class === 'transient') {
        restart();
        say(`\n${t('train.verifying_incident', { branch: main, count: changed.length })}`);
        const alone = await checks(changed);
        if (!alone.ok) throw new Halt(haltClass(alone.class), alone);
        r.class = 'defect';
      }
      failures.push({ names, result: r });
      return false;
    };

    if (batch.length) {
      // The world moves without any branch: a new advisory turns the main branch red (19 November). The advisories run
      // on the main branch alone first; when they fail there, each trial checks them first, so that only a batch that
      // repairs them goes up and no branch is blamed for them.
      restart();
      const world = await advisories();
      if (!world.ok && (world.class === 'transient' || world.class === 'incomplete')) throw new Halt(world.class, world);
      if (!world.ok) {
        advisoriesRed = true;
        say(t('train.advisories_red', { branch: main, cause: world.cause }));
      }
      (world.notRun ?? []).forEach((n) => notRun.add(n));
      let out;
      ({ up, out } = await sortOut(batch, attempt));
      // Every branch failed: the main branch alone, with the same verification of what the batch changes. When it fails
      // too, the fault is not in the branches: a red main branch, a workstation that changed (an advisory, a browser
      // without a window, 19 and 20 November). The train halts and refuses nobody.
      if (!up.length && out.length) {
        restart();
        say(`\n${t('train.verifying_main', { branch: main, count: batchChanged.length })}`);
        const alone = await checks(batchChanged);
        if (!alone.ok) throw new Halt(haltClass(alone.class), alone);
      }
      for (const deposit of out) refused.push({ deposit, result: failures.findLast((f) => f.names.has(deposit.name))?.result ?? { class: 'defect', cause: t('train.cause_unknown', { log }) } });
    }

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
      if (notRun.size) say(t('train.pushed_not_run', { steps: [...notRun].join(', ') }));
      // A deposit that went up is kept with what was taken and where: the dock keeps its history (21 November).
      const taken = join(dock, 'taken');
      mkdirSync(taken, { recursive: true });
      const except = notRun.size ? t('train.note_not_run', { steps: [...notRun].join(', ') }) : '';
      for (const deposit of up) {
        if (!deposit.own) {
          const file = join(dock, deposit.name);
          appendFileSync(file, `\ntaken = ${deposit.tip} in ${top} at ${new Date().toISOString()}\n`);
          renameSync(file, join(taken, `${stamp()}-${deposit.name}`));
          clearRefusal(dock, deposit.name);
        }
        const scenario = deposit.scenarios?.length ? t('train.note_scenario', { scenarios: deposit.scenarios.join(', ') }) : t('train.note_no_scenario');
        for (const task of deposit.tasks) note(task, t('train.note_up', { branch: main, time: clockTime(), commit: short, source: deposit.branch, except, scenario }));
      }
      // The train tree keeps the last trial's build, which may not be what went up: a journey is played on a build of
      // the pushed commit, in a separate tree (21 November).
      const scenarios = [...new Set(up.flatMap((d) => d.scenarios ?? []))];
      if (scenarios.length) say(t('train.scenarios', { commit: short, scenarios: scenarios.join(', ') }));
    }
    // A branch that waited on a conflict: when the branch it conflicted with went up, it conflicts with the new main
    // branch and is set aside; otherwise it waits for the next train, with no refusal.
    for (const deposit of pending) {
      if (top) {
        restart(top);
        const files = stackFiles(deposit);
        if (files) {
          refused.push({ deposit, result: { class: 'conflict', files, cause: t('train.conflict', { branch: main, files: fileList(files) }) } });
          continue;
        }
      }
      say(t('train.conflict_waits', { branch: deposit.branch }));
    }
    setAside();
    clearHalt(dock);
    return true;
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    // Halted: the refusals found before any trial (a conflict with the main branch, an unreadable deposit) stand; no
    // trial refuses anyone. The halt says why, on which commit of the main branch, and for which dock.
    halted = error.halt.class;
    setAside();
    // The dock as the next train will read it: the deposits just set aside no longer count in it.
    const aside = new Set(refused.map(({ deposit }) => deposit.name));
    writeHalt(dock, { ...error.halt, main: mainSha, dock: dockKey(readyList.filter((d) => !aside.has(d.name))), log, at: new Date().toISOString(), noticed: false });
    say(t(`train.halt.${halted}`, { branch: main, cause: error.halt.cause }));
    return EXIT_HALTED;
  } finally {
    if (!dryRun && (batch.length || refused.length || halted)) {
      appendHistory(historyPath(slot), {
        kind: 'train', base: mainSha, batch: batch.map((d) => d.name), trials: stats.trials,
        steps: Object.fromEntries(Object.entries(stats.steps).map(([k, s]) => [k, Math.round(s * 10) / 10])),
        up: up.filter((d) => !d.own).map((d) => ({ name: d.name, branch: d.branch, commit: d.tip, waited_s: Math.round((Date.now() - d.moment) / 1000) })),
        out: refused.map(({ deposit, result }) => ({ name: deposit.name, class: result.class })),
        waiting: pending.length, halted, not_run: [...notRun], seconds: (Date.now() - begin) / 1000,
      }, { keepDays: factory.history.keep_days });
    }
    if (git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).ok) git(['cherry-pick', '--abort']);
    git(['checkout', '--quiet', '-f', start]);
    try {
      unlinkSync(startRecord());
    } catch {
      // Already gone.
    }
    // After a successful push, the hook handed the slot to its detached process, which gives it back on arrival.
    if (!pushed) release(slot, ROOT);
  }
}

// The same recovery, asked for by hand. It refuses while a train still runs.
function recover(factory) {
  checkFactoryTree();
  const previous = readStart(startRecord());
  if (previous && alive(previous.pid)) throw new Error(t('train.still_running', { pid: previous.pid }));
  const { target, refs, aborted } = recoverTree(factory, previous);
  console.log(t('train.recovered', { start: target, refs, aborted: aborted ? t('train.recover_aborted') : '' }));
  return true;
}

// The main branch as the remote holds it, without fetching; null when the remote cannot be read.
function remoteMain({ remote, main_branch: main }) {
  const r = git(['ls-remote', remote, `refs/heads/${main}`]);
  return r.ok ? r.out.split(/\s/)[0] || null : null;
}

// Returns as soon as a train is worth leaving, costing nothing meanwhile: one look at the dock per minute. While the
// train is halted, it waits for what can lift the halt (dock.mjs, `whileHalted`); past the notice threshold it returns
// once with code 75, so that whoever can act hears it.
async function watch(factory) {
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  for (;;) {
    const ready = readyDeposits(readDock(dock));
    if (ready.length) {
      const halt = readHalt(dock);
      const free = halt?.reason === 'memory' ? freeMemory() : null;
      const verdict = whileHalted(halt, {
        main: halt?.class === 'baseline' ? (remoteMain(factory) ?? halt.main) : null,
        dock: dockKey(ready),
        freeGib: free === null ? null : free / GIB,
        train: factory.train,
      });
      if (verdict === 'go') {
        console.log(t('train.ready', { branches: ready.map((d) => d.branch).join(', ') }));
        return true;
      }
      if (verdict === 'notice') {
        writeHalt(dock, { ...halt, noticed: true });
        console.log(t('train.halt_notice', { minutes: Math.round((Date.now() - Date.parse(halt.at)) / 60000), cls: halt.class, cause: halt.cause }));
        return EXIT_HALTED;
      }
    }
    await sleep(60 * 1000);
  }
}

// While the train lives: one pass every 10 seconds. When it ends, the previous priorities come back.
async function keepPriority(pid) {
  const others = projectTrees(stationTrees(ROOT));
  const kept = new Map();
  while (alive(pid)) {
    const processes = stationProcesses();
    if (processes) adjust(processes, ROOT, kept, { others });
    await sleep(10 * 1000);
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
    const result = await main(process.argv.slice(2));
    process.exitCode = typeof result === 'number' ? result : result ? 0 : 1;
  } catch (error) {
    console.error(t('train.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
