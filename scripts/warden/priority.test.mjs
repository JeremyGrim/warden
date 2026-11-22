import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { test } from 'node:test';

import { adjust, classify, projectTrees, restorePriorities } from './priority.mjs';

const TRAIN = process.platform === 'win32' ? 'C:\\repos\\project-factory' : '/repos/project-factory';
const AGENT = process.platform === 'win32' ? 'E:\\trees\\project-e3' : '/trees/project-e3';
const OTHERS = projectTrees([process.platform === 'win32' ? 'C:\\repos\\project' : '/repos/project', AGENT]);
const p = (pid, parent, name, line, executable = '') => ({ pid, parent, name, line, executable });

// A workstation: the train compiles (cargo, then rustc naming the tree), an agent too, an agent test runs from its
// target, and a cargo with no recognisable child or parent.
const STATION = [
  p(1, 0, 'node.exe', 'node scripts/warden/train.mjs run'),
  p(2, 1, 'cargo.exe', 'cargo clippy --workspace'),
  p(3, 2, 'rustc.exe', `rustc --out-dir ${TRAIN}/target/debug/deps`),
  p(10, 0, 'bash.exe', 'bash'),
  p(11, 10, 'cargo.exe', 'cargo test -p memory'),
  p(12, 11, 'rustc.exe', `rustc --out-dir ${AGENT}/target/debug/deps`),
  p(13, 11, 'all-1f2e.exe', 'all-1f2e.exe', `${AGENT}/target/debug/deps/all-1f2e.exe`),
  p(20, 0, 'cargo.exe', 'cargo build'),
  p(30, 0, 'Code.exe', `code ${AGENT}`),
];

test('each build ties to its tree, by its line, its children or its parents', () => {
  const k = classify(STATION, TRAIN, OTHERS);
  assert.equal(k.get(2), 'train', 'the train cargo, by its rustc');
  assert.equal(k.get(3), 'train');
  assert.equal(k.get(11), 'other', 'the agent cargo, by its rustc');
  assert.equal(k.get(12), 'other');
  assert.equal(k.get(13), 'other', 'a test launched from an agent target');
  assert.equal(k.get(20), '', 'unknown: it does not move');
  assert.ok(!k.has(30) && !k.has(1) && !k.has(10), 'what does not compile is not classified');
});

test('a tree is recognised by its whole path, never by a bare name', () => {
  const trees = projectTrees(['C:/repos/app', 'E:\\agents\\worker-7']);
  assert.ok(trees.test('rustc --out-dir C:\\repos\\app\\target\\debug'), 'the main root, either separator');
  assert.ok(trees.test('cargo --manifest-path=E:/agents/worker-7/Cargo.toml'), 'an agent tree named otherwise');
  assert.ok(!trees.test('rustc --out-dir C:\\repos\\webapp-x\\target'), 'a neighbouring name is not caught');
  assert.ok(!trees.test('rustc --out-dir C:\\repos\\app-old\\target'), 'nor a longer one');
  assert.ok(!projectTrees([]).test('anything'), 'no tree known: nothing is caught');
});

test('the train goes up, the agent down, the unknown stays; when the train ends, each gets its priority back', () => {
  const priorities = new Map([[2, 0], [3, 0], [11, 0], [12, 0], [13, 0], [20, 0]]);
  const read = (pid) => priorities.get(pid);
  const set = (pid, v) => {
    if (!priorities.has(pid)) throw new Error('ended');
    priorities.set(pid, v);
  };
  const kept = new Map();
  adjust(STATION, TRAIN, kept, { read, set, others: OTHERS });
  assert.equal(priorities.get(3), constants.priority.PRIORITY_ABOVE_NORMAL);
  assert.equal(priorities.get(12), constants.priority.PRIORITY_LOW);
  assert.equal(priorities.get(20), 0);
  adjust(STATION, TRAIN, kept, { read, set, others: OTHERS });
  assert.equal(kept.get(12), 0, 'the kept priority is the one before the first adjustment');
  priorities.delete(13);
  restorePriorities(kept, { set });
  assert.deepEqual([...priorities.values()], [0, 0, 0, 0, 0], 'a process that ended meanwhile is no trouble');
  assert.equal(kept.size, 0);
});
