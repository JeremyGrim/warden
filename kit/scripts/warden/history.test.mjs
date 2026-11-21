import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendHistory, readHistory, summarize } from './history.mjs';

const NOW = Date.UTC(2026, 10, 21, 12, 0);
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();

test('the history sums up integrations, refusals by class and the cost of verifying', () => {
  const entries = [
    { kind: 'train', at: at(30), trials: 3, steps: { Rules: 1, 'Script guards': 4, Build: 60 }, up: [{ name: 'a', waited_s: 600 }, { name: 'b', waited_s: 1200 }], out: [{ name: 'c', class: 'defect' }], halted: null, seconds: 90 },
    { kind: 'train', at: at(2), trials: 1, steps: { Rules: 1, Build: 30 }, up: [{ name: 'd', waited_s: 300 }], out: [], halted: null, not_run: ['npm advisories'], seconds: 40 },
    { kind: 'train', at: at(1), trials: 2, steps: {}, up: [], out: [{ name: 'e', class: 'conflict' }], halted: 'baseline', seconds: 20 },
    { kind: 'push', at: at(3), result: 'fail', class: 'defect', seconds: 12 },
    { kind: 'push', at: at(3), result: 'incomplete', not_run: ['npm advisories'], seconds: 4 },
    { kind: 'guards', at: at(3), kit: 'cached', seconds: 1 },
    { kind: 'guards', at: at(4), kit: 'ran', seconds: 21 },
    { kind: 'release', at: at(5) },
    { kind: 'train', at: at(24 * 30), up: [{ name: 'old', waited_s: 1 }], seconds: 1 },
  ];
  const s = summarize(entries, { days: 7, now: NOW });
  assert.equal(s.trains, 3, 'the month-old train is out of the window');
  assert.equal(s.integrations, 3);
  assert.deepEqual(s.refusals, { defect: 1, conflict: 1 });
  assert.deepEqual(s.halts, { baseline: 1 });
  assert.equal(s.trials_per_train, 2);
  assert.equal(s.dock_to_main_minutes.median, 10);
  assert.equal(s.dock_to_main_minutes.max, 20);
  assert.equal(s.verification_seconds_per_integration, 50);
  assert.equal(s.costly_steps[0].title, 'Build');
  assert.deepEqual(s.pushes, { count: 2, failed: { defect: 1 }, incomplete: 1, seconds_mean: 8 });
  assert.deepEqual(s.guards, { runs: 2, kit_cached: 1, seconds_mean: 11 });
  assert.deepEqual(s.not_run, { 'npm advisories': 2 });
  assert.equal(s.releases, 1);
});

test('the history only grows by lines, skips a cut line, and forgets what is past its retention', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'history-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'warden-history.jsonl');
  appendHistory(file, { kind: 'push', result: 'pass' }, { now: NOW });
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"kind":"pu`);
  assert.equal(readHistory(file).length, 1, 'the cut line is skipped');
  writeFileSync(file, '');
  const old = JSON.stringify({ kind: 'train', at: at(24 * 200), padding: 'x'.repeat(600) });
  writeFileSync(file, `${old}\n`.repeat(900));
  appendHistory(file, { kind: 'push', result: 'pass' }, { now: NOW, keepDays: 90 });
  assert.deepEqual(readHistory(file).map((e) => e.kind), ['push'], 'past 512 KiB, what is older than the retention goes');
  appendHistory(null, { kind: 'push' });
});
