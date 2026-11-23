#!/usr/bin/env node
// The factory's release: a frozen commit of the main branch, built in a clean tree of its own (never the train's),
// its artifacts fingerprinted, their signature checked when the project signs them. Configured in config/factory.json,
// section `release`.
//
//   node scripts/warden/release.mjs build --commit <sha> [--label <name>]
//
// The label defaults to the version the commit's manifests carry (`v0.4.1`). The result lands in
// <work>/releases/<label>/: the artifacts, SHA256SUMS and release.json; with `keep`, only the latest releases stay.
// Publishing it (a tag, a store, a download page) is the person's decision, never this tool's. A signing key stays in the workstation's
// environment: Warden never reads it, and the signing output is printed only when it fails, never written to a file.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory, ROOT, runCaptured, sameTree, stationSetting } from './config.mjs';
import { appendHistory, historyPath } from './history.mjs';
import { t } from './messages.mjs';
import { holder } from './slot.mjs';
import { stationSlot } from './verify.mjs';
import { treeVersion } from './version.mjs';

// The artifacts a release names: plain paths, or a `*` in the last segment. Each must exist.
export function matchArtifacts(root, patterns) {
  const found = [];
  const missing = [];
  for (const pattern of patterns) {
    const posix = pattern.replaceAll('\\', '/');
    const folder = dirname(posix);
    const leaf = basename(posix);
    if (!leaf.includes('*')) {
      if (existsSync(join(root, posix))) found.push(posix);
      else missing.push(pattern);
      continue;
    }
    const re = new RegExp(`^${leaf.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const names = existsSync(join(root, folder)) ? readdirSync(join(root, folder)).filter((n) => re.test(n)).sort() : [];
    if (names.length) found.push(...names.map((n) => (folder === '.' ? n : `${folder}/${n}`)));
    else missing.push(pattern);
  }
  return { found: [...new Set(found)], missing };
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// The SHA256SUMS format, as `sha256sum -c` reads it.
export const sumsText = (artifacts) => artifacts.map((a) => `${a.sha256}  ${a.name}\n`).join('');

// A command with `{file}` replaced by each artifact's path.
export const withFile = (command, file) => command.map((word) => word.replaceAll('{file}', file));

// The releases past the `keep` latest, by the moment each was built: removed once a new one is ready.
export function beyondKept(releases, keep) {
  return [...releases].sort((a, b) => b.at.localeCompare(a.at)).slice(keep).map((r) => r.label);
}

function listReleases(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    let at = null;
    try {
      at = JSON.parse(readFileSync(join(folder, e.name, 'release.json'), 'utf8')).at ?? null;
    } catch {
      // A build that failed has no release.json: its folder counts by its date.
    }
    return { label: e.name, at: at ?? statSync(join(folder, e.name)).mtime.toISOString() };
  });
}

function git(args, cwd = ROOT) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim(), error: (out.stderr ?? '').trim() };
}

async function build(argv, factory) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const conf = factory.release;
  if (!conf?.build || !conf.artifacts?.length) throw new Error(t('release.not_configured'));
  const factoryTree = stationSetting('factory');
  if (factoryTree && !sameTree(factoryTree, ROOT)) throw new Error(t('release.not_factory', { tree: factoryTree }));
  const slot = stationSlot(factory);
  if (!slot) throw new Error(t('train.no_slot', { work: factory.work_dir }));
  // One big build at a time on the workstation: a train or a push holding the slot goes first.
  const busy = holder(slot);
  if (busy) throw new Error(t('release.slot_busy', { tree: busy.tree }));
  const { remote, main_branch: main } = factory;
  const fetched = git(['fetch', '--quiet', remote, main]);
  if (!fetched.ok) throw new Error(`git fetch: ${fetched.error}`);
  const named = git(['rev-parse', '--verify', '--quiet', `${value('--commit') ?? ''}^{commit}`]);
  if (!value('--commit') || !named.ok) throw new Error(t('release.no_commit', { commit: value('--commit') ?? '' }));
  const commit = named.out;
  // Only what went up through the train is released: a commit of the main branch, frozen.
  if (!git(['merge-base', '--is-ancestor', commit, `${remote}/${main}`]).ok) throw new Error(t('release.not_on_main', { commit: commit.slice(0, 7), branch: main }));

  const work = dirname(slot);
  const place = buildTree(conf, work, commit);
  try {
    return await buildIn(place, { argv, factory, conf, work, commit, slot });
  } finally {
    place.dispose();
  }
}

// Where a release is built. By default a worktree of the work folder, kept from one release to the next. With
// `"tree": "clone"`, a fresh clone outside the repository with its own Cargo target, deleted once the artifacts are
// copied: nothing untracked of the root (a local .env file, a shared target) reaches the build. The clone goes under
// `git config warden.releaseDir`, else the system's temporary folder.
function buildTree(conf, work, commit) {
  if (conf.tree === 'clone') {
    const base = stationSetting('releaseDir') ?? tmpdir();
    mkdirSync(base, { recursive: true });
    const tree = mkdtempSync(join(base, 'warden-release-'));
    const dispose = () => rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
    const cloned = git(['clone', '--quiet', '--shared', '--no-checkout', common, tree]);
    const moved = cloned.ok ? git(['checkout', '--quiet', '--detach', commit], tree) : cloned;
    if (!moved.ok) {
      dispose();
      throw new Error(`git clone: ${moved.error}`);
    }
    return { tree, kind: 'clone', env: { ...process.env, CARGO_TARGET_DIR: join(tree, 'target') }, dispose };
  }
  const tree = join(work, 'release-tree');
  if (!existsSync(tree)) {
    const added = git(['worktree', 'add', '--quiet', '--detach', tree, commit]);
    if (!added.ok) throw new Error(`git worktree add: ${added.error}`);
  } else {
    const moved = git(['checkout', '--quiet', '-f', '--detach', commit], tree);
    if (!moved.ok) throw new Error(`git checkout: ${moved.error}`);
    git(['clean', '-ffdq'], tree);
  }
  // An artifact left by an earlier release would pass for this one's.
  for (const pattern of conf.artifacts) for (const path of matchArtifacts(tree, [pattern]).found) rmSync(join(tree, path), { force: true, recursive: true });
  return { tree, kind: 'worktree', env: process.env, dispose: () => {} };
}

async function buildIn({ tree, kind, env }, { argv, factory, conf, work, commit, slot }) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

  // The label: given, else the version the commit's manifests carry, else the commit.
  const { current } = treeVersion(tree, factory);
  const label = (value('--label') ?? (current ? `v${current}` : commit.slice(0, 7))).replace(/[^\w.-]+/g, '-');
  const out = join(work, 'releases', label);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, 'build.log');
  console.log(t('release.building', { commit: commit.slice(0, 7), tree }));
  for (const command of [factory.train.install?.command, conf.build].filter(Boolean)) {
    const r = await runCaptured(command, { cwd: tree, log, env });
    if (r.status !== 0) throw new Error(t('release.step_failed', { command: command.join(' '), log }));
  }
  const { found, missing } = matchArtifacts(tree, conf.artifacts);
  if (missing.length) throw new Error(t('release.missing', { artifacts: missing.join(', ') }));
  // The signature: its output goes nowhere but the screen, and only when it fails.
  let signed = false;
  if (conf.sign) {
    const r = await runCaptured(conf.sign, { cwd: tree, quiet: true, env });
    if (r.status !== 0) {
      process.stderr.write(r.text);
      throw new Error(t('release.sign_failed'));
    }
    signed = true;
  }
  let checked = false;
  if (conf.check_signature) {
    for (const path of found) {
      const r = await runCaptured(withFile(conf.check_signature, join(tree, path)), { cwd: tree, quiet: true, env });
      if (r.status !== 0) {
        process.stderr.write(r.text);
        throw new Error(t('release.check_failed', { artifact: path }));
      }
    }
    checked = true;
  }
  const artifacts = found.map((path) => {
    const name = basename(path);
    copyFileSync(join(tree, path), join(out, name));
    return { name, path, bytes: statSync(join(out, name)).size, sha256: sha256(join(out, name)) };
  });
  writeFileSync(join(out, 'SHA256SUMS'), sumsText(artifacts));
  const summary = { commit, label, at: new Date().toISOString(), built_in: kind, artifacts, signed, signature_checked: checked };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(summary, null, 2)}\n`);
  appendHistory(historyPath(slot), { kind: 'release', commit, label, artifacts: artifacts.map(({ name, bytes, sha256: s }) => ({ name, bytes, sha256: s })), signed, signature_checked: checked }, { keepDays: factory.history.keep_days });
  for (const a of artifacts) console.log(`  ${a.sha256}  ${a.name}`);
  console.log(t('release.ready', { folder: out, count: artifacts.length }));
  if (conf.keep) {
    const removed = beyondKept(listReleases(join(work, 'releases')), conf.keep).filter((name) => name !== label);
    for (const name of removed) rmSync(join(work, 'releases', name), { recursive: true, force: true });
    if (removed.length) console.log(t('release.removed', { keep: conf.keep, labels: removed.join(', ') }));
  }
  return true;
}

async function main([command, ...rest]) {
  if (command === 'build') return build(rest, readFactory());
  console.error(t('release.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ? 0 : 1;
  } catch (error) {
    console.error(t('release.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
