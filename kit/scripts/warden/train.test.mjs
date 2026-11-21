import './git-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDeposit, readyDeposits } from './dock.mjs';
import { firstError } from './outcome.mjs';
import { chooseBatch, haltClass, jobsFor, MAX_BATCH, noteCommand, notYetTaken, sortOut } from './train.mjs';

const NOW = new Date(2026, 10, 12, 9, 0).getTime();

test('a deposit reads as the rule writes it, alignment and note included', () => {
  const text = 'tree    = E:\\trees\\project-e5\nbranch  = task-module\ncommit  = 1fec8b2\ntasks   = T36, T37\ncargo   = yes\ndocked  = 11/11 20:57\nnote    = 8 commits rebased\n';
  const d = readDeposit('agent-11.txt', text, 0, NOW);
  assert.equal(d.commit, '1fec8b2', 'the docked commit');
  assert.equal(d.priority, null);
  assert.equal(d.tree, 'E:\\trees\\project-e5');
  assert.equal(d.branch, 'task-module');
  assert.deepEqual(d.tasks, ['T36', 'T37']);
  assert.equal(d.refused, null);
  assert.equal(d.moment, new Date(2026, 10, 11, 20, 57).getTime());
  assert.equal(readDeposit('x.txt', 'tree = a\nbranch = b\n', 1234).moment, 1234, 'no time: the file date');
  assert.deepEqual(d.scenarios, [], 'no scenario, nothing to play');
  assert.deepEqual(readDeposit('y.txt', 'scenario = screen-links, journal-filters\n').scenarios, ['screen-links', 'journal-filters']);
});

test('a train takes a batch of four at most, in order, and fills it when a branch conflicts', () => {
  const stacked = [];
  const stack = (d) => (d === 'b' ? 'conflict' : (stacked.push(d), null));
  const { batch, conflicts } = chooseBatch(['a', 'b', 'c', 'd', 'e', 'f', 'g'], stack);
  assert.equal(MAX_BATCH, 4);
  assert.deepEqual(batch, ['a', 'c', 'd', 'e']);
  assert.deepEqual(conflicts, [{ deposit: 'b', cause: 'conflict' }]);
  assert.deepEqual(stacked, ['a', 'c', 'd', 'e'], 'f and g are untouched: they wait for the next train');
  assert.deepEqual(chooseBatch(['a', 'b', 'c'], () => null, 2).batch, ['a', 'b']);
});

test('a branch stacked on another deposit only brings its own commits', () => {
  const cherry = '- aaa111\n- bbb222\n+ ccc333\n+ ddd444\n';
  assert.deepEqual(notYetTaken(['aaa111', 'bbb222', 'ccc333', 'ddd444'], cherry), ['ccc333', 'ddd444'], 'the commits of the deposit below are already in the train');
  assert.deepEqual(notYetTaken(['ccc333'], ''), ['ccc333'], 'nothing in common: everything stacks');
  assert.deepEqual(notYetTaken(['aaa111'], '- aaa111'), [], 'everything already taken: nothing to stack');
});

test('the train leaves in docking order, without the refused or incomplete ones', () => {
  const d = (name, docked, extra = '') => readDeposit(name, `tree = a\nbranch = ${name}\ndocked = ${docked}\n${extra}`, 0, NOW);
  const ready = readyDeposits([d('c', '11/11 20:58'), d('a', '11/11 20:38'), d('b', '11/11 20:44', 'refused = conflict'), readDeposit('empty', 'branch = z\n')]);
  assert.deepEqual(ready.map((x) => x.name), ['a', 'c']);
});

test('a priority set by the person leaves first, the lowest number first; the others keep arrival order', () => {
  const d = (name, docked, extra = '') => readDeposit(name, `tree = a\nbranch = ${name}\ndocked = ${docked}\n${extra}`, 0, NOW);
  const ready = readyDeposits([d('a', '11/11 20:38'), d('b', '11/11 20:44', 'priority = 2'), d('c', '11/11 20:58', 'priority = 1'), d('d', '11/11 19:00')]);
  assert.deepEqual(ready.map((x) => x.name), ['c', 'b', 'd', 'a']);
});

test('a deposit of 31 December read on 1 January stays first: the docking year is the closest one', () => {
  const newYear = new Date(2027, 0, 1, 0, 30).getTime();
  const late = readDeposit('late', 'tree = a\nbranch = late\ndocked = 31/12 23:50\n', 0, newYear);
  const early = readDeposit('early', 'tree = a\nbranch = early\ndocked = 01/01 00:10\n', 0, newYear);
  assert.equal(late.moment, new Date(2026, 11, 31, 23, 50).getTime());
  assert.deepEqual(readyDeposits([early, late]).map((x) => x.name), ['late', 'early']);
});

test('the factory branch is always taken, and never counts in the batch', () => {
  const own = { name: 'release', own: true };
  const { batch } = chooseBatch(['a', 'b', 'c', 'd', 'e', own], () => null);
  assert.deepEqual(batch, ['a', 'b', 'c', 'd', own], 'a full dock does not leave the release version waiting');
});

test('a failure names its step and its first error', () => {
  const rust = 'Compiling engine\nerror[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:3:5\nerror: could not compile `engine`\n✖ Clippy, no warnings: failed (12 s).\n';
  assert.equal(firstError(rust), '✖ Clippy, no warnings: failed (12 s). — error[E0425]: cannot find value `x` in this scope');
  assert.equal(firstError('Rules: 1 finding(s)\n  [lines] crates/big.rs: 701 lines for 700 at most\n'), '[lines] crates/big.rs: 701 lines for 700 at most');
  assert.equal(firstError('running 2 tests\ntest a::b ... FAILED\n'), 'test a::b ... FAILED');
  const node = '▶ Project tests\n✖ gap (1.1ms)\n✔ sum (0.5ms)\n✖ failing tests:\n✖ gap (1.1ms)\n[ELIFECYCLE] Test failed. See above for more details.\n✖ Project tests: failed (1 s).\n';
  assert.equal(firstError(node), '✖ Project tests: failed (1 s). — ✖ gap (1.1ms)', 'the failed test, not the package manager line');
  assert.equal(firstError('something\nlast words\n'), 'last words', 'nothing recognised: the last line');
  assert.ok(firstError(`error: ${'x'.repeat(400)}`).length <= 200);
});

test('the build jobs are bounded by the memory free to commit', () => {
  const gib = 1024 ** 3;
  assert.equal(jobsFor(64 * gib, 16, 2), 16, 'room for every core');
  assert.equal(jobsFor(10 * gib, 16, 2), 5);
  assert.equal(jobsFor(1 * gib, 16, 2), 1, 'never less than one');
  assert.equal(jobsFor(null, 16, 2), 16, 'unknown memory: every core');
});

test('everything passes: one verification', async () => {
  const attempts = [];
  const r = await sortOut(['a', 'b', 'c', 'd'], async (list) => { attempts.push(list.join('')); return true; });
  assert.deepEqual(r, { up: ['a', 'b', 'c', 'd'], out: [] });
  assert.deepEqual(attempts, ['abcd']);
});

test('a culprit is found by halves, goes out, and the rest goes up in order', async () => {
  const attempts = [];
  const r = await sortOut(['a', 'b', 'c', 'd'], async (list) => { attempts.push(list.join('')); return !list.includes('c'); });
  assert.deepEqual(r, { up: ['a', 'b', 'd'], out: ['c'] });
  assert.deepEqual(attempts, ['abcd', 'ab', 'abc', 'abd'], 'each trial carries what is already kept, and nothing is verified twice');
});

test('two culprits, and a branch that only breaks with another', async () => {
  const r = await sortOut(['a', 'b', 'c', 'd', 'e'], async (list) => !list.includes('b') && !list.includes('e'));
  assert.deepEqual(r, { up: ['a', 'c', 'd'], out: ['b', 'e'] });
  const together = await sortOut(['a', 'b'], async (list) => !(list.includes('a') && list.includes('b')));
  assert.deepEqual(together, { up: ['a'], out: ['b'] }, 'the first to arrive keeps its place');
});

test('a single failing deposit goes out with no other trial', async () => {
  let n = 0;
  const r = await sortOut(['a'], async () => { n += 1; return false; });
  assert.deepEqual(r, { up: [], out: ['a'] });
  assert.equal(n, 1);
});

test('a note follows the tracking contract, through Node for a script, as is otherwise', () => {
  assert.deepEqual(noteCommand('/tools/task.mjs', 'factory', 'T1', 'up'), ['node', '/tools/task.mjs', 'note', 'T1', 'up', '--agent', 'factory']);
  assert.deepEqual(noteCommand('task', 'factory', 'T1', 'up'), ['task', 'note', 'T1', 'up', '--agent', 'factory']);
});

test('a failure of the main branch alone halts the train with a class, and blames nobody', () => {
  assert.equal(haltClass('defect'), 'baseline');
  assert.equal(haltClass('violation'), 'baseline');
  assert.equal(haltClass('transient'), 'transient');
  assert.equal(haltClass('incomplete'), 'incomplete');
});
