import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compare, notices, pluginRecord, skill } from './session-start.mjs';

test('in Codex the notices call the skill with $, as Codex does, never with the slash of Claude Code', () => {
  assert.equal(skill('onboard'), '/warden:onboard');
  assert.equal(skill('onboard', 'codex'), '$warden:onboard');
  const lines = notices({ kit: { version: '0.1.0' }, plugin: { version: '0.2.0' }, hooks: '.githooks', source: 'startup', locale: 'fr', host: 'codex' });
  assert.match(lines[0], /La skill \$warden:setup le met à jour/);
  assert.match(lines[1], /lancer \$warden:onboard avant/);
  assert.ok(lines.every((line) => !line.includes('/warden:')));
});

test('with no kit in the project, the hook says nothing', () => {
  assert.deepEqual(notices({ kit: null, plugin: { version: '0.2.0' }, hooks: '', source: 'startup' }), []);
});

test('all is well on a resume: nothing to say, no context cost', () => {
  assert.deepEqual(notices({ kit: { version: '0.2.0' }, plugin: { version: '0.2.0' }, hooks: '.githooks', source: 'resume' }), []);
});

test('inactive hooks, a kit behind, a new session: one line each', () => {
  const lines = notices({ kit: { version: '0.1.0' }, plugin: { version: '0.2.0' }, hooks: '', source: 'startup' });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /core\.hooksPath \.githooks/);
  assert.match(lines[1], /0\.1\.0.*0\.2\.0/);
  assert.match(lines[2], /\/warden:onboard/);
  assert.match(notices({ kit: { version: '0.2.0' }, plugin: { version: '0.2.0' }, hooks: '', source: 'resume', locale: 'fr' })[0], /crochets Git sont inactifs/);
});

test('versions compare number by number', () => {
  assert.equal(compare('0.10.0', '0.9.0'), 1);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
  assert.equal(compare('1.0', '1.0.1'), -1);
});

test('the plugin version is recorded when it changes, and keeps the moment it was first seen', () => {
  assert.deepEqual(pluginRecord(null, '0.4.4', 'now'), { version: '0.4.4', since: 'now' });
  assert.equal(pluginRecord({ version: '0.4.4', since: 'before' }, '0.4.4', 'now'), null, 'nothing to write');
  assert.deepEqual(pluginRecord({ version: '0.4.3', since: 'before' }, '0.4.4', 'now'), { version: '0.4.4', since: 'now' });
  assert.equal(pluginRecord(null, undefined), null, 'a plugin with no version writes nothing');
});
