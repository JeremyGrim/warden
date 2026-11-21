#!/usr/bin/env node
// The script guards of a push and of a train trial: the project's own script tests and the kit fingerprint, always;
// the kit's own tests only when they can give another answer. They prove the kit, not the project, and cost about 20 s
// a push (21 November). They run again when a kit file, Node, Git or the platform changes; otherwise the last run that
// passed on exactly these stands, and the output says so. `--all` runs them whatever.
//
//   node scripts/warden/guards.mjs [--all] [node --test options]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory, ROOT } from './config.mjs';
import { appendHistory, historyPath } from './history.mjs';
import { folderFingerprints } from './kit.mjs';
import { t } from './messages.mjs';
import { stationSlot } from './verify.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));
const KIT_PREFIX = 'scripts/warden/';
const FINGERPRINT = `${KIT_PREFIX}kit.test.mjs`;

// The script tests of the tree: every `*.test.mjs` under scripts/, out of dependencies and hidden folders.
export function testFiles(root) {
  const found = [];
  const walk = (folder) => {
    for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.mjs')) found.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  walk(join(root, 'scripts'));
  return found.sort();
}

// What runs: the project's tests and the fingerprint always; the kit's own tests unless they already passed on these
// very inputs.
export function selection(files, kitPassed) {
  const project = files.filter((f) => !f.startsWith(KIT_PREFIX));
  const kit = files.filter((f) => f.startsWith(KIT_PREFIX));
  return kitPassed ? [...kit.filter((f) => f === FINGERPRINT), ...project] : [...kit, ...project];
}

// What the kit's tests depend on: its files, Node, Git and the platform.
export function guardKey({ files, node, git, platform }) {
  return createHash('sha256').update(JSON.stringify({ files, node, git, platform })).digest('hex');
}

// The keys that passed, in the Git folder shared by every tree of the clone: a tree benefits from another's run.
const witness = () => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  return common ? join(common, 'warden-guards-passed') : null;
};
const passedKeys = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : []);

function main(argv) {
  const begin = Date.now();
  const options = argv.filter((a) => a !== '--all');
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
  const key = guardKey({ files: folderFingerprints(KIT), node: process.version, git, platform: `${process.platform}-${process.arch}` });
  const file = witness();
  const kitPassed = !argv.includes('--all') && passedKeys(file).includes(key);
  const files = testFiles(ROOT);
  const chosen = selection(files, kitPassed);
  const kitTests = files.some((f) => f.startsWith(KIT_PREFIX) && f !== FINGERPRINT);
  if (kitPassed && kitTests) console.log(t('guards.kit_cached'));
  if (!chosen.length) {
    console.log(t('guards.none'));
    return 0;
  }
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  void NODE_TEST_CONTEXT;
  const out = spawnSync(process.execPath, ['--test', ...options, ...chosen], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  const ok = out.status === 0;
  if (ok && !kitPassed && kitTests && file) writeFileSync(file, `${[...passedKeys(file).slice(-7), key].join('\n')}\n`);
  const factory = readFactory();
  appendHistory(historyPath(stationSlot(factory)), { kind: 'guards', tree: ROOT, kit: !kitTests ? 'none' : kitPassed ? 'cached' : 'ran', ok, seconds: (Date.now() - begin) / 1000 }, { keepDays: factory.history.keep_days });
  return out.status ?? 1;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) process.exitCode = main(process.argv.slice(2));
