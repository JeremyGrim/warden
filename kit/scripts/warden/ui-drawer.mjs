// The command drawer: every gesture shows its command, the tree it runs in, its output and its exit code, then the
// view is read again. A non-zero code is never dressed as a success. Files open here too, read only.

import { errorText, get, post, t } from './ui-api.mjs';
import { badge, btn, fmtClock, h, icon } from './ui-dom.mjs';

const $ = (id) => document.getElementById(id);
let hooks = { reread: async () => {}, toast: () => {} };
let current = null;
let seq = 0;
let lastFocus = null;

export function setupDrawer(given) {
  hooks = given;
  const close = $('drawer-close');
  close.replaceChildren(icon('close', 14));
  close.setAttribute('aria-label', t('ui.drawer.close'));
  close.setAttribute('title', t('ui.drawer.close'));
  close.addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeDrawer();
  });
}

export const isOpen = () => $('drawer').classList.contains('open');

function openDrawer() {
  if (!isOpen()) lastFocus = document.activeElement;
  $('drawer').classList.add('open');
  $('drawer').removeAttribute('aria-hidden');
  $('scrim').classList.add('open');
  $('drawer-close').focus({ preventScroll: true });
}

export function closeDrawer() {
  current = null;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

const label = (text) => h('span', { class: 'dl' }, text);
const pre = (text) => h('pre', { class: 'pre' }, text);

function stages(phase, withReread = true) {
  const steps = [['sent', t('ui.run.sent')], ['reported', t('ui.run.reported')]];
  if (withReread) steps.push(['reread', t('ui.run.reread')]);
  const reached = steps.findIndex(([id]) => id === phase);
  return h('div', { class: 'stages' }, steps.map(([, name], i) => h('span', { class: 'stage', 'data-on': i <= reached ? '1' : '0' }, h('i', { 'aria-hidden': 'true' }), name)));
}

function exitLine(result, error) {
  if (error) return h('div', { class: 'exit' }, badge('unk', error.status === 409 || error.status === 400 ? t('ui.run.refused') : t('ui.run.no_answer')), h('span', null, errorText(error)));
  const ok = result.code === 0;
  return h('div', { class: 'exit' }, badge(ok ? 'ok' : 'halt', ok ? t('ui.run.done') : t('ui.run.failed')), h('span', null, t('ui.run.code', { code: result.code })));
}

function paint() {
  const view = current;
  if (!view) return;
  $('drawer-title').replaceChildren(view.title, view.gapNode ?? '');
  const body = [];
  const foot = [btn(t('ui.drawer.close'), closeDrawer)];
  if (view.kind === 'file') {
    body.push(h('div', { class: 'dsec' }, label(t('ui.col.file')), pre(view.file)));
    body.push(h('div', { class: 'dsec' }, label(t('ui.drawer.content')),
      view.phase === 'sent' ? h('div', { class: 'pre wait' }, h('div', { class: 'sk' }), h('div', { class: 'sk' })) : null,
      view.error ? h('div', { class: 'exit' }, badge('unk', t('ui.drawer.unreadable')), h('span', null, errorText(view.error))) : null,
      view.answer ? pre(view.answer.content || t('ui.drawer.empty_file')) : null,
      view.answer?.truncated ? h('p', { class: 'muted' }, t('ui.drawer.truncated')) : null));
  } else {
    const shown = view.result?.command ?? view.command;
    const where = view.kind === 'station' ? t('ui.drawer.where_station') : view.result?.cwd ?? view.cwd;
    body.push(h('div', { class: 'dsec' }, label(t('ui.drawer.command')), pre(shown), where ? h('span', { class: 'where' }, t('ui.drawer.in'), ' ', h('span', { class: 'mono' }, where)) : null));
    if (view.option) {
      body.push(h('button', {
        type: 'button', class: 'chip mono', 'aria-pressed': String(view.option.on), disabled: view.phase === 'sent',
        on: { click: () => view.option.set(!view.option.on) },
      }, view.option.label));
    }
    body.push(stages(view.phase));
    // Refused before running: nothing ran, so there is no output to show, only the reason (exitLine).
    if (!view.error) {
      body.push(h('div', { class: 'dsec' }, label(t('ui.drawer.output')),
        view.phase === 'sent' ? h('div', { class: 'pre wait' }, h('div', { class: 'sk' }), h('div', { class: 'sk' }), h('div', { class: 'sk' })) : null,
        view.result ? pre(view.result.output?.trimEnd() || t('ui.drawer.no_output')) : null));
    }
    if (view.phase !== 'sent') body.push(exitLine(view.result, view.error));
    const noteNode = view.phase !== 'sent' && view.note ? view.note(view.result) : null;
    if (noteNode) body.push(noteNode);
    if (view.phase === 'reread') body.push(h('div', { class: 'dsec reread' }, label(t('ui.run.reread_title')), h('span', null, t('ui.run.reread_at', { at: fmtClock(view.readAt) }))));
    const next = view.phase !== 'sent' && !view.error && view.result?.code === 0 && view.next ? view.next(view.result) : null;
    if (next) foot.push(btn(next.label, next.run, { kind: 'p' }));
  }
  $('drawer-body').replaceChildren(...body.filter(Boolean));
  $('drawer-foot').replaceChildren(...foot);
}

// A gesture of POST /api/run. `command` and `cwd` are shown while it runs; the server's own come with the answer.
export async function runGesture(spec) {
  const id = ++seq;
  current = { kind: 'gesture', phase: 'sent', ...spec };
  openDrawer();
  paint();
  let result = null;
  let error = null;
  try {
    result = await post('/api/run', { path: spec.project.path }, { gesture: spec.gesture, args: spec.args ?? {} });
  } catch (e) {
    error = e;
  }
  await settle(id, spec, result, error);
}

// A change of the workstation list of projects (POST /api/projects): global, it runs in no tree.
export async function runStation(spec) {
  const id = ++seq;
  current = { kind: 'station', phase: 'sent', ...spec };
  openDrawer();
  paint();
  let result = null;
  let error = null;
  try {
    result = await post('/api/projects', {}, { action: spec.action, target: spec.target });
  } catch (e) {
    error = e;
  }
  await settle(id, spec, result, error);
}

async function settle(id, spec, result, error) {
  if (current && seq === id) {
    Object.assign(current, { phase: 'reported', result, error });
    paint();
  }
  await hooks.reread();
  if (current && seq === id) {
    Object.assign(current, { phase: 'reread', readAt: new Date() });
    paint();
  } else {
    hooks.toast(error ? t('ui.run.toast_refused', { title: spec.title }) : t('ui.run.toast_done', { title: spec.title, code: result?.code ?? '?' }));
  }
}

// A file of the work folder (GET /api/file), read only. JSON is shown indented.
export async function openFile({ project, file, title = null }) {
  const id = ++seq;
  current = { kind: 'file', phase: 'sent', title: title ?? t('ui.drawer.read_only'), file };
  openDrawer();
  paint();
  let answer = null;
  let error = null;
  try {
    answer = await get('/api/file', { path: project.path, file });
    if (/\.json$/i.test(file) && answer?.content && !answer.truncated) {
      try {
        answer = { ...answer, content: JSON.stringify(JSON.parse(answer.content), null, 2) };
      } catch {
        // Shown as it is written.
      }
    }
  } catch (e) {
    error = e;
  }
  if (current && seq === id) {
    Object.assign(current, { phase: 'reported', answer, error });
    paint();
  }
}
