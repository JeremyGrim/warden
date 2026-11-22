import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkConfig } from './schema.mjs';

const KIT_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config');
const errors = (problems) => problems.filter((p) => p.level === 'error').map((p) => p.path);
const warnings = (problems) => problems.filter((p) => p.level === 'warning').map((p) => p.path);

test('the configuration the kit installs is valid as it is', () => {
  for (const name of ['factory', 'rules', 'disk']) assert.deepEqual(checkConfig(name, readFileSync(join(KIT_CONFIG, `${name}.json`), 'utf8')), [], name);
});

test('a wrong type blocks, a key the kit does not read is said, a comment is free', () => {
  const factory = {
    train: { max_batch: 0, trian: 1, retry_minutes: 5 },
    fixes: ['version', 'push'],
    verify: { steps: [{ title: 'lint', command: [] }, { command: ['npm', 'test'] }], when_missing: 'skip', transient_patterns: ['('] },
    version: { line: 0.4 },
    release: { artifacts: ['dist/*'] },
    $comment: 'the person\'s note',
  };
  const problems = checkConfig('factory', JSON.stringify(factory));
  assert.deepEqual(errors(problems).sort(), [
    'fixes[1]', 'release.build', 'train.max_batch', 'verify.steps[0].command', 'verify.steps[1].title', 'verify.transient_patterns[0]', 'verify.when_missing', 'version.line',
  ]);
  assert.deepEqual(warnings(problems), ['train.trian']);
  assert.equal(problems[0].level, 'error', 'errors first');
});

test('what cannot be read is one error, and the rules hold together', () => {
  const broken = checkConfig('rules', '{ "max_lines": 700, }');
  assert.equal(broken.length, 1);
  assert.equal(broken[0].path, '/');
  assert.deepEqual(errors(checkConfig('rules', '[]')), ['/']);
  assert.deepEqual(errors(checkConfig('rules', '{ "max_lines": 600, "warn_lines": 650 }')), ['warn_lines']);
  assert.deepEqual(errors(checkConfig('rules', '{ "secrets": [{ "name": "key", "pattern": "[" }], "size_exceptions": { "a.lock": 0 } }')).sort(), ['secrets[0].pattern', 'size_exceptions.a.lock']);
});

test('the budgets of the disk, and what belongs to one workstation only', () => {
  assert.deepEqual(errors(checkConfig('disk', '{ "max_worktrees": -1, "min_free_gib": "60" }')).sort(), ['max_worktrees', 'min_free_gib']);
  assert.deepEqual(warnings(checkConfig('disk', '{ "roots": ["/elsewhere"], "shared_caches": [{ "path": "/cache", "max_gib": 50 }] }')), ['roots', 'shared_caches']);
});
