// First: no git of this test inherits the repository that launches it.
import '../kit/scripts/warden/git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const PLUGIN = JSON.parse(readFileSync(join(dirname(CLI), '..', '.claude-plugin', 'plugin.json'), 'utf8'));
const warden = (args, cwd = process.cwd()) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

test('the warden command gives its version, its usage, and refuses what it does not know', () => {
  assert.equal(warden(['--version']).stdout.trim(), PLUGIN.version);
  assert.match(warden([]).stdout, /setup.*\n.*ui/s);
  assert.equal(warden(['publish']).status, 2);
});

test('setup is the installer, and ui needs the kit of the project', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  assert.equal(warden(['ui', root]).status, 1, 'no kit yet');
  const dry = warden(['setup', root, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(join(root, 'scripts', 'warden')), false, 'a dry run writes nothing');
  const installed = warden(['install', root]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(existsSync(join(root, 'scripts', 'warden', 'ui.mjs')), 'the interface comes with the kit');
});
