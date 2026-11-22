import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { guardKey, selection, testFiles } from './guards.mjs';

test('the script guards are found under scripts/, out of dependencies and hidden folders', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'guards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['scripts/warden/kit.test.mjs', 'scripts/warden/train.test.mjs', 'scripts/tools/sum.test.mjs', 'scripts/node_modules/x/a.test.mjs', 'scripts/.cache/b.test.mjs', 'scripts/tools/sum.mjs']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), '');
  }
  assert.deepEqual(testFiles(root), ['scripts/tools/sum.test.mjs', 'scripts/warden/kit.test.mjs', 'scripts/warden/train.test.mjs']);
});

test('the fingerprint and the project tests always run; the kit tests only when they can give another answer', () => {
  const files = ['scripts/tools/sum.test.mjs', 'scripts/warden/kit.test.mjs', 'scripts/warden/train.test.mjs'];
  assert.deepEqual(selection(files, false), ['scripts/warden/kit.test.mjs', 'scripts/warden/train.test.mjs', 'scripts/tools/sum.test.mjs']);
  assert.deepEqual(selection(files, true), ['scripts/warden/kit.test.mjs', 'scripts/tools/sum.test.mjs']);
});

test('the kit tests run again when a kit file, Node, Git or the platform changes', () => {
  const base = { files: { 'train.mjs': 'aa' }, node: 'v22.11.0', git: 'git version 2.47.0', platform: 'win32-x64' };
  const key = guardKey(base);
  assert.equal(guardKey({ ...base }), key);
  assert.notEqual(guardKey({ ...base, files: { 'train.mjs': 'ab' } }), key);
  assert.notEqual(guardKey({ ...base, node: 'v24.0.0' }), key);
  assert.notEqual(guardKey({ ...base, git: 'git version 2.48.0' }), key);
  assert.notEqual(guardKey({ ...base, platform: 'linux-x64' }), key);
});
