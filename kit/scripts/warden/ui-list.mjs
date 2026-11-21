// The lists of the page: a strip that filters by state, chips by project or name, selects, a search, rows that open on
// their detail, and "show more". Each list keeps its filters and its open rows across rereads, by its key.

import { t } from './ui-api.mjs';
import { badge, caption, h, icon, keepFocus } from './ui-dom.mjs';

const STATES = new Map();

function stateOf(key, page) {
  if (!STATES.has(key)) STATES.set(key, { q: '', st: 'all', fac: 'all', sel: {}, n: page, open: new Set() });
  return STATES.get(key);
}

// A cell: its main text, a line under it, a badge before it. `opts.mono` for a path or a commit, `opts.right` for a date.
export function cell(main, sub = null, { tone = null, toneLabel = null, mono = false, strong = false, quiet = false, right = false, extra = null } = {}) {
  const cls = ['lc', mono ? 'm' : '', quiet ? 'qt' : '', right ? 'r' : ''].filter(Boolean).join(' ');
  return h('span', { class: cls },
    tone ? badge(tone, toneLabel) : null,
    main === null || main === undefined || main === '' ? null : h('span', { class: strong ? 'ct b' : 'ct' }, String(main)),
    sub ? h('span', { class: 'cs' }, sub) : null,
    extra);
}

// list(key, {
//   title, cols: [label], right: index of the right column, grid: CSS columns, minWidth,
//   rows: [{ id, st, fac, search, cells: [node], detail: () => node, actions: [{ label, run, primary }], go }],
//   strip: [{ id, label, tone }], stripLabel, facets: true, selects: [{ label, options: [[value, label]], test }],
//   search: placeholder, empty, gapId, cap, page })
export function list(key, cfg) {
  const holder = h('div', { class: 'list' });
  const draw = () => keepFocus(() => holder.replaceChildren(...build(key, cfg, draw)));
  holder.replaceChildren(...build(key, cfg, draw));
  return holder;
}

function build(key, cfg, redraw) {
  const page = cfg.page ?? 25;
  const s = stateOf(key, page);
  const set = (patch) => {
    Object.assign(s, patch, { n: page });
    redraw();
  };
  let rows = cfg.rows ?? [];
  for (const [i, select] of (cfg.selects ?? []).entries()) {
    const value = s.sel[i] ?? 'all';
    if (value !== 'all') rows = rows.filter((r) => select.test(r, value));
  }
  if (s.q) {
    const q = s.q.toLowerCase();
    rows = rows.filter((r) => String(r.search ?? '').toLowerCase().includes(q));
  }
  const facetRows = s.st === 'all' ? rows : rows.filter((r) => r.st === s.st);
  if (s.fac !== 'all') rows = rows.filter((r) => r.fac === s.fac);
  const stripRows = rows;
  if (s.st !== 'all') rows = rows.filter((r) => r.st === s.st);
  const total = rows.length;
  const filtered = Boolean(s.q) || s.st !== 'all' || s.fac !== 'all' || Object.values(s.sel).some((v) => v !== 'all');
  const out = [];

  if (cfg.title) out.push(h('h2', { class: 'sech' }, cfg.title));
  if (cfg.strip) {
    const entry = (id, label, tone, n) => h('button', {
      type: 'button', 'aria-pressed': String(s.st === id), 'data-fk': `${key}:st:${id}`,
      on: { click: () => set({ st: s.st === id && id !== 'all' ? 'all' : id }) },
    }, h('b', null, String(n)), tone ? badge(tone, label) : label);
    out.push(h('div', { class: 'lstrip', role: 'group', 'aria-label': cfg.stripLabel ?? '' },
      entry('all', t('ui.list.all'), null, stripRows.length),
      cfg.strip.map((x) => entry(x.id, x.label, x.tone, stripRows.filter((r) => r.st === x.id).length))));
  }
  if (cfg.facets) {
    const counts = new Map();
    for (const r of facetRows) if (r.fac) counts.set(r.fac, (counts.get(r.fac) ?? 0) + 1);
    if (counts.size > 1 || s.fac !== 'all') {
      out.push(h('div', { class: 'chips' }, [...counts.keys()].sort().map((fac) => h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(s.fac === fac), 'data-fk': `${key}:fac:${fac}`,
        on: { click: () => set({ fac: s.fac === fac ? 'all' : fac }) },
      }, fac, h('span', { class: 'n' }, String(counts.get(fac)))))));
    }
  }
  if (cfg.search !== false || cfg.selects?.length) {
    const tools = h('div', { class: 'ltools' });
    if (cfg.search !== false) {
      tools.append(h('label', { class: 'q' }, icon('search', 14), h('input', {
        type: 'search', placeholder: cfg.search ?? t('ui.list.search'), 'aria-label': cfg.search ?? t('ui.list.search'), value: s.q, autocomplete: 'off', 'data-fk': `${key}:q`,
        on: { input: (e) => set({ q: e.target.value }) },
      })));
    }
    for (const [i, select] of (cfg.selects ?? []).entries()) {
      const el = h('select', { 'aria-label': select.label, 'data-fk': `${key}:sel:${i}`, on: { change: (e) => set({ sel: { ...s.sel, [i]: e.target.value } }) } },
        [['all', select.all ?? t('ui.list.all')], ...select.options].map(([value, label]) => h('option', { value }, label)));
      el.value = s.sel[i] ?? 'all';
      tools.append(h('label', { class: 'sel' }, el));
    }
    if (filtered) tools.append(h('button', { type: 'button', class: 'lnk quiet', on: { click: () => set({ q: '', st: 'all', fac: 'all', sel: {} }) } }, t('ui.list.reset')));
    tools.append(h('span', { class: 'grow' }));
    const all = (cfg.rows ?? []).length;
    tools.append(h('span', { class: 'count' }, filtered && total !== all ? t('ui.list.count_of', { n: total, total: all }) : t('ui.list.count', { n: total })));
    out.push(tools);
  }
  if (cfg.cap) out.push(caption(cfg.gapId ?? null, cfg.cap));
  if (!total) {
    out.push(h('p', { class: 'empty' }, filtered ? t('ui.list.none_filtered') : cfg.empty ?? t('ui.list.none')));
    return out;
  }

  const hasActions = (cfg.rows ?? []).some((r) => r.actions?.length);
  const grid = cfg.grid + (hasActions ? ` ${cfg.actionsWidth ?? 'auto'}` : '');
  const table = h('div', { class: 'tbl' });
  table.style.minWidth = `${cfg.minWidth ?? 760}px`;
  const head = h('div', { class: 'tr th', 'aria-hidden': 'true' }, cfg.cols.map((label, i) => h('span', { class: i === cfg.right ? 'r' : null }, label)), hasActions ? h('span') : null);
  head.style.gridTemplateColumns = grid;
  table.append(head);
  for (const r of rows.slice(0, s.n)) {
    const open = Boolean(r.detail) && s.open.has(r.id);
    const toggle = () => {
      if (s.open.has(r.id)) s.open.delete(r.id);
      else s.open.add(r.id);
      redraw();
    };
    const go = r.go ?? (r.detail ? toggle : null);
    const row = h('div', {
      class: go ? 'tr click' : 'tr', role: go ? 'button' : null, tabindex: go ? '0' : null,
      'aria-expanded': r.detail ? String(open) : null, 'data-fk': go ? `${key}:row:${r.id}` : null,
      on: go ? {
        click: go,
        keydown: (e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            go();
          }
        },
      } : null,
    }, r.cells, hasActions ? h('span', { class: 'lacts' }, (r.actions ?? []).map((a) => h('button', {
      type: 'button', class: a.primary ? 'btn btn-p btn-s' : 'btn btn-s', disabled: a.disabled ?? false, title: a.title ?? null, 'data-fk': `${key}:act:${r.id}:${a.label}`,
      on: { click: (e) => { e.stopPropagation(); a.run(); }, keydown: (e) => e.stopPropagation() },
    }, a.label))) : null);
    row.style.gridTemplateColumns = grid;
    table.append(row);
    if (open) table.append(h('div', { class: 'ldet' }, r.detail()));
  }
  out.push(h('div', { class: 'tblwrap' }, table));
  if (total > s.n) {
    out.push(h('button', { type: 'button', class: 'more', 'data-fk': `${key}:more`, on: { click: () => { s.n += page; redraw(); } } }, t('ui.list.more', { n: Math.min(page, total - s.n) })));
  }
  return out;
}
