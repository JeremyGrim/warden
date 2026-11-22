// What the page reads in the server's data: the state of a train, the tone of a result, the cases and their words,
// what lifts a halt. The tones follow the repository's visuals: red when a branch is blamed, amber when nobody is,
// grey for idle and for what the person did; "not run" is amber and dashed, never green.

import { t } from './ui-api.mjs';
import { compareVersions, fmtDate, fmtNum, sameCommit, samePath } from './ui-dom.mjs';

export const BLAMED = ['violation', 'defect', 'conflict'];
export const HALT_CLASSES = ['baseline', 'transient', 'incomplete'];
export const classTone = (cls) => (BLAMED.includes(cls) ? 'blame' : 'halt');

// The factory settings the page needs, with the kit's defaults (config.mjs) where the project file says nothing.
export function factoryOf(detail) {
  const given = detail?.config?.factory;
  const train = given && typeof given.train === 'object' && given.train ? given.train : {};
  return {
    min_free_memory_gib: train.min_free_memory_gib ?? 8,
    retry_minutes: train.retry_minutes ?? 10,
    halt_notice_minutes: train.halt_notice_minutes ?? 30,
  };
}

export const reasonShort = (reason) => ({
  missing: t('ui.reason.missing'), not_git: t('ui.reason.not_git'), no_kit: t('ui.reason.no_kit'), unreadable: t('ui.reason.unreadable'),
})[reason] ?? String(reason ?? '');
export const reasonLong = (reason) => ({
  missing: t('ui.reason.missing_long'), not_git: t('ui.reason.not_git_long'), no_kit: t('ui.reason.no_kit_long'), unreadable: t('ui.reason.unreadable_long'),
})[reason] ?? String(reason ?? '');

// The state of a project's train: unreadable, under way, interrupted, halted, idle.
export function trainState(p) {
  if (!p?.ok) return { kind: 'bad', tone: 'unk', label: t('ui.train.unreadable'), sub: reasonShort(p?.reason) };
  const dock = p.status?.dock ?? null;
  const live = dock?.train ?? null;
  if (live?.alive) return { kind: 'run', tone: 'run', label: t('ui.train.running'), sub: t('ui.train.running_sub', { count: live.batch?.length ?? 0, trial: live.trial ?? 0, step: live.step ?? '—' }) };
  if (live) return { kind: 'interrupted', tone: 'wait', label: t('ui.train.interrupted'), sub: t('ui.train.interrupted_sub') };
  if (dock?.halt) {
    const halt = dock.halt;
    const extra = [halt.class, halt.reason === 'memory' ? t('ui.halt.memory') : null, halt.noticed ? t('ui.halt.noticed_short') : null].filter(Boolean).join(' · ');
    return { kind: 'halt', tone: 'halt', label: t('ui.train.halted'), sub: extra };
  }
  return { kind: 'idle', tone: 'idle', label: t('ui.train.idle'), sub: p.last_train ? t('ui.train.last_at', { at: fmtDate(p.last_train.at) }) : t('ui.train.no_train') };
}

export const STATE_STRIP = () => [
  { id: 'idle', label: t('ui.train.idle'), tone: 'idle' },
  { id: 'run', label: t('ui.train.running'), tone: 'run' },
  { id: 'halt', label: t('ui.train.halted'), tone: 'halt' },
  { id: 'interrupted', label: t('ui.train.interrupted'), tone: 'wait' },
  { id: 'bad', label: t('ui.train.unreadable'), tone: 'unk' },
];

// The outcome of a train line: done, halted, stopped by an error. A line written before the 0.4.3 kit says only
// `halted`: a train stopped by an error does not show there, so the page does not call it done.
export function outcomeOf(line) {
  if (line.outcome === 'halted' || (!line.outcome && line.halted)) return { st: 'halt', tone: 'halt', label: t('ui.outcome.halted', { cls: line.halted ?? '?' }) };
  if (line.outcome === 'stopped') return { st: 'stopped', tone: 'halt', label: t('ui.outcome.stopped') };
  if (line.outcome === 'done') return { st: (line.out ?? []).length ? 'out' : 'done', tone: 'ok', label: t('ui.outcome.done') };
  return { st: 'unknown', tone: 'unk', label: t('ui.outcome.unknown') };
}

export function pushResult(line) {
  switch (line.result) {
    case 'pass': return { tone: 'ok', label: t('ui.push.pass') };
    case 'fail': return { tone: classTone(line.class), label: line.class ? `${t('ui.push.fail')} · ${line.class}` : t('ui.push.fail') };
    case 'incomplete': return { tone: 'nr', label: t('ui.push.incomplete') };
    case 'already': return { tone: 'idle', label: t('ui.push.already') };
    default: return { tone: 'unk', label: String(line.result ?? '?') };
  }
}

export const nextText = (next) => ({ fix_and_redock: t('ui.next.fix_and_redock'), rebase_and_redock: t('ui.next.rebase_and_redock') })[next] ?? String(next ?? '—');

// What lifts a halt (brief, §4.4), with this project's settings.
export function haltLift(halt, factory) {
  if (halt.class === 'baseline') return t('ui.lift.baseline');
  if (halt.reason === 'memory') return t('ui.lift.memory', { gib: fmtNum(factory.min_free_memory_gib, 1) });
  return t('ui.lift.retry', { minutes: fmtNum(factory.retry_minutes, 1) });
}

// A `baseline` halt holds while the main branch and the dock did not change: a real train would not leave. Read from
// the dock's print in the halt, and from what reached the main branch since it began.
export function baselineHolds(detail) {
  const halt = detail?.status?.dock?.halt;
  if (!halt || halt.class !== 'baseline') return false;
  const ready = (detail.status.dock.ready ?? []).filter((d) => d.tree && d.branch);
  const print = ready.map((d) => `${d.name}@${d.commit ?? ''}`).sort().join(',');
  if (print !== (halt.dock ?? '')) return false;
  const since = Date.parse(halt.at ?? '') || 0;
  const moved = (commit, at) => Boolean(commit && halt.main) && Date.parse(at ?? '') > since && !sameCommit(commit, halt.main);
  const pushed = (detail.history ?? []).some((e) => e.kind === 'push' && e.to_main && moved(e.commit, e.at));
  const taken = (detail.taken ?? []).some((d) => d.taken && moved(d.taken.main, d.taken.at));
  return !pushed && !taken;
}

// The cases (F12): their nature, their words, and where they lead. The decisions are the last sub-view of the train.
export const DECISIONS_SUB = 4;
export const NATURES = () => [
  { id: 'halt', label: t('ui.nature.halt'), tone: 'halt' },
  { id: 'decision', label: t('ui.nature.decision'), tone: 'todo' },
  { id: 'release', label: t('ui.nature.release'), tone: 'todo' },
  { id: 'disk', label: t('ui.nature.disk'), tone: 'todo' },
  { id: 'kit', label: t('ui.nature.kit'), tone: 'todo' },
];

export const natureOf = (kind) => ({ halt_memory: 'halt', halt_incomplete: 'halt', release: 'release', tree_removable: 'disk', tree_absent: 'disk', disk_alert: 'disk', kit_behind: 'kit', hooks_off: 'kit', decision: 'decision' })[kind] ?? 'kit';

export function caseWords(c) {
  const v = c.vars ?? {};
  switch (c.kind) {
    case 'halt_memory': return { title: t('ui.case.halt_memory'), detail: v.cause, why: t('ui.why.halt_memory'), open: t('ui.open.halt'), to: ['train', 0] };
    case 'halt_incomplete': return { title: t('ui.case.halt_incomplete'), detail: v.cause, why: t('ui.why.halt_incomplete'), open: t('ui.open.halt'), to: ['train', 0] };
    case 'release': return { title: t('ui.case.release', { label: v.label ?? '?' }), detail: null, why: t('ui.why.release'), open: t('ui.open.release'), to: ['version', 1] };
    case 'tree_removable': return { title: t('ui.case.tree_removable', { branch: v.branch ?? '?', days: v.days ?? '?' }), detail: v.path, why: t('ui.why.tree'), open: t('ui.open.disk'), to: ['health', 0] };
    case 'tree_absent': return { title: t('ui.case.tree_absent', { branch: v.branch ?? '?' }), detail: v.path, why: t('ui.why.tree'), open: t('ui.open.disk'), to: ['health', 0] };
    case 'disk_alert': return { title: t('ui.case.disk_alert'), detail: v.alert, why: t('ui.why.disk'), open: t('ui.open.disk'), to: ['health', 0] };
    // Behind the plugin, or behind the kit of another project of the workstation: the case says which.
    case 'kit_behind': return {
      title: v.from === 'plugin' ? t('ui.case.kit_behind_plugin', { kit: v.kit ?? '?', newest: v.newest ?? '?' }) : t('ui.case.kit_behind', { kit: v.kit ?? '?', newest: v.newest ?? '?' }),
      detail: null, why: t('ui.why.kit'), open: t('ui.open.kit'), to: ['health', 2],
    };
    // A product choice the factory may not take: the question whole, its options, who raised it.
    case 'decision': return {
      title: v.title ?? v.id ?? '?', detail: v.question ?? null, options: Array.isArray(v.options) ? v.options : [],
      why: t('ui.why.decision', { by: v.by ?? '?' }), open: t('ui.open.decisions'), to: ['train', DECISIONS_SUB],
    };
    case 'hooks_off': return { title: t('ui.case.hooks_off'), detail: null, why: t('ui.why.hooks'), open: t('ui.open.settings'), to: ['config', 3] };
    default: return { title: c.kind, detail: null, why: '', open: t('ui.open.project'), to: ['train', 0] };
  }
}

export const projectOf = (data, path) => (data?.projects ?? []).find((p) => samePath(p.path, path)) ?? null;
export const casesOf = (data, path) => (data?.cases ?? []).filter((c) => samePath(c.project, path));
export const todoCount = (data, path) => casesOf(data, path).filter((c) => c.state !== 'done').length;

// The kit is older than a version: what it gives does not exist yet.
export const kitBefore = (p, version) => compareVersions(p?.kit?.version, version) < 0;

// The dock counts of a project: ready, refused, waiting on a neighbour (from the last train).
export function dockCounts(p) {
  const dock = p.status?.dock;
  const pending = p.last_train?.pending;
  return {
    ready: dock?.ready?.length ?? 0,
    refused: dock?.refused?.length ?? 0,
    waiting: Array.isArray(pending) ? pending.length : p.last_train?.waiting ?? 0,
  };
}
