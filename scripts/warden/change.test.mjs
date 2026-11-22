import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fileName, readText } from './change.mjs';

test('a change names one of the three project files, whatever its slashes', () => {
  assert.equal(fileName('config\\factory.json'), 'config/factory.json');
  assert.equal(fileName('config/rules.json'), 'config/rules.json');
  for (const file of ['config/disk.local.json', '../config/disk.json', 'package.json', undefined]) assert.throws(() => fileName(file), /config/);
});

test('the new text comes from a file or the standard input, ends with one line break, and stays small', (t) => {
  const tray = mkdtempSync(join(tmpdir(), 'change-'));
  t.after(() => rmSync(tray, { recursive: true, force: true }));
  writeFileSync(join(tray, 'disk.json'), '{ "max_worktrees": 3 }\n\n\n');
  assert.equal(readText(['config/disk.json', '--from', join(tray, 'disk.json')]), '{ "max_worktrees": 3 }\n');
  assert.equal(readText(['config/disk.json'], () => '{}'), '{}\n');
  assert.throws(() => readText(['config/disk.json'], () => ' '.repeat(256 * 1024 + 1)), /256/);
});
