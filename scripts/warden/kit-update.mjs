#!/usr/bin/env node
// The kit installs itself in a project, the way every change goes: in a tree of its own made from the remote main
// branch, committed under the hooks on a branch of its own, and deposited at the dock for the train. No tree changes
// branch, the root included, and nothing is pushed. The kit it installs is the one this script belongs to: the newest of
// the workstation, which the interface runs from wherever it lies (another project, the plugin).
//
//   node <kit folder>/kit-update.mjs deposit [--project <path>]
//
// It refuses a kit of its own that differs from its manifest, a kit on the main branch that was edited (a project need
// is a configuration option, or a fix in Warden), a kit on the main branch that is not older, and a kit update still
// waiting for the train. It changes scripts/warden/ alone: a first install and the models go through `warden setup`.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory, readJson, ROOT } from './config.mjs';
import { dockFolder, isRefused, readDock } from './dock.mjs';
import { compareVersions, manifestGaps, MANIFEST } from './kit.mjs';
import { t } from './messages.mjs';
import { stationSlot } from './verify.mjs';

const SELF = dirname(fileURLToPath(import.meta.url));
export const DEPOSIT = 'kit.txt';

function git(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim(), error: `${out.stderr ?? ''}${out.stdout ?? ''}`.trim() };
}

const value = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
const pad = (n) => String(n).padStart(2, '0');
const docked = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
const gapList = (gaps) => [...gaps.changed, ...gaps.extra, ...gaps.missing].join(', ');
const files = (folder) => readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);

// The kit folder replaced by another: every file of the old one goes, every file of the new one comes.
export function replaceKit(folder, source) {
  for (const name of files(folder)) rmSync(join(folder, name), { force: true });
  mkdirSync(folder, { recursive: true });
  for (const name of files(source)) copyFileSync(join(source, name), join(folder, name));
}

export function deposit(argv, source = SELF) {
  const asked = resolve(value(argv, '--project') ?? ROOT);
  const top = git(['rev-parse', '--show-toplevel'], asked);
  if (!top.ok) throw new Error(t('kit_update.not_git', { path: asked }));
  const root = resolve(top.out);
  // The kit to install is exactly its manifest: a source edited on the workstation is never spread.
  const next = readJson(join(source, MANIFEST));
  const own = manifestGaps(source, next ?? {});
  if (!next?.version || gapList(own)) throw new Error(t('kit_update.source_edited', { folder: source, files: gapList(own) || MANIFEST }));
  // The hooks check the commit: without them, nothing would.
  if (git(['config', '--get', 'core.hooksPath'], root).out !== '.githooks') throw new Error(t('change.hooks_off'));
  const factory = readFactory(root);
  const slot = stationSlot(factory, root);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const dock = dockFolder(slot, factory);
  const waiting = readDock(dock).find((d) => d.name === DEPOSIT && !isRefused(d));
  if (waiting) throw new Error(t('kit_update.waiting', { deposit: DEPOSIT, branch: waiting.branch }));
  const { remote, main_branch: main } = factory;
  const tracking = `${remote}/${main}`;
  const fetched = git(['fetch', '--quiet', remote, main], root);
  if (!fetched.ok) throw new Error(`git fetch: ${fetched.error}`);
  const shown = git(['show', `${tracking}:scripts/warden/${MANIFEST}`], root);
  if (!shown.ok) throw new Error(t('kit_update.no_kit', { main: tracking }));
  const current = JSON.parse(shown.out);
  if (compareVersions(current.version, next.version) >= 0) throw new Error(t('kit_update.not_older', { main: tracking, current: current.version, version: next.version }));

  const now = new Date();
  const tree = join(dirname(slot), 'kit-tree');
  const branch = `warden/kit-${next.version}-${stamp(now)}`;
  if (existsSync(tree)) git(['worktree', 'remove', '--force', tree], root);
  rmSync(tree, { recursive: true, force: true });
  git(['worktree', 'prune'], root);
  const added = git(['worktree', 'add', '--quiet', '-b', branch, tree, tracking], root);
  if (!added.ok) throw new Error(`git worktree add: ${added.error}`);
  let commit;
  try {
    const folder = join(tree, 'scripts', 'warden');
    // The kit the main branch carries must be the one an earlier install wrote: an edit would be lost unseen.
    const gaps = manifestGaps(folder, current);
    if (gapList(gaps)) throw new Error(t('kit_update.edited', { main: tracking, files: gapList(gaps) }));
    replaceKit(folder, source);
    for (const args of [['add', '-A', '--', 'scripts/warden'], ['commit', '--quiet', '-m', `Warden kit ${next.version}, from ${current.version}`]]) {
      const r = git(args, tree);
      if (!r.ok) throw new Error(t('change.commit_failed', { step: `git ${args[0]}`, error: r.error }));
    }
    commit = git(['rev-parse', 'HEAD'], tree).out;
  } catch (error) {
    git(['worktree', 'remove', '--force', tree], root);
    git(['branch', '-D', branch], root);
    throw error;
  }
  // The tree goes; its branch stays in this repository, where the train takes it.
  git(['worktree', 'remove', '--force', tree], root);
  mkdirSync(dock, { recursive: true });
  const lines = [
    `# The kit ${next.version}, written by kit-update.mjs on the person's gesture.`,
    `tree = ${tree}`,
    `branch = ${branch}`,
    `commit = ${commit}`,
    `docked = ${docked(now)}`,
  ];
  writeFileSync(join(dock, DEPOSIT), `${lines.join('\n')}\n`);
  console.log(t('kit_update.deposited', { version: next.version, current: current.version, branch, commit: commit.slice(0, 7), deposit: DEPOSIT }));
  return true;
}

function main([command, ...rest]) {
  if (command === 'deposit') return deposit(rest);
  console.error(t('kit_update.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    process.exitCode = main(process.argv.slice(2)) ? 0 : 1;
  } catch (error) {
    console.error(t('kit_update.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
