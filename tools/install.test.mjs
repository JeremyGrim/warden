// First: no git of this test inherits the repository that launches it.
import '../kit/scripts/warden/git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fingerprint } from '../kit/scripts/warden/kit.mjs';
import { adaptFactory, adaptRules } from './install.mjs';

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const RULES_MODEL = JSON.parse(readFileSync(join(dirname(INSTALL), '..', 'kit', 'config', 'rules.json'), 'utf8'));
const FACTORY_MODEL = JSON.parse(readFileSync(join(dirname(INSTALL), '..', 'kit', 'config', 'factory.json'), 'utf8'));

function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  // The copy and its models; adoption has its own guard (adopt.test.mjs).
  const install = (...args) => spawnSync(process.execPath, [INSTALL, root, '--no-adopt', ...args], { encoding: 'utf8' });
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return { root, install, read };
}

const NODE = {
  'package.json': JSON.stringify({ name: 'trial', version: '0.2.0', scripts: { test: 'node --test', build: 'node build.mjs' } }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'src/a.mjs': 'export const a = 1;\n',
  'notes.txt': 'x\n',
};

test('the install writes the kit, its models adapted to the project, and turns the hooks on', (t) => {
  const { root, install, read } = project(t, NODE);
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, 'scripts/warden/kit.json')));
  const rules = JSON.parse(read('config/rules.json'));
  assert.ok(rules.root.dirs.includes('src'));
  assert.ok(rules.root.files.includes('notes.txt') && rules.root.files.includes('pnpm-lock.yaml'));
  assert.match(r.stdout, /allowed at the root because present.*src\/.*notes\.txt/);
  assert.ok(!rules.forbidden_lockfiles.includes('pnpm-lock.yaml'));
  const factory = JSON.parse(read('config/factory.json'));
  assert.deepEqual(factory.verify.steps.map((s) => s.command), [['pnpm', 'test'], ['pnpm', 'run', 'build']]);
  assert.deepEqual(factory.train.install, { lockfile: 'pnpm-lock.yaml', command: ['pnpm', 'install', '--frozen-lockfile'] });
  assert.match(read('AGENTS.md'), new RegExp(`Rules of the ${root.split(/[\\/]/).pop()} repository`));
  assert.match(read('.gitignore'), /^\.work\/$/m);
  assert.match(read('.gitignore'), /^config\/disk\.local\.json$/m, 'the budgets of one workstation are never committed');
  assert.match(read('.gitattributes'), /^\.githooks\/\* text eol=lf$/m, 'the hooks stay LF');
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim(), '.githooks');
  const check = spawnSync(process.execPath, ['scripts/warden/rules.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, `the installed project respects its rules: ${check.stderr}`);
});

test('in French, the rules text and the agent pointer are the French models', (t) => {
  const { install, read } = project(t, NODE);
  assert.equal(install('--locale', 'fr').status, 0);
  assert.match(read('AGENTS.md'), /^# Règlement du dépôt/);
  assert.match(read('CLAUDE.md'), /^Lire et appliquer/);
  assert.match(read('config/rules.json'), /"max_lines"/, 'configuration keys stay English');
});

test('a second install keeps the models and replaces the kit', (t) => {
  const { install, read } = project(t, NODE);
  install();
  const before = read('config/factory.json');
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept as is: config\/rules\.json, config\/factory\.json/);
  assert.equal(read('config/factory.json'), before);
});

test('a push hook left as an earlier kit wrote it follows the kit; one the project changed is kept', (t) => {
  const { root, install, read } = project(t, NODE);
  install();
  const earlier = '#!/bin/sh\n# Git gives on standard input what it pushes: the push verification reads it.\n# The rules on the whole tree, the script guards, the disk (warning only), then the scope of the push.\nrefs=$(cat)\nnode scripts/warden/rules.mjs || exit 1\nnode --test "scripts/**/*.test.mjs" || exit 1\nnode scripts/warden/disk.mjs guard --warn\nprintf \'%s\\n\' "$refs" | node scripts/warden/verify.mjs push\n';
  writeFileSync(join(root, '.githooks/pre-push'), earlier.replaceAll('\n', '\r\n'));
  assert.equal(install().status, 0);
  assert.match(read('.githooks/pre-push'), /node scripts\/warden\/guards\.mjs \|\| exit 1/, 'the hook of 0.3.0 is replaced');
  writeFileSync(join(root, '.githooks/pre-push'), `${earlier}echo mine\n`);
  assert.equal(install().status, 0);
  assert.match(read('.githooks/pre-push'), /echo mine/, 'a hook the project changed is kept');
});

test('an edited kit script, or a file unknown to the kit, stops the install without writing anything', (t) => {
  const { root, install } = project(t, NODE);
  install();
  writeFileSync(join(root, 'scripts/warden/train.mjs'), '// edited\n', { flag: 'a' });
  rmSync(join(root, 'config/disk.json'));
  const r = install();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /edited: scripts\/warden\/train\.mjs/);
  assert.ok(!existsSync(join(root, 'config/disk.json')), 'nothing is written');

  const { root: other, install: installOther } = project(t, NODE);
  installOther();
  writeFileSync(join(other, 'scripts/warden/mine.mjs'), '');
  const unknown = installOther();
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown to the kit: scripts\/warden\/mine\.mjs/);
});

test('a file a previous version installed, and this one no longer does, is removed when not edited', (t) => {
  const { root, install } = project(t, NODE);
  install();
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/warden/kit.json'), 'utf8'));
  writeFileSync(join(root, 'scripts/warden/old.mjs'), 'export {};\n');
  manifest.files['old.mjs'] = fingerprint(Buffer.from('export {};\n'));
  manifest.version = '0.0.1';
  writeFileSync(join(root, 'scripts/warden/kit.json'), JSON.stringify(manifest));
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0\.0\.1 → /);
  assert.ok(!existsSync(join(root, 'scripts/warden/old.mjs')));
});

test('the adapted rules take the manager present and the version of each manifest', (t) => {
  const { root } = project(t, {
    'package-lock.json': '{}',
    'package.json': JSON.stringify({ version: '1.0.0' }),
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.0.0"\n',
  });
  const { rules } = adaptRules(RULES_MODEL, root, { dirs: ['crates', 'target'], files: ['Cargo.toml', 'package-lock.json', 'package.json'] });
  assert.ok(!rules.forbidden_lockfiles.includes('package-lock.json') && rules.forbidden_lockfiles.includes('yarn.lock'));
  assert.ok(!rules.root.dirs.includes('target'), 'a forbidden folder is not allowed');
  assert.deepEqual(rules.versions, [{ file: 'package.json', read: 'json:version' }, { file: 'Cargo.toml', read: 'toml:workspace.package.version' }]);
  const factory = adaptFactory(FACTORY_MODEL, root, { dirs: [], files: ['Cargo.toml', 'package-lock.json', 'package.json'] }, { cargoDeny: true });
  assert.equal(factory.verify.rust.deny, 'config/deny.toml');
  assert.deepEqual(factory.train.install.command, ['npm', 'ci']);
  assert.equal(factory.verify.npm_advisories, null, 'the workstation advisories read a pnpm lockfile only');
});
