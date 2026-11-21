#!/usr/bin/env node
// The factory's version bump. A project follows a version line (`0.4`): within it, the factory moves the patch number
// itself, in every manifest at once, on a branch of its own that the train takes with `--with`. Leaving the line is the
// person's decision, written in config/factory.json (`version.line`); without it, the line is the current
// major.minor. A version that is not major.minor.patch is never bumped by the kit.
//
//   node scripts/warden/version.mjs show [--json]
//   node scripts/warden/version.mjs bump [--to <x.y.z>]
//
// The manifests come from `version.files` in config/factory.json, else `versions` in config/rules.json, else the
// usual ones: package.json, Cargo.toml, .claude-plugin/plugin.json. A bumped Cargo.toml refreshes the workspace
// entries of Cargo.lock offline; a package-lock.json follows package.json.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readVersion } from './checks.mjs';
import { readFactory, readJson, ROOT, run, stationSetting } from './config.mjs';
import { t } from './messages.mjs';
import { stationSlot } from './verify.mjs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The manifests that carry the version, and how to read each.
export function manifests(root, factory, rules) {
  if (factory.version?.files?.length) return factory.version.files;
  if (rules?.versions?.length) return rules.versions;
  const found = [];
  const text = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);
  const pkg = text('package.json');
  if (pkg && readVersion(pkg, 'json:version')) found.push({ file: 'package.json', read: 'json:version' });
  const cargo = text('Cargo.toml');
  if (cargo && readVersion(cargo, 'toml:workspace.package.version')) found.push({ file: 'Cargo.toml', read: 'toml:workspace.package.version' });
  else if (cargo && readVersion(cargo, 'toml:package.version')) found.push({ file: 'Cargo.toml', read: 'toml:package.version' });
  const plugin = text('.claude-plugin/plugin.json');
  if (plugin && readVersion(plugin, 'json:version')) found.push({ file: '.claude-plugin/plugin.json', read: 'json:version' });
  return found;
}

// The next version within the line. Returns `{ next }` or `{ refused, vars }` with a message key.
export function nextVersion(current, line, to = null) {
  const now = SEMVER.exec(current ?? '');
  if (!now) return { refused: 'version.not_semver', vars: { version: current } };
  const [lineMajor, lineMinor] = String(line ?? `${now[1]}.${now[2]}`).split('.').map(Number);
  const order = (a, b) => a.map((x, i) => x - b[i]).find((d) => d !== 0) ?? 0;
  const parts = now.slice(1).map(Number);
  if (order([lineMajor, lineMinor], parts.slice(0, 2)) < 0) return { refused: 'version.line_behind', vars: { line, current } };
  const fresh = order([lineMajor, lineMinor], parts.slice(0, 2)) > 0;
  const next = fresh ? `${lineMajor}.${lineMinor}.0` : `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  if (!to) return { next };
  const asked = SEMVER.exec(to);
  if (!asked) return { refused: 'version.not_semver', vars: { version: to } };
  if (Number(asked[1]) !== lineMajor || Number(asked[2]) !== lineMinor) return { refused: 'version.off_line', vars: { version: to, line: `${lineMajor}.${lineMinor}` } };
  if (order(asked.slice(1).map(Number), parts) <= 0) return { refused: 'version.not_greater', vars: { version: to, current } };
  return { next: to };
}

// The text with the version replaced where its reading finds it, and nowhere else; null when that place is not one.
export function writeVersion(text, reading, from, to) {
  const [format, path = ''] = reading.split(':');
  const keys = path.split('.').filter(Boolean);
  const key = keys.at(-1);
  let start = 0;
  let end = text.length;
  if (format === 'toml' && keys.length > 1) {
    const header = new RegExp(`^\\[${escape(keys.slice(0, -1).join('.'))}\\][ \\t]*\\r?$`, 'm').exec(text);
    if (!header) return null;
    start = header.index + header[0].length;
    const next = /^\[/m.exec(text.slice(start));
    if (next) end = start + next.index;
  }
  const pattern = format === 'json' ? new RegExp(`("${escape(key)}"\\s*:\\s*)"${escape(from)}"`, 'g') : new RegExp(`^(${escape(key)}\\s*=\\s*)"${escape(from)}"`, 'gm');
  const block = text.slice(start, end);
  // Only one place may match: a dependency that shares the version would otherwise be bumped too.
  if ((block.match(pattern) ?? []).length !== 1) return null;
  const written = text.slice(0, start) + block.replace(pattern, `$1"${to}"`) + text.slice(end);
  return readVersion(written, reading) === to ? written : null;
}

function git(args, cwd = ROOT) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim(), error: (out.stderr ?? '').trim() };
}

// The version of a tree, read in every manifest; the manifests must agree.
export function treeVersion(root, factory = readFactory(root)) {
  const files = manifests(root, factory, readJson(join(root, 'config', 'rules.json'), {}));
  const found = files.filter(({ file }) => existsSync(join(root, file))).map(({ file, read }) => ({ file, read, version: readVersion(readFileSync(join(root, file), 'utf8'), read) }));
  const versions = [...new Set(found.map((f) => f.version))];
  return { files: found, current: versions.length === 1 ? versions[0] : null, disagree: versions.length > 1 };
}

function show(argv, factory) {
  const { files, current, disagree } = treeVersion(ROOT, factory);
  if (!files.length) throw new Error(t('version.none'));
  const list = files.map((f) => `${f.file} ${f.version}`).join(', ');
  if (disagree) throw new Error(t('version.disagree', { list }));
  const line = factory.version?.line ?? current.split('.').slice(0, 2).join('.');
  const planned = nextVersion(current, factory.version?.line ?? null);
  const state = { current, line, next: planned.next ?? null, files: files.map(({ file, read }) => ({ file, read })) };
  if (argv.includes('--json')) console.log(JSON.stringify(state, null, 2));
  else console.log(t('version.show', { current, line, next: state.next ?? '-', files: files.map((f) => f.file).join(', ') }));
  return true;
}

// The bump happens in a tree of its own, from the remote main branch: the factory tree stays as it is, and the branch
// it leaves is the factory's, taken by the next train with `--with`.
async function bump(argv, factory) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  if (!factory.fixes.includes('version')) throw new Error(t('version.not_allowed'));
  const factoryTree = stationSetting('factory');
  if (factoryTree && resolve(factoryTree).toLowerCase() !== ROOT.toLowerCase()) throw new Error(t('release.not_factory', { tree: factoryTree }));
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  const { remote, main_branch: main } = factory;
  const fetched = git(['fetch', '--quiet', remote, main]);
  if (!fetched.ok) throw new Error(`git fetch: ${fetched.error}`);
  const tree = join(dirname(slot), 'version-tree');
  if (existsSync(tree)) git(['worktree', 'remove', '--force', tree]);
  rmSync(tree, { recursive: true, force: true });
  git(['worktree', 'prune']);
  const added = git(['worktree', 'add', '--quiet', '--detach', tree, `${remote}/${main}`]);
  if (!added.ok) throw new Error(`git worktree add: ${added.error}`);
  try {
    const onMain = readFactory(tree);
    const { files, current, disagree } = treeVersion(tree, onMain);
    if (!files.length) throw new Error(t('version.none'));
    if (disagree) throw new Error(t('version.disagree', { list: files.map((f) => `${f.file} ${f.version}`).join(', ') }));
    const planned = nextVersion(current, onMain.version?.line ?? null, value('--to'));
    if (planned.refused) throw new Error(t(planned.refused, planned.vars));
    const to = planned.next;
    for (const { file, read } of files) {
      const written = writeVersion(readFileSync(join(tree, file), 'utf8'), read, current, to);
      if (written === null) throw new Error(t('version.write_failed', { file, reading: read }));
      writeFileSync(join(tree, file), written);
    }
    const changed = files.map((f) => f.file);
    // The lockfiles that carry the project's own version follow it, offline, or nothing is committed.
    if (changed.includes('Cargo.toml') && existsSync(join(tree, 'Cargo.lock'))) {
      const lock = run(['cargo', 'update', '--workspace', '--offline'], { cwd: tree, stdio: 'inherit' });
      if (lock.status !== 0) throw new Error(t('version.lock_failed'));
      changed.push('Cargo.lock');
    }
    if (changed.includes('package.json') && existsSync(join(tree, 'package-lock.json'))) {
      const lock = JSON.parse(readFileSync(join(tree, 'package-lock.json'), 'utf8'));
      lock.version = to;
      if (lock.packages?.['']) lock.packages[''].version = to;
      writeFileSync(join(tree, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
      changed.push('package-lock.json');
    }
    const branch = `warden/version-${to}`;
    const steps = [['switch', '--quiet', '-C', branch], ['add', '--', ...changed], ['commit', '--quiet', '-m', `Version ${to}`]];
    for (const args of steps) {
      const r = git(args, tree);
      if (!r.ok) throw new Error(`git ${args[0]}: ${r.error || r.out}`);
    }
    console.log(t('version.bumped', { to, branch, files: changed.join(', ') }));
    return true;
  } finally {
    git(['worktree', 'remove', '--force', tree]);
  }
}

async function main([command, ...rest]) {
  if (command === 'show') return show(rest, readFactory());
  if (command === 'bump') return bump(rest, readFactory());
  console.error(t('version.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ? 0 : 1;
  } catch (error) {
    console.error(t('version.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
