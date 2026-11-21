#!/usr/bin/env node
// The decisions the factory brings back to the person: a product choice it may not take, asked once, in a form the
// interface shows and answers. One JSON file per decision in the work folder (`decisions/`), never committed.
//
//   node scripts/warden/decision.mjs raise --title <text> --question <text> [--option <text>]... [--context <file>] [--agent <name>]
//   node scripts/warden/decision.mjs list [--open | --answered] [--json]
//   node scripts/warden/decision.mjs answer <id> [--choice <n>] [--note <text>]      the person
//   node scripts/warden/decision.mjs close <id> [--note <text>]                       the factory, once it acted
//
// A decision is open until the person answers it, answered until the factory closes it. The person may change an answer
// the factory has not acted on yet; a closed decision is kept as it was. `--context` names a file of the work folder (a
// train log, a refusal) that the interface opens next to the question.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory } from './config.mjs';
import { t } from './messages.mjs';
import { stationSlot } from './verify.mjs';

export const DECISIONS = 'decisions';
const ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const LIMITS = { title: 120, question: 4000, option: 200, options: 6, note: 4000 };

const values = (argv, flag) => argv.flatMap((word, i) => (word === flag && i + 1 < argv.length ? [argv[i + 1]] : []));
const value = (argv, flag) => values(argv, flag).at(-1) ?? null;
const oneLine = (text) => !/[\r\n]/.test(text);

export const decisionState = (d) => (d.closed ? 'closed' : d.answer ? 'answered' : 'open');

export function readDecisions(work) {
  const folder = work ? join(work, DECISIONS) : null;
  if (!folder || !existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => ID.test(f.replace(/\.json$/, '')) && f.endsWith('.json')).flatMap((f) => {
    try {
      const d = JSON.parse(readFileSync(join(folder, f), 'utf8'));
      return [{ ...d, state: decisionState(d) }];
    } catch {
      return [];
    }
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function write(work, decision) {
  const folder = join(work, DECISIONS);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${decision.id}.json`);
  const { state, ...kept } = decision;
  void state;
  writeFileSync(`${path}.tmp`, `${JSON.stringify(kept, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function find(work, id) {
  if (!ID.test(String(id ?? ''))) throw new Error(t('decision.bad_id', { id }));
  const found = readDecisions(work).find((d) => d.id === id);
  if (!found) throw new Error(t('decision.unknown', { id }));
  return found;
}

// A new decision, checked: a title and a question; options, each on one line; a context inside the work folder.
export function newDecision({ title, question, options = [], context = null, by = 'factory' }, now = new Date()) {
  if (!title?.trim() || !oneLine(title) || title.length > LIMITS.title) throw new Error(t('decision.bad_title', { max: LIMITS.title }));
  if (!question?.trim() || question.length > LIMITS.question) throw new Error(t('decision.bad_question', { max: LIMITS.question }));
  if (options.length > LIMITS.options || options.some((o) => !o.trim() || !oneLine(o) || o.length > LIMITS.option)) {
    throw new Error(t('decision.bad_options', { count: LIMITS.options, max: LIMITS.option }));
  }
  if (context && (isAbsolute(context) || normalize(context).split(/[\\/]/).includes('..'))) throw new Error(t('decision.bad_context'));
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return {
    id: `${stamp}-${randomBytes(2).toString('hex')}`, at: now.toISOString(), by, title: title.trim(), question: question.trim(),
    options: options.map((o) => o.trim()), context: context ? context.replaceAll('\\', '/') : null, answer: null, closed: null,
  };
}

// The person's answer: one of the options (1 for the first), a note, or both. Without options, or outside them, the
// note says it.
export function answered(decision, { choice = null, note = null }, now = new Date()) {
  if (decision.closed) throw new Error(t('decision.closed', { id: decision.id }));
  const text = note?.trim() || null;
  if (text && text.length > LIMITS.note) throw new Error(t('decision.bad_note', { max: LIMITS.note }));
  let picked = null;
  if (choice !== null && choice !== undefined && choice !== '') {
    const n = Number(choice);
    if (!Number.isInteger(n) || n < 1 || n > decision.options.length) throw new Error(t('decision.bad_choice', { count: decision.options.length }));
    picked = decision.options[n - 1];
  }
  if (!picked && !text) throw new Error(t('decision.empty_answer'));
  return { ...decision, answer: { choice: picked, note: text, at: now.toISOString() } };
}

export function closedDecision(decision, { note = null }, now = new Date()) {
  if (decision.closed) throw new Error(t('decision.closed', { id: decision.id }));
  if (!decision.answer) throw new Error(t('decision.not_answered', { id: decision.id }));
  return { ...decision, closed: { at: now.toISOString(), note: note?.trim() || null } };
}

function line(d) {
  const answer = d.answer ? ` → ${d.answer.choice ?? ''}${d.answer.choice && d.answer.note ? ' — ' : ''}${d.answer.note ?? ''}` : '';
  return `${d.id}  ${t(`decision.state.${d.state}`).padEnd(10)} ${d.title}${answer}`;
}

function main(argv, work) {
  const [command, ...rest] = argv;
  if (command === 'raise') {
    const decision = newDecision({
      title: value(rest, '--title'), question: value(rest, '--question'), options: values(rest, '--option'),
      context: value(rest, '--context'), by: value(rest, '--agent') ?? 'factory',
    });
    write(work, decision);
    console.log(t('decision.raised', { id: decision.id }));
    return true;
  }
  if (command === 'list') {
    const wanted = rest.includes('--open') ? 'open' : rest.includes('--answered') ? 'answered' : null;
    const list = readDecisions(work).filter((d) => !wanted || d.state === wanted);
    if (rest.includes('--json')) console.log(JSON.stringify(list, null, 2));
    else console.log(list.length ? list.map(line).join('\n') : t('decision.none'));
    return true;
  }
  if (command === 'answer') {
    const decision = answered(find(work, rest[0]), { choice: value(rest, '--choice'), note: value(rest, '--note') });
    write(work, decision);
    console.log(t('decision.answered', { id: decision.id, answer: decision.answer.choice ?? decision.answer.note }));
    return true;
  }
  if (command === 'close') {
    const decision = closedDecision(find(work, rest[0]), { note: value(rest, '--note') });
    write(work, decision);
    console.log(t('decision.closed_now', { id: decision.id }));
    return true;
  }
  console.error(t('decision.usage'));
  return false;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  try {
    const slot = stationSlot(readFactory());
    if (!slot) throw new Error(t('train.no_slot', { work: readFactory().work_dir }));
    process.exitCode = main(process.argv.slice(2), dirname(slot)) ? 0 : 1;
  } catch (error) {
    console.error(t('decision.stopped', { message: error.message }));
    process.exitCode = 1;
  }
}
