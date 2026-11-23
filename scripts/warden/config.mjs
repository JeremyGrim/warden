// What the kit reads from the project. Nothing that describes the project is written in a script: the rules live in
// config/rules.json, the factory in config/factory.json, the disk budgets in config/disk.json. A missing section is
// not checked. What belongs to one workstation (a path, a tool) is set with `git config warden.<key>` and is never
// committed.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The kit lives in scripts/warden/ of the project: the root is two folders up.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FACTORY_DEFAULTS = {
  main_branch: 'main',
  remote: 'origin',
  work_dir: '.work',
  slot: { name: 'push-slot', log: null },
  // `when_missing`: what a check asked for and not run does. `record`: the commit goes up marked "not run"; `block`:
  // it waits. Never counted as passed either way.
  verify: { rust: null, npm_advisories: null, steps: [], all: [], when_missing: 'record', transient_patterns: [] },
  train: {
    branch: 'warden-train', dock: 'train-ready', max_batch: 4, install: null, build: null, min_free_memory_gib: 8, memory_per_job_gib: 2,
    // A halted train tries again after `retry_minutes`; past `halt_notice_minutes`, `watch` says it once.
    retry_minutes: 10, halt_notice_minutes: 30,
    // The Cargo profiles whose binaries count as builds for the CPU priority (`target/<profile>/`).
    cargo_profiles: ['debug', 'release'],
  },
  history: { keep_days: 90 },
  // The version line the factory bumps within (`"0.4"`, a string), and the manifests when the usual ones are not
  // enough (`files`: `{ file, read }`). Null: the line is the current major.minor (version.mjs).
  version: null,
  // The factory's release: `build` (a command), `artifacts` (paths, `*` in the last segment), `sign` and
  // `check_signature` (optional commands; `{file}` is each artifact), `tree` (`worktree` by default, or `clone`: a fresh
  // clone outside the repository) and `keep` (the latest releases kept). Null: no release.
  release: null,
  // What the factory may commit itself, on its own branch taken with `--with`: everything else goes back to the author.
  fixes: ['version', 'lock', 'generated'],
};

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: unreadable JSON (${error.message})`);
  }
}

// The project's factory: each section completes the default one, key by key.
export function readFactory(root = ROOT) {
  const given = readJson(join(root, 'config', 'factory.json'), {});
  const D = FACTORY_DEFAULTS;
  return {
    ...D,
    ...given,
    slot: { ...D.slot, ...given.slot },
    verify: { ...D.verify, ...given.verify },
    train: { ...D.train, ...given.train },
    history: { ...D.history, ...given.history },
  };
}

// Two paths name the same tree, whatever their separators and case.
export const sameTree = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

// A workstation setting, never committed: `git config warden.<key>`.
export function stationSetting(key, root = ROOT) {
  const out = spawnSync('git', ['config', '--get', `warden.${key}`], { cwd: root, encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout.trim() || null : null;
}

// A project command as the configuration gives it: an array, program first. `node` is the running Node. On Windows,
// pnpm, npm or npx are .cmd scripts: they go through the shell, with their arguments quoted.
export function stationCommand(command) {
  const [program, ...args] = command;
  if (program === 'node') return { program: process.execPath, args, shell: false };
  if (process.platform !== 'win32' || /^(git|cargo|rustc)(\.exe)?$/i.test(program)) return { program, args, shell: false };
  const quote = (word) => (/^[\w@%+=:,./\\-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`);
  return { program: [program, ...args].map(quote).join(' '), args: [], shell: true };
}

// A step launched from a test runner does not inherit its context: a `node --test` that receives it skips every file
// and reports success.
export function run(command, options = {}) {
  const { program, args, shell } = stationCommand(command);
  const { NODE_TEST_CONTEXT, ...env } = options.env ?? process.env;
  void NODE_TEST_CONTEXT;
  return spawnSync(program, args, { windowsHide: true, shell, ...options, env });
}

// A command run to its end, its output printed live, kept, and written to `log` when given: the class of a failure is
// read from it. Returns `{ status, signal, missing, text }`; `missing` when the program could not start at all.
export function runCaptured(command, { cwd = ROOT, log = null, input = null, env = process.env, quiet = false } = {}) {
  const { program, args, shell } = stationCommand(command);
  const { NODE_TEST_CONTEXT, ...childEnv } = env;
  void NODE_TEST_CONTEXT;
  return new Promise((done) => {
    let text = '';
    const child = spawn(program, args, { cwd, env: childEnv, shell, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const keep = (stream) => (chunk) => {
      if (!quiet) stream.write(chunk);
      if (log) appendFileSync(log, chunk);
      if (text.length < 1 << 23) text += chunk.toString('utf8');
    };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));
    if (input !== null) child.stdin.end(input);
    child.on('error', (error) => done({ status: null, signal: null, missing: error.code === 'ENOENT', text: `${text}\n${error.message}` }));
    child.on('close', (status, signal) => done({ status, signal, missing: false, text }));
  });
}
