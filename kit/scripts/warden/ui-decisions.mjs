// The decisions the factory brings back to the person (decision.mjs): a product choice it may not take. Open, the
// answer is the person's; answered, it waits for the factory, which acts on it at its next turn, and the person may
// still change it; closed, the factory acted and said so, and nothing changes it any more. The page answers through
// `decision.mjs answer`, like any gesture: its command, its tree, its output and its code.

import { t } from './ui-api.mjs';
import { absent, badge, box, boxRow, btn, field, fmtAge, fmtDate, h, kv } from './ui-dom.mjs';
import { cell, list } from './ui-list.mjs';

const NOTE_MAX = 4000;
// What the person chose and wrote without sending it yet, by project and decision: closing the drawer keeps it, an
// answer that ends with code 0 clears it.
const drafts = new Map();

export const DECISION_STATES = () => [
  { id: 'open', label: t('ui.decision.open'), tone: 'todo' },
  { id: 'answered', label: t('ui.decision.answered'), tone: 'wait' },
  { id: 'closed', label: t('ui.decision.closed'), tone: 'done' },
];

// The decision behind a case: the one its project gives, else the words of the case itself.
export function decisionOf(project, c) {
  const v = c.vars ?? {};
  return (project?.decisions ?? []).find((d) => d.id === v.id) ?? {
    id: v.id, at: c.since, by: v.by, title: v.title, question: v.question, options: v.options ?? [], context: v.context ?? null,
    answer: null, closed: null, state: 'open',
  };
}

// The command as ui.mjs shows it: the note is passed whole, but shown as "…".
const answerWords = (id, choice, note) => `node scripts/warden/decision.mjs answer ${id}${choice !== null ? ` --choice ${choice}` : ''}${note ? ' --note "…"' : ''}`;
const answerLine = (answer) => (answer ? [answer.choice, answer.note].filter(Boolean).join(' — ') : null);

// The question whole, its line breaks kept, and the options in their order (the first is 1).
export const questionNode = (text, extra = '') => h('span', { class: `cq pw ${extra}`.trim() }, text ?? '');
export const optionsNode = (options) => (options?.length ? h('ol', { class: 'opts' }, options.map((o) => h('li', null, o))) : null);

// The answer, in the drawer: one option or none, a note, and "Send" once one of them says something. Without options,
// the note is the answer. A decision already answered opens on its answer.
export function answerDecision(ctx, project, decision) {
  const key = `${project.path}|${decision.id}`;
  const options = decision.options ?? [];
  const given = decision.answer ?? null;
  const picked = given?.choice ? options.indexOf(given.choice) + 1 : 0;
  const draft = drafts.get(key) ?? { choice: picked > 0 ? picked : null, note: given?.note ?? '' };
  const title = t('ui.decision.answer_title', { title: decision.title ?? decision.id });
  const command = h('pre', { class: 'pre' });
  const send = btn(t('ui.decision.send'), () => submit(), { kind: 'p' });
  const note = h('textarea', {
    class: 'fta', rows: '5', maxlength: String(NOTE_MAX), spellcheck: 'true', 'aria-label': t('ui.decision.note'),
    placeholder: options.length ? t('ui.decision.note_hint') : null,
    on: { input: (e) => { draft.note = e.target.value; update(); } },
  });
  note.value = draft.note;
  const update = () => {
    drafts.set(key, draft);
    const text = draft.note.trim();
    send.disabled = draft.choice === null && !text;
    send.title = send.disabled ? t('ui.decision.send_needs') : '';
    command.textContent = answerWords(decision.id, draft.choice, text);
  };
  const submit = () => {
    const text = draft.note.trim();
    if (draft.choice === null && !text) return;
    ctx.gesture({
      project, gesture: 'decision.answer', args: { id: decision.id, choice: draft.choice, note: text }, title,
      command: answerWords(decision.id, draft.choice, text), cwd: project.path,
      done: (result) => {
        if (result?.code === 0) drafts.delete(key);
      },
    });
  };
  const name = `choice-${decision.id}`;
  const radios = [];
  const radio = (value, label) => {
    const input = h('input', { type: 'radio', name, checked: draft.choice === value, on: { change: () => { draft.choice = value; update(); } } });
    radios.push(input);
    return h('label', { class: 'opt' }, input, h('span', null, label));
  };
  const back = () => answerDecision(ctx, project, decision);
  const body = [
    field(t('ui.decision.question'), h('div', { class: 'qtext pw' }, decision.question ?? '')),
    h('div', { class: 'where' }, t('ui.decision.by', { by: decision.by ?? '?' }), ` · ${fmtDate(decision.at)} · `, h('span', { class: 'mono' }, `.work/decisions/${decision.id}.json`)),
    decision.context ? h('div', { class: 'dacts' }, btn(t('ui.decision.context'), () => ctx.file(project, decision.context, null, back), { small: true }), h('span', { class: 'mono hint' }, decision.context)) : null,
    given ? field(t('ui.decision.current'), h('div', { class: 'pw' }, answerLine(given), h('span', { class: 'hint' }, ` · ${fmtDate(given.at)}`))) : null,
    options.length
      ? field(t('ui.decision.options'), h('div', { class: 'optpick', role: 'radiogroup', 'aria-label': t('ui.decision.options') }, options.map((o, i) => radio(i + 1, `${i + 1}. ${o}`)), radio(null, t('ui.decision.no_option'))))
      : h('p', { class: 'hint' }, t('ui.decision.no_options')),
    field(t('ui.decision.note'), note),
    h('div', { class: 'dnote' }, t('ui.decision.form_note')),
    field(t('ui.drawer.command'), command, h('span', { class: 'where' }, t('ui.drawer.in'), ' ', h('span', { class: 'mono' }, project.path))),
  ];
  update();
  ctx.form({ title, body: body.filter(Boolean), foot: [send], focus: radios.find((r) => r.checked) ?? radios[0] ?? note });
}

function stateCell(x) {
  if (x.state === 'closed') return cell(null, t('ui.decision.closed_sub'), { tone: 'done', toneLabel: t('ui.decision.closed') });
  if (x.state === 'answered') return cell(null, t('ui.decision.answered_sub'), { tone: 'wait', toneLabel: t('ui.decision.answered') });
  return cell(null, t('ui.case.todo_sub'), { tone: 'todo', toneLabel: t('ui.decision.open') });
}

// The answer, and once closed, what the factory said of it.
function answerCell(x) {
  if (!x.answer) return cell('—', null, { quiet: true });
  const main = x.answer.choice ?? x.answer.note;
  const closing = x.closed
    ? (x.closed.note ? h('span', { class: 'cs why pw clamp' }, t('ui.decision.closed_note', { note: x.closed.note })) : null)
    : h('span', { class: 'cs' }, fmtDate(x.answer.at));
  return cell(null, null, { extra: [h('span', { class: 'ct pw clamp' }, main), x.answer.choice && x.answer.note ? h('span', { class: 'cs pw clamp' }, x.answer.note) : null, closing] });
}

function detail(ctx, d, x) {
  const file = `decisions/${x.id}.json`;
  return h('div', { class: 'detail' },
    kv([
      [t('ui.decision.question'), h('span', { class: 'pw' }, x.question ?? '—')],
      [t('ui.decision.options'), optionsNode(x.options) ?? t('ui.decision.no_options')],
      [t('ui.col.raised'), `${fmtDate(x.at)} · ${fmtAge(x.at)} · ${t('ui.decision.by', { by: x.by ?? '?' })}`],
      [t('ui.col.answer'), x.answer ? h('span', { class: 'pw' }, `${answerLine(x.answer)} · ${fmtDate(x.answer.at)}`) : null],
      x.closed ? [t('ui.decision.closed'), h('span', { class: 'pw' }, `${fmtDate(x.closed.at)}${x.closed.note ? ` · ${x.closed.note}` : ''}`)] : null,
      [t('ui.col.file'), `.work/${file}`, { mono: true }],
    ]),
    h('div', { class: 'dacts' },
      btn(t('ui.open.decision_file'), () => ctx.file(d, file), { small: true }),
      x.context ? btn(t('ui.decision.context'), () => ctx.file(d, x.context), { small: true }) : null,
      x.context ? h('span', { class: 'mono hint' }, x.context) : null));
}

// Every decision of the project, the newest first (decision.mjs sorts them): answer an open one, change the answer of
// an answered one; a closed one is read only.
export function renderDecisions(ctx, d) {
  if (d.absent?.decisions) return [box(boxRow(badge('unk', t('ui.absent_title')), h('span', { class: 'grow' }, t('ui.decision.absent')), absent(d.kit.version)))];
  const decisions = d.decisions ?? [];
  return [list(`decisions:${d.path}`, {
    cols: [t('ui.col.state'), t('ui.col.decision'), t('ui.col.answer'), t('ui.col.raised')], right: 3,
    grid: '150px minmax(0,1.5fr) minmax(0,1fr) 110px', minWidth: 940, actionsWidth: '190px',
    strip: DECISION_STATES(), stripLabel: t('ui.col.state'), search: t('ui.decision.search'), empty: t('ui.decision.empty'),
    cap: t('ui.decision.cap'),
    rows: decisions.map((x) => {
      const actions = [];
      if (x.state === 'open') actions.push({ label: t('ui.decision.answer'), primary: true, run: () => answerDecision(ctx, d, x) });
      if (x.state === 'answered') actions.push({ label: t('ui.decision.change'), run: () => answerDecision(ctx, d, x) });
      if (x.context) actions.push({ label: t('ui.decision.context'), run: () => ctx.file(d, x.context) });
      return {
        id: x.id, st: x.state,
        search: [x.title, x.question, ...(x.options ?? []), x.by, x.answer?.choice, x.answer?.note, x.closed?.note].filter(Boolean).join(' '),
        cells: [
          stateCell(x),
          cell(x.title, null, { strong: true, extra: [questionNode(x.question, 'clamp'), h('span', { class: 'cs' }, t('ui.decision.by', { by: x.by ?? '?' }))] }),
          answerCell(x),
          cell(fmtDate(x.at), null, { right: true }),
        ],
        actions,
        detail: () => detail(ctx, d, x),
      };
    }),
  })];
}
