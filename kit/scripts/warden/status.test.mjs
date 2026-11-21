// First: no git of this test inherits the repository that launches it (git-env.mjs).
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectStatus, formatStatus } from './status.mjs';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet', '-b', 'main');
  return { root, git };
}

test('the status reads the tree, the dock and the role instead of guessing them', (t) => {
  const { root, git } = repo(t);
  mkdirSync(join(root, '.work', 'train-ready'), { recursive: true });
  writeFileSync(join(root, '.work', 'train-ready', 'agent-a.txt'), 'tree = /x\nbranch = a\ntasks = T1\n');
  writeFileSync(join(root, '.work', 'train-ready', 'agent-b.txt'), 'tree = /y\nbranch = b\nrefused = conflict\n');
  writeFileSync(join(root, 'AGENTS.md'), 'rules\n');

  let s = collectStatus({ root, agent: 'agent-b' });
  assert.equal(s.kit, null);
  assert.equal(s.hooks_active, false);
  assert.equal(s.rules_source, 'AGENTS.md');
  assert.equal(s.role, 'unset', 'no factory declared');
  assert.equal(s.main_tree, true);
  assert.deepEqual(s.dock.ready.map((d) => d.branch), ['a']);
  assert.deepEqual(s.dock.refused.map((d) => d.branch), ['b']);
  assert.deepEqual(s.mine.map((d) => d.refused), ['conflict'], 'the agent sees its own refusal');
  assert.equal(s.slot.holder, null);

  git('config', 'warden.factory', root);
  git('config', 'core.hooksPath', '.githooks');
  s = collectStatus({ root });
  assert.equal(s.role, 'factory');
  assert.equal(s.hooks_active, true);
  git('config', 'warden.factory', join(root, '..', 'elsewhere'));
  assert.equal(collectStatus({ root }).role, 'agent');
});

test('the text says each point on one line, and warns when the hooks are off', () => {
  const lines = formatStatus({
    kit: { name: 'warden', version: '0.4.0' }, hooks_active: false, rules_source: 'AGENTS.md', role: 'agent', branch: 'feature', main_branch: 'main', clean: true,
    slot: { folder: '/s', holder: null }, dock: { ready: [], refused: [] }, mine: [{ name: 'me.txt', branch: 'feature', refused: 'conflict' }], task_tool: null, shared_build_cache: [],
  });
  assert.match(lines.join('\n'), /Kit: warden 0.4.0/);
  assert.match(lines.join('\n'), /Role: agent/);
  assert.match(lines.join('\n'), /me\.txt: feature — refused: conflict/);
  assert.match(lines.at(-1), /git config core\.hooksPath \.githooks/);
});
