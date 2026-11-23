// The guard of kit-update.mjs. It carries its own kits, an older one in the project and a newer one to install, and never
// reads the host project.
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fingerprint } from './kit.mjs';
import { deposit, DEPOSIT } from './kit-update.mjs';

function git(cwd, ...args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim() };
}

// A kit folder: its files and the manifest that fingerprints them.
function writeKit(folder, version, files) {
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  const manifest = { name: 'warden', version, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, fingerprint(text)])) };
  writeFileSync(join(folder, 'kit.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

// A project on its main branch, pushed, with the hooks on and an older kit; and a newer kit beside it.
function setting(t) {
  const base = mkdtempSync(join(tmpdir(), 'warden-kit-update-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const remote = join(base, 'remote.git');
  const root = join(base, 'project');
  git(base, 'init', '--quiet', '--bare', '-b', 'main', remote);
  mkdirSync(root);
  git(root, 'init', '--quiet', '-b', 'main');
  for (const [key, value] of [['user.name', 'guard'], ['user.email', 'guard@example.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.githooks']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', remote);
  writeKit(join(root, 'scripts', 'warden'), '0.0.1', { 'a.mjs': 'export const a = 1;\n', 'gone.mjs': 'export const gone = 1;\n' });
  mkdirSync(join(root, '.githooks'));
  writeFileSync(join(root, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(root, '.gitignore'), '.work/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'project');
  git(root, 'push', '--quiet', 'origin', 'main');
  mkdirSync(join(root, '.work'));
  const source = join(base, 'newer', 'scripts', 'warden');
  writeKit(source, '0.0.2', { 'a.mjs': 'export const a = 2;\n', 'b.mjs': 'export const b = 2;\n' });
  return { root, remote, source, head: () => git(base, '--git-dir', remote, 'rev-parse', 'main').out };
}

test('the newer kit is committed on a branch of its own and docked; no tree changes branch, nothing is pushed', (t) => {
  const { root, source, head } = setting(t);
  const before = { main: head(), here: git(root, 'rev-parse', 'HEAD').out };
  assert.equal(deposit(['--project', root], source), true);
  const fields = Object.fromEntries(readFileSync(join(root, '.work', 'train-ready', DEPOSIT), 'utf8').split('\n').map((l) => /^(\w+) = (.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  assert.match(fields.branch, /^warden\/kit-0\.0\.2-/);
  assert.equal(git(root, 'rev-parse', fields.branch).out, fields.commit, 'the deposit names the commit of its branch');
  assert.equal(JSON.parse(git(root, 'show', `${fields.branch}:scripts/warden/kit.json`).out).version, '0.0.2');
  assert.equal(git(root, 'show', `${fields.branch}:scripts/warden/a.mjs`).out, 'export const a = 2;');
  assert.ok(git(root, 'show', `${fields.branch}:scripts/warden/b.mjs`).ok, 'a file of the new kit comes');
  assert.ok(!git(root, 'show', `${fields.branch}:scripts/warden/gone.mjs`).ok, 'a file the new kit no longer has goes');
  assert.equal(git(root, 'log', '-1', '--format=%s', fields.branch).out, 'Warden kit 0.0.2, from 0.0.1');
  assert.deepEqual({ main: head(), here: git(root, 'rev-parse', 'HEAD').out }, before);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').out, 'main');
  assert.ok(!existsSync(join(root, '.work', 'kit-tree')), 'the tree of its own is removed');
  assert.throws(() => deposit(['--project', root], source), /waits for the train/, 'a second update waits for the first');
});

test('a kit edited on the main branch is never replaced unseen', (t) => {
  const { root, source } = setting(t);
  writeFileSync(join(root, 'scripts', 'warden', 'a.mjs'), 'export const a = 99;\n');
  git(root, 'commit', '--quiet', '-am', 'edited kit');
  git(root, 'push', '--quiet', 'origin', 'main');
  assert.throws(() => deposit(['--project', root], source), /was edited \(a\.mjs\)/);
  assert.equal(git(root, 'branch', '--list', 'warden/kit-*').out, '', 'its branch is removed');
  assert.ok(!existsSync(join(root, '.work', 'train-ready', DEPOSIT)));
});

test('a kit that is not newer, a source that differs from its manifest, hooks off: nothing is deposited', (t) => {
  const { root, source } = setting(t);
  const older = join(root, '..', 'older');
  writeKit(older, '0.0.1', { 'a.mjs': 'export const a = 1;\n' });
  assert.throws(() => deposit(['--project', root], older), /not older than 0\.0\.1/);
  writeFileSync(join(source, 'b.mjs'), 'export const b = 3;\n');
  assert.throws(() => deposit(['--project', root], source), /differs from its kit\.json \(b\.mjs\)/);
  git(root, 'config', '--unset', 'core.hooksPath');
  assert.throws(() => deposit(['--project', root], older), /hooks are inactive/);
  assert.ok(!existsSync(join(root, '.work', 'train-ready', DEPOSIT)));
});
