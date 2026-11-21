// First: no git of this test inherits the repository that launches it (git-env.mjs).
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The hooks journey in a throwaway project: a commit refused by the rules, a push verified on its scope, a push refused
// by a project step, and the slot given back each time.

const KIT = dirname(fileURLToPath(import.meta.url));

const COMMIT_HOOK = '#!/bin/sh\nexec node scripts/warden/rules.mjs --staged\n';
const PUSH_HOOK = [
  '#!/bin/sh',
  'refs=$(cat)',
  'node scripts/warden/rules.mjs || exit 1',
  'node --test "scripts/**/*.test.mjs" || exit 1',
  'node scripts/warden/disk.mjs guard --warn',
  "printf '%s\\n' \"$refs\" | node scripts/warden/verify.mjs push",
  '',
].join('\n');

function project(t) {
  const tray = mkdtempSync(join(tmpdir(), 'hooks-'));
  t.after(() => rmSync(tray, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  const repo = join(tray, 'project');
  const remote = join(tray, 'remote.git');
  // The hooks launch their own `node --test`: without the parent runner context, which would make them skip everything.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  void NODE_TEST_CONTEXT;
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  mkdirSync(join(repo, 'scripts', 'warden'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  git('init', '--quiet', '-b', 'main');
  for (const [key, value] of [['user.name', 'trial'], ['user.email', 'trial@example.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.githooks']]) git('config', key, value);
  git('remote', 'add', 'origin', remote);

  for (const name of readdirSync(KIT).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(KIT, name), join(repo, 'scripts', 'warden', name));
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  write('.githooks/pre-commit', COMMIT_HOOK);
  write('.githooks/pre-push', PUSH_HOOK);
  for (const hook of ['pre-commit', 'pre-push']) chmodSync(join(repo, '.githooks', hook), 0o755);
  write('config/rules.json', JSON.stringify({
    root: { dirs: ['src', 'config', 'scripts', '.githooks'], files: ['README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore'] },
    required: ['AGENTS.md'],
    max_lines: 700,
    forbidden_segments: ['.work'],
  }));
  write('config/factory.json', JSON.stringify({ verify: { steps: [{ title: 'Project tests', when: ['^src/'], command: ['node', '--test', 'src/**/*.test.mjs'] }] } }));
  write('config/disk.json', JSON.stringify({ min_free_gib: 0, max_build_gib: 1000, max_incremental_gib: 1000, max_worktrees: 2, max_worktree_age_days: 7 }));
  write('.gitignore', '.work/\n');
  write('README.md', 'Trial project.\n');
  write('AGENTS.md', 'The rules.\n');
  write('CLAUDE.md', 'Read AGENTS.md\n');
  write('scripts/guard.test.mjs', "import { test } from 'node:test';\ntest('guard', () => {});\n");
  write('src/sum.mjs', 'export const sum = (a, b) => a + b;\n');
  write('src/sum.test.mjs', "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 2), 4));\n");
  mkdirSync(join(repo, '.work'));
  const slot = join(repo, '.work', 'push-slot');
  const remoteHead = () => spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
  return { repo, git, write, slot, remoteHead };
}

// The slot is given back when the remote carries the commit: a detached process checks every 2 s.
async function slotReleased(slot) {
  for (let n = 0; n < 60 && existsSync(slot); n += 1) await new Promise((done) => setTimeout(done, 500));
  return !existsSync(slot);
}

test('the hooks refuse a finding at commit, verify the push, and give the slot back', async (t) => {
  const { repo, git, write, slot, remoteHead } = project(t);
  git('add', '-A');
  const first = git('commit', '--quiet', '-m', 'first');
  assert.equal(first.status, 0, first.stderr + first.stdout);

  write('notes.txt', 'at the root\n');
  git('add', 'notes.txt');
  const refused = git('commit', '--quiet', '-m', 'refused');
  assert.notEqual(refused.status, 0, 'a file not allowed at the root is not committed');
  assert.match(refused.stderr, /\[root\] notes\.txt/);
  git('rm', '--quiet', '--cached', 'notes.txt');
  rmSync(join(repo, 'notes.txt'));

  const pushed = git('push', '--quiet', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr + pushed.stdout);
  assert.match(pushed.stdout + pushed.stderr, /Project tests/, 'the project step ran');
  assert.equal(remoteHead(), git('rev-parse', 'HEAD').stdout.trim());
  assert.ok(await slotReleased(slot), 'the slot is given back once the commit arrived');

  write('src/sum.mjs', 'export const sum = (a, b) => a - b;\n');
  git('commit', '--quiet', '-am', 'broken');
  const before = remoteHead();
  const failed = git('push', '--quiet', 'origin', 'main');
  assert.notEqual(failed.status, 0, 'a failing step refuses the push');
  assert.match(failed.stdout + failed.stderr, /✖ Project tests/);
  assert.equal(remoteHead(), before, 'nothing reached the remote');
  assert.ok(!existsSync(slot), 'the slot is given back right after a refusal');

  write('src/sum.mjs', 'export const sum = (a, b) => a + b;\n');
  git('commit', '--quiet', '-am', 'fixed');
  const fixed = git('push', '--quiet', 'origin', 'main');
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  assert.ok(await slotReleased(slot));
});
