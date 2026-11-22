import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { answered, closedDecision, DECISIONS, newDecision, readDecisions } from './decision.mjs';

const NOW = new Date('2026-11-21T16:05:09.000Z');

test('a decision has a title, a question, a few options on one line, and a context in the work folder', () => {
  const d = newDecision({ title: 'Keep the old format?', question: 'Two deposits change the export format.', options: ['Keep', 'Drop'], context: 'train-logs\\a.log' }, NOW);
  assert.match(d.id, /^20261121-160509-[0-9a-f]{4}$/);
  assert.deepEqual([d.by, d.options, d.context, d.answer, d.closed], ['factory', ['Keep', 'Drop'], 'train-logs/a.log', null, null]);
  assert.throws(() => newDecision({ title: 'a\nb', question: 'q' }), /title|titre/);
  assert.throws(() => newDecision({ title: 't', question: ' ' }), /question/);
  assert.throws(() => newDecision({ title: 't', question: 'q', options: ['a\nb'] }));
  assert.throws(() => newDecision({ title: 't', question: 'q', options: Array(7).fill('o') }));
  assert.throws(() => newDecision({ title: 't', question: 'q', context: '../secret' }));
  assert.throws(() => newDecision({ title: 't', question: 'q', context: join(tmpdir(), 'a.log') }));
});

test('the person answers with an option, a note, or both; the factory closes what it acted on', () => {
  const d = newDecision({ title: 't', question: 'q', options: ['Keep', 'Drop'] }, NOW);
  assert.deepEqual(answered(d, { choice: '2' }, NOW).answer, { choice: 'Drop', note: null, at: NOW.toISOString() });
  assert.deepEqual(answered(d, { note: ' Neither: ask the author. ' }, NOW).answer.note, 'Neither: ask the author.');
  assert.throws(() => answered(d, { choice: 3 }), /1|3/);
  assert.throws(() => answered(d, {}), /option|note/);
  assert.throws(() => closedDecision(d, {}), /answer|réponse/, 'nothing to act on yet');
  const done = closedDecision(answered(d, { choice: 1 }, NOW), { note: 'kept in train 12' }, NOW);
  assert.deepEqual(done.closed, { at: NOW.toISOString(), note: 'kept in train 12' });
  assert.throws(() => answered(done, { choice: 2 }), /closed|close/, 'an answer acted on stays as it was');
  const free = newDecision({ title: 't', question: 'Which name?' }, NOW);
  assert.throws(() => answered(free, { choice: 1 }), 'no options: the note says it');
  assert.equal(answered(free, { note: 'Warden' }, NOW).answer.choice, null);
});

test('the decisions are read from the work folder, newest first, each with its state', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'decisions-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.deepEqual(readDecisions(work), []);
  assert.deepEqual(readDecisions(null), []);
  mkdirSync(join(work, DECISIONS));
  const first = newDecision({ title: 'first', question: 'q', options: ['a'] }, new Date('2026-11-20T10:00:00Z'));
  const second = answered(newDecision({ title: 'second', question: 'q', options: ['a'] }, NOW), { choice: 1 }, NOW);
  for (const d of [first, second]) writeFileSync(join(work, DECISIONS, `${d.id}.json`), JSON.stringify(d));
  writeFileSync(join(work, DECISIONS, 'notes.json'), '{}');
  writeFileSync(join(work, DECISIONS, '20261121-000000-abcd.json'), '{ cut');
  assert.deepEqual(readDecisions(work).map((d) => [d.title, d.state]), [['second', 'answered'], ['first', 'open']]);
});
