import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { matchArtifacts, sha256, sumsText, withFile } from './release.mjs';

test('a release names its artifacts by path, or by a star in the last segment', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'out', 'bundle'), { recursive: true });
  for (const name of ['out/bundle/app_1.0_x64.msi', 'out/bundle/app_1.0_x64-setup.exe', 'out/bundle/notes.txt', 'out/app.txt']) writeFileSync(join(root, name), name);
  assert.deepEqual(matchArtifacts(root, ['out/app.txt', 'out/bundle/*.msi', 'out/bundle/*-setup.exe']).found, ['out/app.txt', 'out/bundle/app_1.0_x64.msi', 'out/bundle/app_1.0_x64-setup.exe']);
  assert.deepEqual(matchArtifacts(root, ['out/bundle/*.dmg', 'out/missing.txt']).missing, ['out/bundle/*.dmg', 'out/missing.txt'], 'an artifact that is not there is named');
});

test('the fingerprints are written as sha256sum reads them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'abc');
  assert.equal(sha256(join(root, 'a.txt')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sumsText([{ name: 'a.txt', sha256: 'ba78' }, { name: 'b.msi', sha256: 'ff00' }]), 'ba78  a.txt\nff00  b.msi\n');
});

test('the signature check receives each artifact in place of {file}', () => {
  assert.deepEqual(withFile(['signtool', 'verify', '/pa', '{file}'], 'C:/r/app.msi'), ['signtool', 'verify', '/pa', 'C:/r/app.msi']);
});
