// A project's history (F4 to F7): its trains, its pushes, its guards, each deposit name, and the measures over 7, 30
// or 90 days. Every line comes from the work folder's warden-history.jsonl; the measures say their period and source.

import { t } from './ui-api.mjs';
import { absent, badge, box, btn, caption, fmtDay, fmtMinutes, fmtNum, fmtSeconds, fmtTime, h, kv, short } from './ui-dom.mjs';
import { cell, list } from './ui-list.mjs';
import { BLAMED, classTone, HALT_CLASSES, outcomeOf, pushResult } from './ui-model.mjs';
import { lineDetails, notRunNode } from './ui-train.mjs';
import { period, subbar } from './ui-views.mjs';

const DAY = 86400000;
const dateSelect = () => ({
  label: t('ui.train.date'), all: t('ui.history.date_all'),
  options: [['1', t('ui.history.date_today')], ['7', t('ui.history.date_week')], ['30', t('ui.history.date_month')]],
  test: (r, value) => (value === '1' ? new Date(r.at).toDateString() === new Date().toDateString() : Date.now() - Date.parse(r.at) < Number(value) * DAY),
});
const newestFirst = (lines) => lines.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
const timeOf = (iso) => fmtTime(iso);

function trainsList(ctx, d, lines) {
  return list(`trains:${d.path}`, {
    cols: [t('ui.col.outcome'), t('ui.col.batch'), t('ui.col.up_out'), t('ui.col.checks'), t('ui.col.duration'), t('ui.col.on')], right: 5,
    grid: '170px minmax(0,1.3fr) minmax(0,1.2fr) minmax(0,1fr) 64px 70px', minWidth: 900,
    strip: [
      { id: 'done', label: t('ui.outcome.done'), tone: 'ok' }, { id: 'out', label: t('ui.history.with_refusals'), tone: 'blame' },
      { id: 'halt', label: t('ui.train.halted'), tone: 'halt' }, { id: 'stopped', label: t('ui.outcome.stopped'), tone: 'halt' },
      { id: 'unknown', label: t('ui.outcome.unknown'), tone: 'unk' },
    ],
    stripLabel: t('ui.col.outcome'), selects: [dateSelect()], search: t('ui.history.search_trains'), empty: t('ui.history.trains_empty'),
    rows: newestFirst(lines).map((line, i) => {
      const outcome = outcomeOf(line);
      const up = line.up ?? [];
      const outs = line.out ?? [];
      const notRun = line.not_run ?? [];
      const log = line.log ?? null;
      return {
        id: `${line.at}|${i}`, at: line.at, st: outcome.st,
        search: [...(line.batch ?? []), line.base, ...up.map((u) => u.commit), line.halted ?? ''].join(' '),
        cells: [
          cell(null, timeOf(line.at), { tone: outcome.tone, toneLabel: outcome.label }),
          cell((line.batch ?? []).join(', ') || '—', t('ui.history.base_trials', { base: short(line.base), n: line.trials ?? 0 })),
          cell(t('ui.history.up_count', { n: up.length }), line.waiting ? t('ui.history.waiting_count', { n: line.waiting }) : null, { extra: outs.length ? h('span', { class: 'wrap' }, outs.map((o) => badge(classTone(o.class), `${o.name} · ${o.class}`))) : null }),
          notRun.length ? cell(null, notRun.join(', '), { tone: 'nr', toneLabel: t('ui.nr') }) : cell(notRunNode(line), null, { quiet: true }),
          cell(fmtSeconds(line.seconds)),
          cell(fmtDay(line.at), null, { right: true }),
        ],
        detail: () => h('div', { class: 'detail' }, kv(lineDetails(line, outcome)), log ? h('div', { class: 'dacts' }, btn(t('ui.open.log'), () => ctx.file(d, log), { small: true })) : null),
      };
    }),
  });
}

function stepRows(steps) {
  if (!(steps ?? []).length) return t('ui.history.no_steps');
  return h('span', { class: 'col' }, steps.map((s) => h('span', { class: 'wrap' },
    s.ok ? badge('ok', t('ui.push.pass')) : badge(classTone(s.class), s.class ? `${t('ui.push.fail')} · ${s.class}` : t('ui.push.fail')),
    h('span', null, `${s.title} · ${fmtSeconds(s.seconds)}${s.retried ? ` · ${t('ui.history.retried', { what: String(s.retried) })}` : ''}`))));
}

function pushesList(d, lines) {
  return list(`pushes:${d.path}`, {
    cols: [t('ui.col.result'), t('ui.col.ref_commit'), t('ui.col.tree'), t('ui.col.to_main'), t('ui.col.duration'), t('ui.col.on')], right: 5,
    grid: '170px minmax(0,1.4fr) minmax(0,1.2fr) 100px 64px 70px', minWidth: 900,
    strip: [
      { id: 'pass', label: t('ui.push.pass'), tone: 'ok' }, { id: 'fail', label: t('ui.push.fail'), tone: 'blame' },
      { id: 'incomplete', label: t('ui.push.incomplete'), tone: 'nr' }, { id: 'already', label: t('ui.push.already'), tone: 'idle' },
    ],
    stripLabel: t('ui.col.result'),
    selects: [dateSelect(), { label: t('ui.col.to_main'), all: t('ui.history.dest_all'), options: [['1', t('ui.history.dest_main')], ['0', t('ui.history.dest_branch')]], test: (r, v) => (r.main ? '1' : '0') === v }],
    search: t('ui.history.search_pushes'), empty: t('ui.history.pushes_empty'),
    rows: newestFirst(lines).map((line, i) => {
      const result = pushResult(line);
      return {
        id: `${line.at}|${i}`, at: line.at, st: line.result, main: Boolean(line.to_main),
        search: `${line.ref ?? ''} ${line.commit ?? ''} ${line.tree ?? ''} ${line.class ?? ''}`,
        cells: [
          cell(null, timeOf(line.at), { tone: result.tone, toneLabel: result.label }),
          cell(line.ref ?? '—', short(line.commit), { mono: true }),
          cell(line.tree ?? '—', null, { mono: true }),
          cell(line.to_main ? t('ui.yes') : t('ui.no')),
          cell(fmtSeconds(line.seconds)),
          cell(fmtDay(line.at), null, { right: true }),
        ],
        detail: () => h('div', { class: 'detail' }, kv([
          [t('ui.dock.commit'), line.commit ?? '—', { mono: true }],
          [t('ui.col.class'), line.class ?? '—', { mono: Boolean(line.class) }],
          [t('ui.train.steps'), line.result === 'already' ? t('ui.history.already') : stepRows(line.steps)],
          [t('ui.train.not_run'), (line.not_run ?? []).length ? h('span', { class: 'wrap' }, line.not_run.map((n) => badge('nr', n))) : line.result === 'already' ? '—' : t('ui.train.all_ran')],
        ])),
      };
    }),
  });
}

function guardsList(d, lines) {
  const kitLabel = (kit) => ({ ran: t('ui.guards.ran'), cached: t('ui.guards.cached'), none: t('ui.guards.none') })[kit] ?? String(kit ?? '—');
  return list(`guards:${d.path}`, {
    cols: [t('ui.history.guards'), t('ui.col.tree'), t('ui.col.kit_tests'), t('ui.col.duration'), t('ui.col.on')], right: 4,
    grid: '170px minmax(0,1.6fr) minmax(0,1fr) 80px 80px', minWidth: 760,
    strip: [{ id: 'ok', label: t('ui.guards.ok'), tone: 'ok' }, { id: 'ko', label: t('ui.push.fail'), tone: 'blame' }], stripLabel: t('ui.history.guards'),
    selects: [dateSelect(), { label: t('ui.col.kit_tests'), all: t('ui.guards.kit_all'), options: [['ran', t('ui.guards.ran')], ['cached', t('ui.guards.cached')], ['none', t('ui.guards.none')]], test: (r, v) => r.kit === v }],
    search: t('ui.history.search_guards'), empty: t('ui.history.guards_empty'),
    rows: newestFirst(lines).map((line, i) => ({
      id: `${line.at}|${i}`, at: line.at, st: line.ok === false ? 'ko' : 'ok', kit: line.kit, search: line.tree ?? '',
      cells: [
        line.ok === false ? cell(null, timeOf(line.at), { tone: 'blame', toneLabel: t('ui.push.fail') }) : cell(null, timeOf(line.at), { tone: 'ok', toneLabel: t('ui.guards.ok') }),
        cell(line.tree ?? '—', null, { mono: true }),
        cell(kitLabel(line.kit), null, { quiet: line.kit !== 'ran' }),
        cell(fmtSeconds(line.seconds)),
        cell(fmtDay(line.at), null, { right: true }),
      ],
    })),
  });
}

// Each deposit name: what went up and out in the trains of the history, its median wait, and the dock now.
function depositsList(d, trains) {
  const names = new Map();
  const get = (name) => {
    const key = String(name ?? '?').replace(/\.txt$/, '');
    if (!names.has(key)) names.set(key, { name: key, up: 0, out: [], waits: [], ready: false, refused: null });
    return names.get(key);
  };
  for (const line of trains) {
    for (const u of line.up ?? []) {
      const g = get(u.name);
      g.up += 1;
      if (Number.isFinite(u.waited_s)) g.waits.push(u.waited_s);
    }
    for (const o of line.out ?? []) get(o.name).out.push(o.class);
  }
  for (const x of d.status.dock?.ready ?? []) get(x.name).ready = true;
  for (const x of d.status.dock?.refused ?? []) get(x.name).refused = x.refusal?.class ?? 'refused';
  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  };
  return list(`deposits:${d.path}`, {
    cols: [t('ui.col.deposit'), t('ui.col.ready_now'), t('ui.col.refusal_now'), t('ui.dock.taken'), t('ui.col.set_aside'), t('ui.col.dock_to_main')], right: 5,
    grid: 'minmax(0,1fr) 110px minmax(0,1.1fr) 90px minmax(0,1fr) 210px', minWidth: 900,
    search: t('ui.history.search_deposits'), empty: t('ui.history.deposits_empty'), cap: t('ui.history.deposits_cap'),
    rows: [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).map((g) => {
      const m = median(g.waits);
      return {
        id: g.name, search: g.name,
        cells: [
          cell(g.name, null, { strong: true }),
          cell(g.ready ? t('ui.yes') : '—'),
          g.refused ? cell(null, t('ui.refusal.to_author'), { tone: classTone(g.refused), toneLabel: g.refused }) : cell(t('ui.none'), null, { quiet: true }),
          cell(String(g.up)),
          g.out.length ? cell(null, null, { extra: h('span', { class: 'wrap' }, g.out.map((c) => badge(classTone(c), c))) }) : cell('0', null, { quiet: true }),
          cell(m === null ? '—' : t('ui.history.median', { value: fmtMinutes(m / 60) }), null, { right: true }),
        ],
      };
    }),
  });
}

const stat = (label, value, tone = null, toneLabel = null) => h('div', { class: 'stat' }, h('span', null, label), h('b', null, tone ? badge(tone, toneLabel) : null, String(value)));
const group = (title, ...children) => h('div', { class: 'boxr col' }, h('span', { class: 'gt' }, title), ...children);
const stats = (...items) => h('div', { class: 'stats' }, items.flat().filter(Boolean));

function perDayStrip(summary) {
  const perDay = summary.integrations_per_day ?? {};
  const days = Math.max(1, Math.min(90, Number(summary.days) || 7));
  const today = new Date();
  const values = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    values.push({ day, n: perDay[key] ?? 0, last: i === 0, mark: i % 7 === 0 });
  }
  const max = Math.max(1, ...values.map((v) => v.n));
  return h('div', { class: 'daystrip', role: 'img', 'aria-label': t('ui.measures.per_day', { days }) }, values.map((v) => {
    const fill = h('i');
    fill.style.height = `${Math.max(2, Math.round((v.n / max) * 34))}px`;
    return h('span', { class: 'sd', 'data-on': v.last ? '1' : '0', title: `${fmtDay(v.day)} : ${v.n}` }, fill, v.mark ? h('span', null, fmtDay(v.day)) : null);
  }));
}

function measures(ctx, d) {
  const out = [period(ctx.state.days, (n) => ctx.setDays(n))];
  const s = d.summary;
  const source = `status.mjs --history --days ${d.days} --json`;
  if (d.absent?.history) return out.concat(box(h('div', { class: 'boxr' }, absent(d.kit.version))));
  if (!s) return out.concat(caption(null, t('ui.measures.none', { source })));
  out.push(caption(null, t('ui.measures.source', { days: s.days, source })));
  const steps = s.costly_steps ?? [];
  const top = Math.max(1, ...steps.map((x) => x.seconds ?? 0));
  const pushes = s.pushes ?? {};
  const guards = s.guards ?? {};
  const refusals = s.refusals ?? {};
  const halts = s.halts ?? {};
  const notRun = Object.entries(s.not_run ?? {});
  const extraClasses = (counts, known) => Object.keys(counts).filter((k) => !known.includes(k));
  out.push(box(
    group(t('ui.measures.integrations'), stats(
      stat(t('ui.history.trains'), s.trains ?? 0), stat(t('ui.measures.went_up'), s.integrations ?? 0),
      stat(t('ui.measures.trials'), fmtNum(s.trials_per_train, 2)), stat(t('ui.measures.verification'), fmtSeconds(s.verification_seconds_per_integration)),
      stat(t('ui.nature.release'), s.releases ?? 0)), perDayStrip(s)),
    group(t('ui.measures.dock_to_main'), stats(stat(t('ui.measures.median'), fmtMinutes(s.dock_to_main_minutes?.median)), stat(t('ui.measures.max'), fmtMinutes(s.dock_to_main_minutes?.max)))),
    group(t('ui.measures.refusals_halts'), stats(
      [...BLAMED, ...extraClasses(refusals, BLAMED)].map((c) => stat(t('ui.measures.refusals'), refusals[c] ?? 0, classTone(c), c)),
      [...HALT_CLASSES, ...extraClasses(halts, HALT_CLASSES)].map((c) => stat(t('ui.nature.halt'), halts[c] ?? 0, 'halt', c)))),
    group(t('ui.measures.costly'), steps.length ? h('div', { class: 'hbars' }, steps.map((x) => {
      const fill = h('i');
      fill.style.width = `${Math.round(((x.seconds ?? 0) / top) * 100)}%`;
      return h('div', { class: 'hbar' }, h('span', null, x.title), h('span', { class: 'mbar', 'aria-hidden': 'true' }, fill), h('span', { class: 'quiet' }, t('ui.measures.step_cost', { seconds: fmtSeconds(x.seconds), runs: x.runs ?? 0 })));
    })) : h('span', { class: 'quiet' }, t('ui.measures.no_steps'))),
    group(t('ui.measures.pushes_guards'), stats(
      stat(t('ui.history.pushes'), pushes.count ?? 0),
      Object.entries(pushes.failed ?? {}).map(([c, n]) => stat(t('ui.push.fail'), n, classTone(c), c)),
      stat(t('ui.measures.incomplete'), pushes.incomplete ?? 0, pushes.incomplete ? 'nr' : null, pushes.incomplete ? t('ui.push.incomplete') : null),
      stat(t('ui.measures.push_mean'), fmtSeconds(pushes.seconds_mean)),
      stat(t('ui.measures.guard_runs'), guards.runs ?? 0), stat(t('ui.measures.kit_cached'), guards.kit_cached ?? 0), stat(t('ui.measures.guard_mean'), fmtSeconds(guards.seconds_mean)))),
    group(t('ui.measures.not_run'), notRun.length ? stats(notRun.map(([title, n]) => stat(title, n, 'nr', t('ui.nr')))) : h('span', { class: 'quiet' }, t('ui.measures.not_run_none')))));
  return out;
}

export function renderHistory(ctx, d) {
  if (d.absent?.history) return [box(h('div', { class: 'boxr' }, badge('unk', t('ui.absent_title')), absent(d.kit.version)))];
  const sub = ctx.state.sub.history ?? 0;
  const lines = d.history ?? [];
  const of = (kind) => lines.filter((e) => e.kind === kind);
  const trains = of('train');
  const pushes = of('push');
  const guards = of('guards');
  const out = [subbar({
    items: [
      { label: t('ui.history.trains'), n: trains.length }, { label: t('ui.history.pushes'), n: pushes.length },
      { label: t('ui.history.guards'), n: guards.length }, { label: t('ui.history.deposits') }, { label: t('ui.history.measures') },
    ],
    current: sub, onPick: (i) => ctx.setSub('history', i),
    source: sub === 4 ? `status.mjs --history --days ${d.days} --json` : 'warden-history.jsonl',
  })];
  if (sub === 0) out.push(trainsList(ctx, d, trains));
  else if (sub === 1) out.push(pushesList(d, pushes));
  else if (sub === 2) out.push(guardsList(d, guards));
  else if (sub === 3) out.push(depositsList(d, trains));
  else out.push(...measures(ctx, d));
  return out;
}
