import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { clearRefusal, continuedHalt, dockKey, haltHolds, isRefused, readDeposit, readDock, readyDeposits, whileHalted, writeRefusal } from './dock.mjs';
import { FACTORY_DEFAULTS } from './config.mjs';

const TRAIN = FACTORY_DEFAULTS.train;

test('a refused deposit leaves again once it names another commit, with no line to erase', () => {
  const deposit = (commit, refusal) => ({ ...readDeposit('a.txt', `tree = t\nbranch = a\ncommit = ${commit}\nrefused = Rules fails\n`), refusal });
  const refused = { class: 'violation', commit: 'abc1234def5678' };
  assert.equal(isRefused(deposit('abc1234', refused)), true, 'the same commit, abbreviated: still refused');
  assert.equal(isRefused(deposit('def9876', refused)), false, 'a new commit: ready again');
  assert.deepEqual(readyDeposits([deposit('def9876', refused)]).map((d) => d.name), ['a.txt']);
  assert.equal(isRefused(readDeposit('b.txt', 'tree = t\nbranch = b\nrefused = conflict\n')), true, 'a refused line before 0.4.0 holds until removed');
  assert.equal(isRefused({ ...readDeposit('c.txt', 'tree = t\nbranch = c\n'), refusal: { commit: 'abc1234' } }), true, 'no commit named: the refusal holds');
});

test('the train writes the refusal beside the deposit, and the dock reads it back', (t) => {
  const dock = mkdtempSync(join(tmpdir(), 'dock-'));
  t.after(() => rmSync(dock, { recursive: true, force: true }));
  writeFileSync(join(dock, 'agent-a.txt'), 'tree = /t\nbranch = a\ncommit = abc1234\n');
  writeRefusal(dock, 'agent-a.txt', { class: 'defect', commit: 'abc1234ffff', next: 'fix_and_redock' }, 'Tests fail: gap (train of 10:00)');
  const [d] = readDock(dock);
  assert.equal(d.refusal.class, 'defect');
  assert.match(readFileSync(join(dock, 'agent-a.txt'), 'utf8'), /^refused = Tests fail: gap/m);
  assert.equal(isRefused(d), true);
  clearRefusal(dock, 'agent-a.txt');
  assert.equal(readDock(dock)[0].refusal, null);
});

test('a red main branch holds the train until the main branch or the dock changes', () => {
  const halt = { class: 'baseline', main: 'm1', dock: 'a.txt@c1', at: new Date(0).toISOString() };
  assert.equal(haltHolds(halt, { main: 'm1', dock: 'a.txt@c1' }), true);
  assert.equal(haltHolds(halt, { main: 'm2', dock: 'a.txt@c1' }), false, 'a new commit of the main branch');
  assert.equal(haltHolds(halt, { main: 'm1', dock: 'a.txt@c1,repair.txt@r1' }), false, 'a repair docked');
  assert.equal(haltHolds({ ...halt, class: 'transient' }, { main: 'm1', dock: 'a.txt@c1' }), false, 'an incident is tried again');
  assert.equal(dockKey([{ name: 'b.txt', commit: 'c2' }, { name: 'a.txt', commit: 'c1' }]), 'a.txt@c1,b.txt@c2');
});

test('watch waits for what can lift the halt, and says it once past the threshold', () => {
  const at = Date.UTC(2026, 10, 21, 10, 0);
  const minutes = (n) => at + n * 60000;
  const baseline = { class: 'baseline', main: 'm1', dock: 'k', at: new Date(at).toISOString() };
  assert.equal(whileHalted(null, { train: TRAIN }), 'go');
  assert.equal(whileHalted(baseline, { main: 'm1', dock: 'k', now: minutes(5), train: TRAIN }), 'wait');
  assert.equal(whileHalted(baseline, { main: 'm2', dock: 'k', now: minutes(5), train: TRAIN }), 'go');
  assert.equal(whileHalted(baseline, { main: 'm1', dock: 'k', now: minutes(31), train: TRAIN }), 'notice');
  assert.equal(whileHalted({ ...baseline, noticed: true }, { main: 'm1', dock: 'k', now: minutes(90), train: TRAIN }), 'wait', 'said once');
  const memory = { class: 'transient', reason: 'memory', dock: 'k', at: new Date(at).toISOString() };
  assert.equal(whileHalted(memory, { dock: 'k', freeGib: 3, now: minutes(1), train: TRAIN }), 'wait');
  assert.equal(whileHalted(memory, { dock: 'k', freeGib: 12, now: minutes(1), train: TRAIN }), 'go');
  const incident = { class: 'transient', dock: 'k', at: new Date(at).toISOString() };
  assert.equal(whileHalted(incident, { dock: 'k', now: minutes(5), train: TRAIN }), 'wait');
  assert.equal(whileHalted(incident, { dock: 'k', now: minutes(11), train: TRAIN }), 'go', 'retry_minutes passed');
});

test('an incident that outlives its retries keeps its beginning, and is said once past the threshold', () => {
  const at = Date.UTC(2026, 10, 21, 10, 0);
  const moment = (n) => new Date(at + n * 60000).toISOString();
  const missing = { class: 'incomplete', reason: null, step: 'Verification of the changed files', cause: 'npm advisories could not run', dock: 'k' };
  const first = continuedHalt(null, missing, moment(0));
  assert.deepEqual([first.at, first.last, first.noticed], [moment(0), moment(0), false]);
  // Retried every 10 minutes, it halts again on the same step: the beginning stays, the latest train moves.
  const third = continuedHalt(continuedHalt(first, missing, moment(10)), missing, moment(20));
  assert.deepEqual([third.at, third.last, third.noticed], [moment(0), moment(20), false]);
  const now = (n) => at + n * 60000;
  assert.equal(whileHalted(third, { dock: 'k', now: now(25), train: TRAIN }), 'wait', 'retried 5 minutes ago, begun 25 minutes ago');
  assert.equal(whileHalted(third, { dock: 'k', now: now(31), train: TRAIN }), 'go', 'retry_minutes passed since the latest train');
  const fourth = continuedHalt(third, missing, moment(31));
  assert.equal(whileHalted(fourth, { dock: 'k', now: now(32), train: TRAIN }), 'notice', '30 minutes since it began');
  const said = continuedHalt({ ...fourth, noticed: true }, missing, moment(42));
  assert.deepEqual([said.at, said.noticed], [moment(0), true], 'said once, even when it halts again');
  assert.equal(whileHalted(said, { dock: 'k', now: now(45), train: TRAIN }), 'wait');
  // Another halt starts over: another step, another class, or the memory.
  assert.equal(continuedHalt(said, { ...missing, step: 'Build' }, moment(50)).at, moment(50));
  assert.equal(continuedHalt(said, { ...missing, class: 'transient' }, moment(50)).noticed, false);
  assert.equal(continuedHalt(said, { ...missing, class: 'transient', reason: 'memory', step: null }, moment(50)).at, moment(50));
});
