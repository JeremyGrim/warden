import './git-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ABANDONED_MS, holder, refresh, release, releaseOnArrival, slotFolder, take } from './slot.mjs';

function tray(t) {
  const folder = mkdtempSync(join(tmpdir(), 'slot-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// A clock moved by hand: waiting takes no real time.
function clock(start = Date.parse('2026-11-11T19:00:00Z')) {
  let time = start;
  return { now: () => time, sleep: async (ms) => { time += ms; }, advance: (ms) => { time += ms; } };
}

test('the slot lives in the work folder of the root, or where this clone says', (t) => {
  const root = tray(t);
  mkdirSync(join(root, '.work'));
  assert.equal(slotFolder({ commonGitDir: join(root, '.git') }), join(root, '.work', 'push-slot'));
  assert.equal(slotFolder({ configured: 'X:/elsewhere/slot', commonGitDir: join(root, '.git') }), 'X:/elsewhere/slot');
  assert.equal(slotFolder({ commonGitDir: join(tray(t), '.git') }), null, 'a separate clone, with no work folder and no setting');
  mkdirSync(join(root, '.travail'));
  assert.equal(slotFolder({ commonGitDir: join(root, '.git'), workDir: '.travail', name: 'creneau' }), join(root, '.travail', 'creneau'), 'the work folder and the name come from the factory');
});

test('a free slot is taken, says who holds it, and is only given back by its tree', async (t) => {
  const folder = join(tray(t), 'push-slot');
  const c = clock();
  assert.deepEqual(await take({ folder, tree: 'E:/e2', commit: 'abc1234', ...c }), { taken: true });
  const held = readFileSync(join(folder, 'held-by.txt'), 'utf8');
  assert.match(held, /^tree: E:\/e2$/m);
  assert.match(held, /^commit: abc1234$/m);
  assert.deepEqual({ ...holder(folder), since: undefined }, { tree: 'E:/e2', commit: 'abc1234', since: undefined });
  release(folder, 'E:/e1');
  assert.ok(existsSync(folder), 'another tree does not give the slot back');
  release(folder, 'E:/e2');
  assert.ok(!existsSync(folder));
  assert.equal(holder(folder), null);
});

test('a slot held by another tree makes the hook wait, then it is taken when freed', async (t) => {
  const folder = join(tray(t), 'push-slot');
  const c = clock();
  await take({ folder, tree: 'E:/e1', commit: 'aaa', ...c });
  const said = [];
  let rounds = 0;
  const sleep = async (ms) => { c.advance(ms); rounds += 1; if (rounds === 3) release(folder, 'E:/e1'); };
  const got = await take({ folder, tree: 'E:/e2', commit: 'bbb', now: c.now, sleep, say: (x) => said.push(x) });
  assert.deepEqual(got, { taken: true });
  assert.equal(rounds, 3);
  assert.equal(said.length, 1, 'the wait is said once');
  assert.match(said[0], /tree: E:\/e1/);
});

test('a bounded wait refuses and says who holds the slot', async (t) => {
  const folder = join(tray(t), 'push-slot');
  const c = clock();
  await take({ folder, tree: 'E:/e1', commit: 'aaa', ...c });
  const got = await take({ folder, tree: 'E:/e2', commit: 'bbb', ...c, maxWait: 5 * 60 * 1000 });
  assert.equal(got.taken, false);
  assert.match(got.reason, /slot held: .*tree: E:\/e1/);
});

test('a slot of this tree is taken back, an abandoned one too, and the takeover is logged', async (t) => {
  const work = tray(t);
  const folder = join(work, 'push-slot');
  const log = join(work, 'log.md');
  writeFileSync(log, '# Log\n');
  const c = clock();
  await take({ folder, tree: 'E:/e2', commit: 'old', ...c });
  const back = await take({ folder, tree: 'E:/e2', commit: 'new', ...c });
  assert.equal(back.taken, true, 'an interrupted hook of this tree does not wait for itself');
  assert.match(readFileSync(join(folder, 'held-by.txt'), 'utf8'), /^commit: new$/m);

  c.advance(ABANDONED_MS + 1000);
  const abandoned = await take({ folder, tree: 'E:/e3', commit: 'ccc', ...c, log });
  assert.equal(abandoned.taken, true);
  assert.match(abandoned.takenBack, /tree: E:\/e2/);
  assert.match(readFileSync(log, 'utf8'), /push slot abandoned, taken back by the hook of E:\/e3/);
});

test('a slot made by hand, with no held-by.txt, counts from the folder date', async (t) => {
  const folder = join(tray(t), 'push-slot');
  mkdirSync(folder);
  const c = clock(Date.now());
  const got = await take({ folder, tree: 'E:/e2', commit: 'x', ...c, maxWait: 60 * 1000 });
  assert.equal(got.taken, false, 'brand new: it is respected');
  assert.match(got.reason, /no held-by\.txt/);
});

test('the slot is given back when the main branch carries the commit, or after the delay', async (t) => {
  const folder = join(tray(t), 'push-slot');
  const c = clock();
  await take({ folder, tree: 'E:/e2', commit: 'c1', ...c });
  const heads = ['before', 'before', 'c1'];
  await releaseOnArrival({ folder, tree: 'E:/e2', commit: 'c1', remoteHead: () => heads.shift(), ...c });
  assert.ok(!existsSync(folder), 'given back as soon as the branch carries the commit');

  await take({ folder, tree: 'E:/e2', commit: 'c2', ...c });
  const start = c.now();
  await releaseOnArrival({ folder, tree: 'E:/e2', commit: 'c2', remoteHead: () => 'other', ...c, delay: 60 * 1000 });
  assert.ok(!existsSync(folder), 'a push that failed after the hook does not keep the slot');
  assert.ok(c.now() - start >= 60 * 1000);
});

test('the holder refreshes its time, another tree cannot', async (t) => {
  const folder = join(tray(t), 'push-slot');
  const c = clock();
  await take({ folder, tree: 'E:/e2', commit: 'train', ...c });
  c.advance(ABANDONED_MS - 60 * 1000);
  assert.equal(refresh(folder, 'E:/e1', c.now()), false);
  assert.equal(refresh(folder, 'E:/e2', c.now()), true);
  c.advance(2 * 60 * 1000);
  const other = await take({ folder, tree: 'E:/e1', commit: 'x', ...c, maxWait: 0 });
  assert.equal(other.taken, false, 'refreshed, it does not look abandoned');
});
