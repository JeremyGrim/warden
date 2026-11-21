import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FACTORY_DEFAULTS } from './config.mjs';
import { manifests, nextVersion, writeVersion } from './version.mjs';

test('the factory moves the patch number within the line, and nothing more', () => {
  assert.deepEqual(nextVersion('0.4.0', null), { next: '0.4.1' }, 'no line declared: the current major.minor');
  assert.deepEqual(nextVersion('0.4.9', '0.4'), { next: '0.4.10' });
  assert.deepEqual(nextVersion('0.4.3', '0.5'), { next: '0.5.0' }, 'the person moved the line: its first version');
  assert.deepEqual(nextVersion('0.4.3', '0.4', '0.4.7'), { next: '0.4.7' });
  assert.equal(nextVersion('0.4.3', '0.4', '0.5.0').refused, 'version.off_line', 'leaving the line is the person\'s decision');
  assert.equal(nextVersion('0.4.3', '0.4', '0.4.3').refused, 'version.not_greater');
  assert.equal(nextVersion('0.4.3', '0.3').refused, 'version.line_behind');
  assert.equal(nextVersion('1.0.0-beta.1', null).refused, 'version.not_semver');
});

test('the version is written in its one place, and only there', () => {
  const pkg = '{\n  "name": "app",\n  "version": "0.4.0",\n  "private": true\n}\n';
  assert.equal(writeVersion(pkg, 'json:version', '0.4.0', '0.4.1'), pkg.replace('"0.4.0"', '"0.4.1"'));
  const cargo = '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.4.0"\nedition = "2021"\n\n[workspace.dependencies]\nlocal = { version = "0.4.0" }\n';
  assert.equal(writeVersion(cargo, 'toml:workspace.package.version', '0.4.0', '0.4.1'), cargo.replace('version = "0.4.0"\nedition', 'version = "0.4.1"\nedition'), 'a dependency with the same version keeps it');
  const twice = '{\n  "version": "0.4.0",\n  "engines": { "version": "0.4.0" }\n}\n';
  assert.equal(writeVersion(twice, 'json:version', '0.4.0', '0.4.1'), null, 'two places: bumped by hand');
  assert.equal(writeVersion(pkg, 'json:version', '0.3.0', '0.3.1'), null, 'not the version found');
});

test('the manifests: the factory setting, else the rules, else the usual ones', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, 'package.json'), '{ "version": "0.4.0" }\n');
  writeFileSync(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.4.0"\n');
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{ "version": "0.4.0" }\n');
  assert.deepEqual(manifests(root, FACTORY_DEFAULTS, {}).map((m) => m.file), ['package.json', 'Cargo.toml', '.claude-plugin/plugin.json']);
  assert.deepEqual(manifests(root, FACTORY_DEFAULTS, { versions: [{ file: 'Cargo.toml', read: 'toml:workspace.package.version' }] }).map((m) => m.file), ['Cargo.toml']);
  const own = { ...FACTORY_DEFAULTS, version: { files: [{ file: 'VERSION.json', read: 'json:v' }] } };
  assert.deepEqual(manifests(root, own, {}).map((m) => m.file), ['VERSION.json']);
});
