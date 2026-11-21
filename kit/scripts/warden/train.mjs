#!/usr/bin/env node
// The train to the main branch: the factory, the only tree that pushes there, brings ready branches in by batches.
//
//   node scripts/warden/train.mjs run --agent <name> [--with <local branch>] [--batch N]   takes the slot and runs one batch
//   node scripts/warden/train.mjs run --dry-run                                           stacks and says what would go up, verifying and pushing nothing
//   node scripts/warden/train.mjs watch                                                   returns as soon as a branch is waiting
//
// A ready branch is docked in the dock folder next to the slot: a `<session>.txt` file giving `tree`, `branch`,
// `tasks`, `docked`, and `scenario` when the change shows on screen. The driver takes at most `train.max_batch`
// branches in docking order, stacks them on the main branch, sets aside a conflicting branch without resolving it in
// place of its author, then verifies and builds once for the batch, and pushes. When the trial fails, it looks for the
// culprit by halves, takes it out and pushes the rest. Branches beyond the batch wait for the next train: a short batch
// bounds the search by halves to two extra trials. Install and build commands are in config/factory.json, `train`.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FACTORY_DEFAULTS, readFactory, ROOT, run, stationSetting } from './config.mjs';
import { stationProcesses } from './disk.mjs';
import { t } from './messages.mjs';
import { adjust, projectTrees, restorePriorities } from './priority.mjs';
import { release, take } from './slot.mjs';
import { keepSlot, markVerified, slotLog, stationSlot, verifyFiles } from './verify.mjs';

// A batch of thirteen that fails costs up to four extra verifications; a batch of four, two (11 November 2026).
export const MAX_BATCH = FACTORY_DEFAULTS.train.max_batch;

// A deposit: `key = value` lines. The docking moment `dd/mm hh:mm` (current year), otherwise the file date.
export function readDeposit(name, text, fileDate = 0, year = new Date().getFullYear()) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const found = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (found) fields[found[1].toLowerCase()] = found[2];
  }
  const when = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(fields.docked ?? '');
  const moment = when ? new Date(year, Number(when[2]) - 1, Number(when[1]), Number(when[3]), Number(when[4])).getTime() : fileDate;
  return {
    name,
    tree: fields.tree,
    branch: fields.branch,
    tasks: (fields.tasks ?? '').split(/[,\s]+/).filter(Boolean),
    scenarios: (fields.scenario ?? '').split(/[,\s]+/).filter(Boolean),
    refused: fields.refused ?? null,
    moment,
  };
}

// The deposits that leave: complete, with no pending refusal, in arrival order.
export function readyDeposits(deposits) {
  return deposits.filter((d) => d.tree && d.branch && !d.refused).sort((a, b) => a.moment - b.moment || a.name.localeCompare(b.name));
}

// The dock as it is: every deposit, ready ones first, then the refused.
export function readDock(dock) {
  const files = existsSync(dock) ? readdirSync(dock).filter((f) => f.endsWith('.txt')) : [];
  return files.map((f) => readDeposit(f, readFileSync(join(dock, f), 'utf8'), statSync(join(dock, f)).mtimeMs));
}

// This train's batch: the candidates in order, each stacked on the previous ones (`stack(deposit)` says whether it
// stacks). A conflicting candidate goes out; the batch fills up with the next ones up to `max`. The rest waits.
export function chooseBatch(candidates, stack, max = MAX_BATCH) {
  const batch = [];
  const conflicts = [];
  for (const deposit of candidates) {
    if (batch.length >= max) break;
    const cause = stack(deposit);
    if (cause) conflicts.push({ deposit, cause });
    else batch.push(deposit);
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
const mainRoot = () => dirname(must(['rev-parse', '--path-format=absolute', '--git-common-dir']));
export const dockFolder = (slot, factory) => join(dirname(slot), factory.train.dock);

async function runTrain(argv, factory) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const agent = value('--agent') ?? 'train';
  const { main_branch: main, remote, train } = factory;
  const tracking = `${remote}/${main}`;
  // One factory at a time: once a factory tree is declared for the workstation, the train runs only there.
  const factoryTree = stationSetting('factory');
  if (factoryTree && resolve(factoryTree).toLowerCase() !== resolve(ROOT).toLowerCase()) throw new Error(t('train.not_factory', { tree: factoryTree }));
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  if (git(['status', '--porcelain', '--untracked-files=no']).out) throw new Error(t('train.dirty'));
  const start = must(['rev-parse', '--abbrev-ref', 'HEAD']);

  // A batch branch, stacked on the train as it is. Returns the cause of a conflict, or null.
  const stack = (deposit) => {
    if (!deposit.commits.length) return null;
    const cherry = git(['cherry', 'HEAD', deposit.commits.at(-1)]);
    const commits = cherry.ok ? notYetTaken(deposit.commits, cherry.out) : deposit.commits;
    if (!commits.length) return null;
    const picked = git(['cherry-pick', '--empty=drop', '--allow-empty', ...commits]);
    if (picked.ok) return null;
    const files = git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    git(['cherry-pick', '--abort']);
    return t('train.conflict', { branch: main, files: files.length ? `: ${files.slice(0, 4).join(', ')}` : '' });
  };
  // `-f`: a previous trial can leave a tracked file modified (a tool rewriting a lockfile during the trial, 20 November,
  // 02:25). Each trial starts again from the main branch, clean.
  const restart = () => must(['checkout', '--quiet', '-f', '-B', train.branch, tracking]);
  const build = (deposits) => {
    restart();
    return deposits.map((deposit) => ({ deposit, cause: stack(deposit) })).filter((c) => c.cause);
  };

  const got = await take({ folder: slot, tree: ROOT, commit: 'train', sleep: (ms) => new Promise((f) => setTimeout(f, ms)), say: (x) => console.log(x), log: slotLog(slot, factory) });
  if (!got.taken) throw new Error(got.reason);
  console.log(t('train.slot_taken'));
  keepSlot(slot);
  // The factory keeps the whole machine for its builds, and the CPU priority is its own while it runs.
  if (!process.env.CARGO_BUILD_JOBS) process.env.CARGO_BUILD_JOBS = String(availableParallelism());
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'priority', String(process.pid)], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const tool = stationSetting('tasks');
  const note = (task, text) => tool && run(noteCommand(tool, agent, task, text), { encoding: 'utf8' });
  let pushed = false;
  let installedLock = null;
  try {
    must(['fetch', '--quiet', remote, main]);
    const deposits = readyDeposits(readDock(dock));
    const withBranch = value('--with');
    if (withBranch) deposits.push({ name: `${agent}.txt`, tree: ROOT, branch: withBranch, tasks: [], scenarios: [], refused: null, moment: Date.now(), own: true });
    const max = Number(value('--batch') ?? train.max_batch);
    if (!Number.isInteger(max) || max < 1) throw new Error(t('train.batch_arg'));
    if (!deposits.length) {
      console.log(t('train.nothing'));
      return true;
    }

    const refused = [];
    const candidates = [];
    for (const deposit of deposits) {
      const ref = `refs/warden-train/${deposit.name.replace(/[^\w.-]+/g, '-')}`;
      const fetched = git(['fetch', '--quiet', deposit.tree, `+${deposit.branch}:${ref}`]);
      if (!fetched.ok) {
        refused.push({ deposit, cause: t('train.branch_missing', { error: fetched.error.split('\n')[0] }) });
        continue;
      }
      const base = must(['merge-base', tracking, ref]);
      candidates.push({ ...deposit, commits: must(['rev-list', '--reverse', '--no-merges', `${base}..${ref}`]).split('\n').filter(Boolean) });
    }
    // Conflicts show without verifying: stack in order until the batch is full, and what does not stack goes out.
    restart();
    const { batch, conflicts } = chooseBatch(candidates, stack, max);
    refused.push(...conflicts);
    const waiting = candidates.length - batch.length - conflicts.length;
    console.log(t('train.summary', { branches: batch.map((d) => `${d.branch} (${d.commits.length})`).join(', ') || t('train.none'), refused: refused.length, waiting }));

    if (argv.includes('--dry-run')) {
      for (const { deposit, cause } of refused) console.log(t('train.set_aside', { branch: deposit.branch, cause }));
      console.log(t('train.dry_run', { count: batch.length, base: must(['rev-parse', '--short', tracking]) }));
      return true;
    }

    // The trial, always in this order: the batch dependencies before any guard (a branch that adds some is verified
    // with them, 12 November, 10:27); the rules and the script guards, in seconds (two branches green each can exceed a
    // ceiling together, 11 November, 01:18); the verification of the changed files; the build, once.
    const step = (title, command) => {
      console.log(`\n▶ ${title}`);
      const begin = Date.now();
      const ok = run(command, { cwd: ROOT, stdio: 'inherit' }).status === 0;
      console.log(ok ? `✔ ${title} (${Math.round((Date.now() - begin) / 1000)} s)` : t('train.step_failed', { title }));
      return ok;
    };
    const install = () => {
      if (!train.install) return true;
      const lock = git(['rev-parse', `HEAD:${train.install.lockfile}`]).out || 'none';
      if (lock === installedLock) return true;
      const ok = step(t('train.step.install'), train.install.command);
      installedLock = ok ? lock : null;
      return ok;
    };
    const attempt = (list) => {
      if (build(list).length) return false;
      const changed = git(['diff', '--name-only', tracking, 'HEAD']).out.split('\n').filter(Boolean);
      console.log(`\n${t('train.verifying', { branches: list.map((d) => d.branch).join(' + '), count: changed.length })}`);
      return install()
        && step(t('train.step.rules'), ['node', 'scripts/warden/rules.mjs'])
        && step(t('train.step.guards'), ['node', '--test', '--test-reporter=dot', 'scripts/**/*.test.mjs'])
        && verifyFiles(changed, factory)
        && (!train.build || step(train.build.title ?? t('train.step.build'), train.build.command));
    };
    const { up, out } = await sortOut(batch, attempt);
    for (const deposit of out) refused.push({ deposit, cause: t(train.build ? 'train.cause_verify_build' : 'train.cause_verify') });

    if (up.length) {
      build(up);
      const top = must(['rev-parse', 'HEAD']);
      markVerified(top);
      const sent = git(['push', remote, `${train.branch}:${main}`], { stdio: 'inherit' });
      if (!sent.ok) throw new Error(t('train.push_failed'));
      pushed = true;
      const short = top.slice(0, 7);
      console.log(t('train.pushed', { commit: short }));
      for (const deposit of up) {
        if (!deposit.own) unlinkSync(join(dock, deposit.name));
        const scenario = deposit.scenarios?.length ? t('train.note_scenario', { scenarios: deposit.scenarios.join(', ') }) : t('train.note_no_scenario');
        for (const task of deposit.tasks) note(task, t('train.note_up', { branch: main, time: clockTime(), commit: short, source: deposit.branch, scenario }));
      }
    }
    for (const { deposit, cause } of refused) {
      if (!deposit.own) appendFileSync(join(dock, deposit.name), `\nrefused = ${cause} (${t('train.of_time', { time: clockTime() })})\n`);
      for (const task of deposit.tasks) note(task, t('train.note_refused', { time: clockTime(), branch: deposit.branch, cause }));
      console.log(t('train.set_aside', { branch: deposit.branch, cause }));
    }
    return true;
  } finally {
    git(['checkout', '--quiet', '-f', start]);
    // After a successful push, the hook handed the slot to its detached process, which gives it back on arrival.
    if (!pushed) release(slot, ROOT);
  }
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
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  const others = projectTrees(mainRoot());
  const kept = new Map();
  while (alive()) {
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
