// Building the page: elements and text nodes only, never HTML parsed from a string. A path, a branch, a cause or a log
// line is always text. No `style` attribute either (the Content-Security-Policy drops it): a size goes through the
// element's own style object.

import { getLocale, t } from './ui-api.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// h('div', { class, on: { click }, style: { width }, data-x, aria-x }, ...children)
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'value') el.value = value;
    else if (key === 'disabled' || key === 'checked') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export const ICONS = {
  inbox: ['M4 13h4l1.5 3h5L16 13h4', 'M5.5 5h13L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z'],
  close: ['M6 6l12 12M18 6 6 18'],
  menu: ['M4 7h16M4 12h16M4 17h16'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-3.5-3.5'],
  shield: ['M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3Z'],
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(key, String(value));
  }
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Numbers, sizes, dates and durations, in the page's language.
export const GIB = 1024 ** 3;
const numbers = (digits) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: digits });
export const fmtNum = (n, digits = 1) => (Number.isFinite(Number(n)) && n !== null ? numbers(digits).format(Number(n)) : '—');
export const fmtGib = (bytes) => (Number.isFinite(bytes) ? t('ui.unit.gib', { n: fmtNum(bytes / GIB, 1) }) : '—');
export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return t('ui.unit.bytes', { n: bytes });
  if (bytes < 1024 ** 2) return t('ui.unit.kib', { n: fmtNum(bytes / 1024, 1) });
  if (bytes < GIB) return t('ui.unit.mib', { n: fmtNum(bytes / 1024 ** 2, 1) });
  return fmtGib(bytes);
}
export const fmtSeconds = (s) => (Number.isFinite(Number(s)) && s !== null ? t('ui.unit.seconds', { n: fmtNum(s, 1) }) : '—');
export const fmtMinutes = (m) => (Number.isFinite(Number(m)) && m !== null ? t('ui.unit.minutes', { n: fmtNum(m, 2) }) : '—');

const validDate = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? '');
  return Number.isNaN(date.getTime()) ? null : date;
};
export function fmtDate(value) {
  const date = validDate(value);
  if (!date) return value ? String(value) : '—';
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
export function fmtTime(value) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) : '—';
}
export function fmtClock(value) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) : '—';
}
export function fmtDay(value) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short' }).format(date) : '—';
}
// How long since a moment: minutes, hours and minutes, days.
export function fmtAge(value, now = Date.now()) {
  const date = validDate(value);
  if (!date) return '—';
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60000));
  if (minutes < 1) return t('ui.age.now');
  if (minutes < 60) return t('ui.age.minutes', { n: minutes });
  if (minutes < 48 * 60) return t('ui.age.hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
  return t('ui.age.days', { n: Math.floor(minutes / 1440) });
}
export const minutesSince = (value, now = Date.now()) => {
  const date = validDate(value);
  return date ? (now - date.getTime()) / 60000 : null;
};

export const short = (commit) => (commit ? String(commit).slice(0, 7) : '—');
export const sameCommit = (a, b) => Boolean(a && b) && Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));
export const samePath = (a, b) => String(a ?? '').replace(/\\/g, '/').toLowerCase() === String(b ?? '').replace(/\\/g, '/').toLowerCase();

// A path of the work folder as the server reads it (GET /api/file): relative, with forward slashes. Null outside it.
export function relWork(work, path) {
  if (!work || !path) return null;
  const base = String(work).replace(/\\/g, '/').replace(/\/+$/, '');
  const full = String(path).replace(/\\/g, '/');
  if (!/^([a-z]:)?\//i.test(full)) return full.replace(/^\.work\//, '').replace(/^\.\//, '');
  if (full.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return full.slice(base.length + 1);
  return null;
}

// -1, 0 or 1 between two "a.b.c" versions, as the server compares them.
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '0.0.0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

// The small pieces every view uses.
export const badge = (tone, label, big = false) => h('span', { class: big ? 'badge big' : 'badge', 'data-d': tone }, h('i', { 'aria-hidden': 'true' }), label);
export const gap = (id) => h('span', { class: 'gap', title: t('ui.gap.title') }, t('ui.gap', { id }));
export const mono = (text) => h('span', { class: 'mono' }, text ?? '—');
export const muted = (text) => h('span', { class: 'muted' }, text);
export const absent = (kit) => h('span', { class: 'absent' }, t('ui.absent', { kit: kit ?? '?' }));

export function btn(label, onClick, { kind = '', small = false, disabled = false, title = null, fk = null } = {}) {
  const cls = ['btn', kind ? `btn-${kind}` : '', small ? 'btn-s' : ''].filter(Boolean).join(' ');
  return h('button', { type: 'button', class: cls, disabled, title, 'data-fk': fk, on: { click: onClick } }, label);
}
export const link = (label, onClick) => h('button', { type: 'button', class: 'lnk', on: { click: onClick } }, label);

// Key and value pairs: [label, value, { mono, gap }]
export function kv(rows) {
  return h('div', { class: 'kv' }, rows.filter(Boolean).map(([key, value, opts = {}]) => [
    h('span', { class: 'k' }, key),
    h('span', { class: opts.mono ? 'v mono' : 'v' }, value === null || value === undefined || value === '' ? '—' : value, opts.gap ? gap(opts.gap) : null),
  ]));
}

// A bar against a budget: `ratio` filled, an optional tick (the budget), amber past it.
export function bar(ratio, { tick = null, over = false } = {}) {
  const clamp = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  const fill = h('i');
  fill.style.width = `${Math.round(clamp(ratio) * 1000) / 10}%`;
  const el = h('span', { class: 'mbar', 'data-over': over ? '1' : '0', 'aria-hidden': 'true' }, fill);
  if (tick !== null) {
    const mark = h('u');
    mark.style.left = `${Math.round(clamp(tick) * 1000) / 10}%`;
    el.append(mark);
  }
  return el;
}

// A box of rows, as the mockup draws them.
export const box = (...rows) => h('div', { class: 'box' }, rows.flat().filter(Boolean).map((r) => (r.classList?.contains('boxr') || r.classList?.contains('mrow') ? r : h('div', { class: 'boxr' }, r))));
export const boxRow = (...children) => h('div', { class: 'boxr' }, ...children);
export const note = (tone, label, text, ...rest) => box(boxRow(badge(tone, label), h('span', { class: 'grow' }, text), ...rest));
export const caption = (gapId, text) => h('div', { class: 'gapc' }, gapId ? gap(gapId) : null, h('span', null, text));
export const section = (title, ...children) => h('section', { class: 'sect' }, h('h2', { class: 'sech' }, title), ...children);
// A field of a form in the drawer: its label, then what the person writes or picks.
export const field = (label, ...children) => h('div', { class: 'dsec' }, h('span', { class: 'dl' }, label), ...children);
export const skeleton = () => h('div', { class: 'skel', 'aria-busy': 'true' }, h('div', { class: 'sk sk-a' }), h('div', { class: 'sk sk-b' }), h('div', { class: 'sk sk-c' }));

// A measure row: label, value (with a badge or a gap), and a bar with its caption.
export function measure(label, value, { tone = null, toneLabel = null, mono: isMono = false, ratio = null, tick = null, over = false, cap = '', gapId = null } = {}) {
  return h('div', { class: 'mrow' },
    h('span', { class: 'k' }, label),
    h('span', { class: 'mv' }, tone ? badge(tone, toneLabel) : null, h('span', { class: isMono ? 'mono wrap' : 'wrap' }, value ?? '—'), gapId ? gap(gapId) : null),
    h('span', { class: 'mcap' }, ratio !== null ? bar(ratio, { tick, over }) : null, cap ? h('span', null, cap) : null));
}

// Pills under a title: the sub-views of a tab.
export function pills(items, current, onPick) {
  return h('div', { class: 'subs', role: 'tablist' }, items.map((item, i) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(current === i), 'data-fk': `pill:${item.label}`, on: { click: () => onPick(i) },
  }, item.label, item.n !== undefined && item.n !== null ? h('span', { class: 'n' }, String(item.n)) : null)));
}

// Redraws without losing the field the person is typing in: an element marked `data-fk` gets its focus back.
export function keepFocus(fn) {
  const active = document.activeElement;
  const key = active?.dataset?.fk ?? null;
  let range = null;
  try {
    range = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  } catch {
    range = null;
  }
  fn();
  if (!key) return;
  const again = [...document.querySelectorAll('[data-fk]')].find((el) => el.dataset.fk === key);
  if (!again) return;
  again.focus({ preventScroll: true });
  if (range && typeof again.setSelectionRange === 'function') {
    try {
      again.setSelectionRange(range[0], range[1]);
    } catch {
      // A select or a button has no selection.
    }
  }
}
