import './git-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseBatch, MAX_BATCH, noteCommand, notYetTaken, readDeposit, readyDeposits, sortOut } from './train.mjs';

test('a deposit reads as the rule writes it, alignment and note included', () => {
  const text = 'tree    = E:\\trees\\project-e5\nbranch  = task-module\ntasks   = T36, T37\ncargo   = yes\ndocked  = 11/11 20:57\nnote    = 8 commits rebased\n';
  const d = readDeposit('agent-11.txt', text, 0, 2026);
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
  const d = (name, docked, extra = '') => readDeposit(name, `tree = a\nbranch = ${name}\ndocked = ${docked}\n${extra}`, 0, 2026);
  const ready = readyDeposits([d('c', '11/11 20:58'), d('a', '11/11 20:38'), d('b', '11/11 20:44', 'refused = conflict'), readDeposit('empty', 'branch = z\n')]);
  assert.deepEqual(ready.map((x) => x.name), ['a', 'c']);
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
