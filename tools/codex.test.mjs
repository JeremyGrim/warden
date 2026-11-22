import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { CODEX_MANIFEST, codexManifest, REPO } from './fingerprints.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the Codex manifest follows the Claude Code one: run node tools/fingerprints.mjs after a change', () => {
  assert.deepEqual(read(CODEX_MANIFEST), codexManifest());
  assert.equal(read(CODEX_MANIFEST).version, read(join(REPO, '.claude-plugin', 'plugin.json')).version);
});

test('the Codex listing keeps its subtitle short and a category Codex knows', () => {
  const { interface: shown } = codexManifest();
  assert.ok(shown.shortDescription.length <= 30, shown.shortDescription);
  assert.equal(shown.category, 'Developer Tools');
});

test('the Codex hook starts the session script by its full command, with ${PLUGIN_ROOT}', () => {
  const manifest = codexManifest();
  const hooks = read(join(REPO, manifest.hooks));
  const [group] = hooks.hooks.SessionStart;
  const [hook] = group.hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.args, undefined, 'Codex drops args: the command carries everything');
  for (const command of [hook.command, hook.commandWindows]) {
    // A command that starts with a quote is an expression for PowerShell, not a program to run (Codex launches
    // commandWindows through PowerShell).
    assert.match(command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/session-start\.mjs" --host codex$/);
  }
  assert.ok(existsSync(join(REPO, 'hooks', 'session-start.mjs')));
  assert.ok(existsSync(join(REPO, manifest.skills, 'setup', 'SKILL.md')));
});
