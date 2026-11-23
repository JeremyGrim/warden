// First: the git commands of this guard do not inherit the repository that launches it either.
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Incident of 10 November 2026, in the kit's first repository: pushed from a linked worktree, the pre-push hook ran the
// tests with an absolute GIT_DIR, and those creating their own repositories wrote into the real one (`core.bare = true`,
// three "t" commits). This guard runs them again with GIT_DIR on a throwaway witness: the witness does not move, and the
// tests pass.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_THAT_CREATE_REPOSITORIES = ['scripts/warden/disk.test.mjs', 'scripts/warden/rules.test.mjs', 'scripts/warden/status.test.mjs', 'scripts/warden/hooks.test.mjs', 'scripts/warden/ui.test.mjs', 'scripts/warden/kit-update.test.mjs'];

function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=witness', '-c', 'user.email=witness@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

test('the tests that create repositories never write into an inherited GIT_DIR', (t) => {
  const tray = mkdtempSync(join(tmpdir(), 'git-witness-'));
  t.after(() => rmSync(tray, { recursive: true, force: true }));
  git(tray, 'init', '-b', 'main', 'witness');
  const witness = join(tray, 'witness');
  writeFileSync(join(witness, 'witness.txt'), 'witness');
  git(witness, 'add', '-A');
  git(witness, 'commit', '-m', 'witness');
  const gitDir = join(witness, '.git');
  const config = readFileSync(join(gitDir, 'config'), 'utf8');
  const head = git(witness, 'rev-parse', 'HEAD');
  // The child is a real test runner: without NODE_TEST_CONTEXT, which the parent runner would hand it.
  const { NODE_TEST_CONTEXT, ...withoutContext } = process.env;
  void NODE_TEST_CONTEXT;
  for (const file of TESTS_THAT_CREATE_REPOSITORIES) {
    const out = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8', env: { ...withoutContext, GIT_DIR: gitDir } });
    assert.match(out.stdout, /ℹ pass [1-9]/, `${file} did not run: ${out.stdout.slice(-800)}`);
    assert.equal(out.status, 0, `${file}, launched with an inherited GIT_DIR: ${out.stdout.slice(-1500)}${out.stderr.slice(-500)}`);
    assert.equal(readFileSync(join(gitDir, 'config'), 'utf8'), config, `${file} rewrote the witness configuration`);
    assert.equal(git(witness, 'rev-parse', 'HEAD'), head, `${file} committed into the witness`);
    assert.equal(git(witness, 'rev-list', '--all', '--count'), '1', `${file} added commits to the witness`);
  }
});
