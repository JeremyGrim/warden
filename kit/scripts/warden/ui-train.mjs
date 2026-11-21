// A project's train (F1), its push slot (F2) and its dock (F3). The only gesture is a dry run, in the factory tree;
// a real train, a recovery or a merge are never offered here.

import { get, t } from './ui-api.mjs';
import {
  absent, badge, bar, box, boxRow, btn, caption, fmtAge, fmtDate, fmtNum, fmtSeconds, h, kv, minutesSince, mono, relWork, sameCommit, short,
} from './ui-dom.mjs';
import { cell, list } from './ui-list.mjs';
import { baselineHolds, classTone, factoryOf, haltLift, kitBefore, nextText, outcomeOf, trainState } from './ui-model.mjs';
import { subbar } from './ui-views.mjs';

const SLOT_ABANDON_MIN = 50;

// The deposit files, read for what the status does not give: priority, docking moment, scenario. Read again when
// their commit changes, or after 30 s.
const deposits = new Map();

function parseDeposit(text) {
  const fields = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const found = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (found) fields[found[1].toLowerCase()] = found[2];
  }
  return fields;
}

// `dd/mm hh:mm`, local time, in the year that puts it closest to now (dock.mjs).
function dockedMoment(text) {
  const when = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(text ?? '');
  if (!when) return null;
  const now = Date.now();
  const year = new Date(now).getFullYear();
  const at = (y) => new Date(y, Number(when[2]) - 1, Number(when[1]), Number(when[3]), Number(when[4])).getTime();
  return [year - 1, year, year + 1].map(at).reduce((best, m) => (Math.abs(m - now) < Math.abs(best - now) ? m : best));
}

function depositFields(ctx, d, file, deposit) {
  const key = `${d.path}|${deposit.name}`;
  const known = deposits.get(key);
  const fresh = known && known.commit === (deposit.commit ?? '') && Date.now() - known.at < 30000;
  if (!fresh && !known?.loading) {
    deposits.set(key, { ...(known ?? {}), loading: true });
    get('/api/file', { path: d.path, file })
      .then((answer) => deposits.set(key, { fields: parseDeposit(answer?.content), commit: deposit.commit ?? '', at: Date.now(), loading: false }))
      .catch(() => deposits.set(key, { fields: known?.fields ?? null, commit: deposit.commit ?? '', at: Date.now(), loading: false }))
      .finally(() => ctx.render());
  }
  return known?.fields ?? null;
}

function stateBox(ctx, d) {
  const state = trainState(d);
  const status = d.status;
  const dock = status.dock ?? {};
  const work = d.work;
  const factory = factoryOf(d);
  const files = [];
  const open = (label, file) => file && files.push(btn(label, () => ctx.file(d, file), { small: true }));
  let details = [];
  let sub = state.sub;
  const live = dock.train;
  if (live) {
    sub = live.alive ? t('ui.train.running_sub', { count: live.batch?.length ?? 0, trial: live.trial ?? 0, step: live.step ?? '—' }) : t('ui.train.interrupted_long');
    details = [
      [t('ui.col.batch'), (live.batch ?? []).join(', ')],
      [t('ui.train.trial'), String(live.trial ?? '—')],
      [t('ui.train.step'), live.step ?? '—'],
      [t('ui.train.began'), `${fmtDate(live.began)} · ${fmtAge(live.began)}`],
      [t('ui.train.step_began'), `${fmtDate(live.step_began)} · ${fmtAge(live.step_began)}`],
      [t('ui.train.process'), String(live.pid ?? '—'), { mono: true }],
      live.alive ? null : [t('ui.train.recovery'), t('ui.train.interrupted_sub')],
    ];
  } else if (dock.halt) {
    const halt = dock.halt;
    sub = `${halt.class} · ${t('ui.halt.nobody')}`;
    const notice = factory.halt_notice_minutes;
    details = [
      [t('ui.col.class'), halt.class, { mono: true }],
      [t('ui.halt.reason'), halt.reason === 'memory' ? t('ui.halt.memory') : '—'],
      [t('ui.halt.step'), halt.step],
      [t('ui.halt.cause'), halt.cause],
      [t('ui.halt.first_error'), halt.first_error, { mono: true }],
      [t('ui.halt.main'), halt.main ?? '—', { mono: Boolean(halt.main) }],
      [t('ui.dock.title'), halt.dock || '—', { mono: true }],
      [t('ui.col.since'), `${fmtDate(halt.at)} · ${fmtAge(halt.at)}`],
      [t('ui.train.last'), halt.last ? `${fmtDate(halt.last)} · ${fmtAge(halt.last)}` : kitBefore(d, '0.4.2') ? absent(d.kit.version) : '—'],
      [t('ui.halt.noticed'), halt.noticed ? t('ui.yes') : t('ui.halt.noticed_no', { minutes: fmtNum(notice, 0) })],
      [t('ui.halt.lifts'), haltLift(halt, factory)],
    ];
    const dockRel = relWork(work, dock.folder);
    open(t('ui.open.halt_file'), dockRel ? `${dockRel}/_halt.json` : null);
    open(t('ui.open.log'), relWork(work, halt.log));
  } else if (d.absent?.history) {
    details = [[t('ui.train.last'), absent(d.kit.version)]];
  } else if (d.last_train) {
    const line = d.last_train;
    const outcome = outcomeOf(line);
    sub = t('ui.train.last_at', { at: fmtDate(line.at) });
    details = lineDetails(line, outcome);
    open(t('ui.open.log'), line.log ? relWork(work, line.log) : null);
  } else {
    details = [[t('ui.train.last'), t('ui.train.no_train')]];
  }
  if (d.absent?.live_train) details.unshift([t('ui.train.running'), absent(d.kit.version)]);
  const factoryTree = status.factory_tree;
  const dryRun = btn(t('ui.gesture.dry_run'), () => ctx.gesture({
    project: d, gesture: 'train.dry_run', args: {}, title: t('ui.gesture.dry_run'),
    command: 'node scripts/warden/train.mjs run --dry-run', cwd: factoryTree,
    note: () => (baselineHolds(ctx.latest()) ? h('div', { class: 'exit' }, badge('halt', t('ui.halt.label')), h('span', { class: 'grow' }, t('ui.dry_run.halt_holds')), mono('_halt.json')) : null),
  }), { disabled: !factoryTree, title: factoryTree ? t('ui.dry_run.title') : t('ui.gesture.needs_factory'), fk: 'train:dry' });
  const holder = status.slot?.holder ?? null;
  const held = holder ? minutesSince(holder.since) ?? 0 : 0;
  return box(
    boxRow(badge(state.tone, state.label, true), h('span', { class: 'grow sub' }, sub), dryRun),
    h('div', { class: 'boxr start' }, h('div', { class: 'grow' }, kv(details)), files.length ? h('div', { class: 'lacts' }, files) : null),
    boxRow(
      h('span', { class: 'rowk' }, t('ui.slot.title')),
      holder ? badge('run', t('ui.slot.held')) : badge('idle', t('ui.slot.free')),
      h('span', { class: 'grow wrap' }, holder ? t('ui.slot.held_long', { tree: holder.tree ?? '?', commit: holder.commit ?? '?', since: fmtDate(holder.since), minutes: Math.floor(held) }) : t('ui.slot.free_long')),
      holder ? h('span', { class: 'mcap' }, bar(held / SLOT_ABANDON_MIN, { over: held > SLOT_ABANDON_MIN * 0.8 }), h('span', null, t('ui.slot.abandon', { minutes: SLOT_ABANDON_MIN }))) : null),
    factoryTree ? null : boxRow(badge('unk', t('ui.factory.none_short')), h('span', { class: 'grow' }, t('ui.gesture.needs_factory'))));
}

// What did not run in a train: a halted train did not run all its checks, even with an empty `not_run`.
export function notRunNode(line) {
  const notRun = line.not_run ?? [];
  if (notRun.length) return h('span', { class: 'wrap' }, notRun.map((name) => badge('nr', name)));
  return line.halted || line.outcome === 'halted' || line.outcome === 'stopped' ? t('ui.history.cut_short') : t('ui.train.all_ran');
}

// The details of a train line: what went up, out, waits, what did not run, how long, the log.
export function lineDetails(line, outcome) {
  return [
    [t('ui.train.date'), fmtDate(line.at)],
    [t('ui.col.outcome'), h('span', { class: 'wrap' }, badge(outcome.tone, outcome.label), outcome.st === 'unknown' ? ` ${t('ui.outcome.unknown_sub')}` : '')],
    [t('ui.train.base'), line.base ?? '—', { mono: true }],
    [t('ui.col.batch'), (line.batch ?? []).join(', ') || '—'],
    [t('ui.train.trials'), String(line.trials ?? '—')],
    [t('ui.dock.taken'), (line.up ?? []).length ? line.up.map((u) => t('ui.train.up_item', { name: u.name, commit: short(u.commit), wait: fmtSeconds(u.waited_s) })).join(' · ') : '—'],
    [t('ui.train.out'), (line.out ?? []).length ? h('span', { class: 'wrap' }, line.out.map((o) => badge(classTone(o.class), `${o.name} · ${o.class}`))) : '—'],
    [t('ui.dock.waiting'), Array.isArray(line.pending) ? (line.pending.length ? line.pending.join(', ') : '0') : String(line.waiting ?? 0)],
    [t('ui.train.not_run'), notRunNode(line)],
    [t('ui.train.steps'), Object.entries(line.steps ?? {}).map(([title, s]) => `${title} ${fmtSeconds(s)}`).join(' · ') || '—'],
    [t('ui.col.duration'), fmtSeconds(line.seconds)],
    [t('ui.train.log'), line.log ?? '—', { mono: true }],
  ];
}

function detailBlock(rows, buttons) {
  return h('div', { class: 'detail' }, kv(rows), buttons.length ? h('div', { class: 'dacts' }, buttons) : null);
}

function readyList(ctx, d, dockRel) {
  const ready = (d.status.dock?.ready ?? []).map((deposit) => {
    const file = dockRel ? `${dockRel}/${deposit.name}` : null;
    const fields = file ? depositFields(ctx, d, file, deposit) : null;
    const priority = /^-?\d+$/.test(fields?.priority ?? '') ? Number(fields.priority) : null;
    return { deposit, file, fields, priority, moment: dockedMoment(fields?.docked) };
  });
  const rank = (r) => r.priority ?? Number.POSITIVE_INFINITY;
  ready.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) - rank(b)) || (a.moment ?? 0) - (b.moment ?? 0) || a.deposit.name.localeCompare(b.deposit.name));
  return list(`ready:${d.path}`, {
    cols: [t('ui.col.order'), t('ui.col.deposit'), t('ui.col.branch_commit'), t('ui.col.tasks'), t('ui.col.docked'), t('ui.col.wait')], right: 5,
    grid: '80px minmax(0,.9fr) minmax(0,1.5fr) minmax(0,1fr) 110px 90px', minWidth: 880,
    search: t('ui.dock.search'), empty: t('ui.dock.ready_empty'),
    rows: ready.map((r, i) => {
      const x = r.deposit;
      return {
        id: x.name, search: `${x.name} ${x.branch} ${x.commit ?? ''} ${(x.tasks ?? []).join(' ')}`,
        cells: [
          cell(String(i + 1), r.priority !== null ? t('ui.dock.priority', { n: r.priority }) : null),
          cell(x.name, null, { strong: true }),
          cell(x.branch ?? '—', x.commit ? short(x.commit) : t('ui.dock.tip'), { mono: true }),
          cell((x.tasks ?? []).join(', ') || '—'),
          cell(r.fields?.docked ?? (r.fields ? '—' : '…')),
          cell(r.moment ? fmtAge(r.moment) : '—', null, { right: true }),
        ],
        detail: () => detailBlock([
          [t('ui.col.tree'), x.tree ?? '—', { mono: true }],
          [t('ui.dock.commit'), x.commit ?? t('ui.dock.no_commit'), { mono: Boolean(x.commit) }],
          [t('ui.dock.scenario'), r.fields?.scenario || '—'],
          [t('ui.dock.priority_label'), r.priority !== null ? String(r.priority) : t('ui.dock.no_priority')],
          [t('ui.col.file'), r.file ?? '—', { mono: true }],
        ], r.file ? [btn(t('ui.open.deposit'), () => ctx.file(d, r.file), { small: true })] : []),
      };
    }),
  });
}

function refusedList(ctx, d, dockRel) {
  if (d.absent?.refusals) return caption(null, t('ui.absent', { kit: d.kit.version }));
  const refused = d.status.dock?.refused ?? [];
  return list(`refused:${d.path}`, {
    cols: [t('ui.col.class'), t('ui.col.deposit'), t('ui.col.step_error'), t('ui.col.next'), t('ui.col.refused_at')], right: 4,
    grid: '160px minmax(0,.9fr) minmax(0,1.6fr) minmax(0,1.1fr) 110px', minWidth: 880,
    strip: ['violation', 'defect', 'conflict'].map((c) => ({ id: c, label: c, tone: 'blame' })), stripLabel: t('ui.col.class'),
    search: t('ui.dock.search_refused'), empty: t('ui.dock.refused_empty'),
    rows: refused.map((x) => {
      const r = x.refusal;
      const refusalFile = dockRel ? `${dockRel}/${x.name.replace(/\.txt$/, '.refusal.json')}` : null;
      if (!r) {
        return {
          id: x.name, st: 'old', search: `${x.name} ${x.branch} ${x.refused ?? ''}`,
          cells: [cell(null, t('ui.refusal.old_sub'), { tone: 'unk', toneLabel: t('ui.refusal.old') }), cell(x.name, x.branch, { strong: true }), cell(x.refused ?? '—', null, { mono: true }), cell('—'), cell('—', null, { right: true })],
          detail: () => detailBlock([[t('ui.refusal.line'), x.refused ?? '—', { mono: true }], [t('ui.refusal.holds_until'), t('ui.refusal.old_holds')]], []),
        };
      }
      const log = relWork(d.work, r.log);
      const deposited = x.commit ? (sameCommit(x.commit, r.commit) ? t('ui.refusal.same_commit') : t('ui.refusal.other_commit', { commit: short(x.commit) })) : t('ui.dock.no_commit');
      return {
        id: x.name, st: r.class, search: `${x.name} ${x.branch} ${r.class} ${r.step} ${r.first_error ?? ''} ${r.rule ?? ''}`,
        cells: [
          cell(null, classTone(r.class) === 'blame' ? t('ui.refusal.blamed') : t('ui.halt.nobody'), { tone: classTone(r.class), toneLabel: r.class }),
          cell(x.name, x.branch, { strong: true }),
          cell(r.step ?? '—', r.first_error ?? null),
          cell(nextText(r.next)),
          cell(fmtDate(r.at), null, { right: true }),
        ],
        detail: () => detailBlock([
          [t('ui.refusal.rule'), r.rule ?? '—', { mono: Boolean(r.rule) }],
          [t('ui.refusal.files'), (r.files ?? []).length ? r.files.join(', ') : '—', { mono: true }],
          [t('ui.refusal.commit'), r.commit ?? '—', { mono: true }],
          [t('ui.refusal.deposited'), deposited],
          [t('ui.train.base'), r.base ?? '—', { mono: true }],
          [t('ui.col.train'), r.train ?? '—', { mono: true }],
          [t('ui.col.next'), `${r.next ?? '—'} · ${nextText(r.next)}`],
          [t('ui.train.log'), log ?? r.log ?? '—', { mono: true }],
        ], [log ? btn(t('ui.open.log'), () => ctx.file(d, log), { small: true }) : null, refusalFile ? btn(t('ui.open.refusal'), () => ctx.file(d, refusalFile), { small: true }) : null].filter(Boolean)),
      };
    }),
  });
}

function waitingList(d) {
  const line = d.last_train;
  if (d.absent?.history) return caption(null, t('ui.absent', { kit: d.kit.version }));
  if (line && !Array.isArray(line.pending)) {
    return caption(null, t('ui.dock.waiting_old', { n: line.waiting ?? 0 }));
  }
  const pending = line?.pending ?? [];
  return list(`waiting:${d.path}`, {
    cols: [t('ui.col.state'), t('ui.col.deposit'), t('ui.col.why'), t('ui.col.since')], right: 3,
    grid: '150px minmax(0,1fr) minmax(0,1.4fr) 120px', minWidth: 700, search: false,
    empty: t('ui.dock.waiting_empty'), cap: line ? t('ui.dock.waiting_source', { at: fmtDate(line.at) }) : null,
    rows: pending.map((name) => ({
      id: name,
      cells: [cell(null, t('ui.halt.nobody'), { tone: 'wait', toneLabel: t('ui.dock.waiting') }), cell(name, null, { strong: true }), cell(t('ui.dock.waiting_why')), cell(fmtDate(line.at), null, { right: true })],
    })),
  });
}

function takenList(ctx, d, dockRel) {
  return list(`taken:${d.path}`, {
    cols: [t('ui.col.deposit'), t('ui.col.taken_commit'), t('ui.col.main_commit'), t('ui.col.taken_at')], right: 3,
    grid: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 120px', minWidth: 720, facets: true,
    search: t('ui.dock.search_taken'), empty: t('ui.dock.taken_empty'),
    rows: (d.taken ?? []).map((x) => {
      const file = dockRel ? `${dockRel}/taken/${x.file}` : null;
      return {
        id: x.file, fac: x.name, search: `${x.name} ${x.branch ?? ''} ${x.commit ?? ''} ${x.taken?.main ?? ''}`,
        cells: [cell(x.name, x.branch, { strong: true }), cell(short(x.taken?.commit ?? x.commit), null, { mono: true }), cell(short(x.taken?.main), null, { mono: true }), cell(fmtDate(x.taken?.at), null, { right: true })],
        detail: () => detailBlock([
          [t('ui.refusal.line'), x.taken ? `taken = ${x.taken.commit} in ${x.taken.main} at ${x.taken.at ?? '?'}` : '—', { mono: true }],
          [t('ui.col.tree'), x.tree ?? '—', { mono: true }],
          [t('ui.col.tasks'), x.tasks || '—'],
          [t('ui.col.file'), file ?? '—', { mono: true }],
        ], file ? [btn(t('ui.open.deposit'), () => ctx.file(d, file), { small: true })] : []),
      };
    }),
  });
}

export function renderTrain(ctx, d) {
  const dockRel = relWork(d.work, d.status.dock?.folder);
  const sub = ctx.state.sub.dock ?? 0;
  const line = d.last_train;
  const counts = [
    (d.status.dock?.ready ?? []).length,
    (d.status.dock?.refused ?? []).length,
    Array.isArray(line?.pending) ? line.pending.length : null,
    (d.taken ?? []).length,
  ];
  const out = [stateBox(ctx, d)];
  if (!d.status.dock) {
    out.push(caption(null, t('ui.dock.none')));
    return out;
  }
  out.push(subbar({
    title: t('ui.dock.title'), current: sub, onPick: (i) => ctx.setSub('dock', i), source: dockRel ? `${dockRel}/` : null,
    items: [
      { label: t('ui.dock.ready'), n: counts[0] }, { label: t('ui.dock.refused'), n: counts[1] },
      { label: t('ui.dock.waiting'), n: counts[2] }, { label: t('ui.dock.taken'), n: counts[3] },
    ],
  }));
  if (sub === 0) out.push(readyList(ctx, d, dockRel));
  else if (sub === 1) out.push(refusedList(ctx, d, dockRel));
  else if (sub === 2) out.push(waitingList(d));
  else out.push(takenList(ctx, d, dockRel));
  return out;
}
