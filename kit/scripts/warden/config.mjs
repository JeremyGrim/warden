// What the kit reads from the project. Nothing that describes the project is written in a script: the rules live in
// config/rules.json, the factory in config/factory.json, the disk budgets in config/disk.json. A missing section is
// not checked. What belongs to one workstation (a path, a tool) is set with `git config warden.<key>` and is never
// committed.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The kit lives in scripts/warden/ of the project: the root is two folders up.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FACTORY_DEFAULTS = {
  main_branch: 'main',
  remote: 'origin',
  work_dir: '.work',
  slot: { name: 'push-slot', log: null },
  verify: { rust: null, npm_advisories: null, steps: [], all: [] },
  train: { branch: 'warden-train', dock: 'train-ready', max_batch: 4, install: null, build: null, min_free_memory_gib: 8, memory_per_job_gib: 2 },
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
  };
}

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
