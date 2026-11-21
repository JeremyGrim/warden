#!/usr/bin/env node
// A change of the project configuration, the way every change goes: checked against its shape (schema.mjs), committed
// under the hooks on a branch of its own, and deposited at the dock for the train. It works in a tree of its own, from
// the remote main branch: no tree changes branch, the root included, and nothing is pushed.
//
//   node scripts/warden/change.mjs check   <file> [--from <path>] [--json]
//   node scripts/warden/change.mjs deposit <file> [--from <path>] [--message <text>]
//
// <file> is config/factory.json, config/rules.json or config/disk.json. The new text is read from --from, else from the
// standard input. The deposit is named after the file (`config-factory.txt`): a refused change is replaced by depositing
// again; a change still waiting for the train is never overwritten.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory, ROOT } from './config.mjs';
import { dockFolder, isRefused, readDock } from './dock.mjs';
import { t } from './messages.mjs';
import { checkConfig, CONFIG_FILES } from './schema.mjs';
import { stationSlot } from './verify.mjs';

const TEXT_MAX = 256 * 1024;

function git(args, cwd = ROOT) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim(), error: `${out.stderr ?? ''}${out.stdout ?? ''}`.trim() };
}

const value = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);

// The new text of the file, as given; it always ends with one line break.
export function readText(argv, stdin = () => readFileSync(0, 'utf8')) {
  const from = value(argv, '--from');
  const text = from ? readFileSync(resolve(from), 'utf8') : stdin();
  if (text.length > TEXT_MAX) throw new Error(t('change.too_big'));
  return `${text.replace(/\s+$/, '')}\n`;
}

export function fileName(file) {
  const normal = String(file ?? '').replaceAll('\\', '/');
  if (!CONFIG_FILES[normal]) throw new Error(t('change.bad_file', { file, files: Object.keys(CONFIG_FILES).join(', ') }));
  return normal;
}

const say = (problem) => `  ${problem.level === 'error' ? '✗' : '!'} ${problem.path}: ${problem.expected}`;

function check(argv) {
  const file = fileName(argv[0]);
  const problems = checkConfig(CONFIG_FILES[file], readText(argv));
  const errors = problems.filter((p) => p.level === 'error').length;
  if (argv.includes('--json')) console.log(JSON.stringify({ file, errors, problems }, null, 2));
  else {
    for (const problem of problems) console.log(say(problem));
    console.log(errors ? t('change.check_failed', { file, count: errors }) : t('change.check_ok', { file, warnings: problems.length }));
  }
  return errors === 0;
}

const pad = (n) => String(n).padStart(2, '0');
const docked = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

function deposit(argv, factory) {
  const file = fileName(argv[0]);
  const name = CONFIG_FILES[file];
  const message = value(argv, '--message')?.trim() || `Config: ${file}`;
  if (/[\r\n]/.test(message) || message.length > 200) throw new Error(t('change.bad_message'));
  const text = readText(argv);
  const problems = checkConfig(name, text);
  const errors = problems.filter((p) => p.level === 'error');
  for (const problem of problems) console.log(say(problem));
  if (errors.length) throw new Error(t('change.check_failed', { file, count: errors.length }));
  // The hooks check the commit: without them, nothing would.
  if (git(['config', '--get', 'core.hooksPath']).out !== '.githooks') throw new Error(t('change.hooks_off'));
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  const depositName = `config-${name}.txt`;
  const waiting = readDock(dock).find((d) => d.name === depositName && !isRefused(d));
  if (waiting) throw new Error(t('change.waiting', { deposit: depositName, branch: waiting.branch }));
  const { remote, main_branch: main } = factory;
  const fetched = git(['fetch', '--quiet', remote, main]);
  if (!fetched.ok) throw new Error(`git fetch: ${fetched.error}`);
  const before = git(['show', `${remote}/${main}:${file}`]);
  if (before.ok && `${before.out.replace(/\s+$/, '')}\n` === text) throw new Error(t('change.same', { file, main: `${remote}/${main}` }));
  const now = new Date();
  const tree = join(dirname(slot), 'change-tree');
  const branch = `warden/config-${name}-${stamp(now)}`;
  if (existsSync(tree)) git(['worktree', 'remove', '--force', tree]);
  rmSync(tree, { recursive: true, force: true });
  git(['worktree', 'prune']);
  const added = git(['worktree', 'add', '--quiet', '-b', branch, tree, `${remote}/${main}`]);
  if (!added.ok) throw new Error(`git worktree add: ${added.error}`);
  let commit;
  try {
    mkdirSync(join(tree, 'config'), { recursive: true });
    writeFileSync(join(tree, ...file.split('/')), text);
    for (const args of [['add', '--', file], ['commit', '--quiet', '-m', message]]) {
      const r = git(args, tree);
      if (!r.ok) throw new Error(t('change.commit_failed', { step: `git ${args[0]}`, error: r.error }));
    }
    commit = git(['rev-parse', 'HEAD'], tree).out;
  } catch (error) {
    git(['worktree', 'remove', '--force', tree]);
    git(['branch', '-D', branch]);
    throw error;
  }
  // The tree goes; its branch stays in this repository, where the train takes it.
  git(['worktree', 'remove', '--force', tree]);
  mkdirSync(dock, { recursive: true });
  const lines = [
    '# A change of the project configuration, written by change.mjs on the person\'s gesture.',
    `tree = ${tree}`,
    `branch = ${branch}`,
    `commit = ${commit}`,
    `docked = ${docked(now)}`,
  ];
  writeFileSync(join(dock, depositName), `${lines.join('\n')}\n`);
  console.log(t('change.deposited', { file, branch, commit: commit.slice(0, 7), deposit: depositName }));
  return true;
}

async function main([command, ...rest]) {
  if (command === 'check') return check(rest);
  if (command === 'deposit') return deposit(rest, readFactory());
  console.error(t('change.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ? 0 : 1;
  } catch (error) {
    console.error(t('change.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
