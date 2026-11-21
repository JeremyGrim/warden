// The parts every page shares: its header, its tabs, the bar of a sub-view (pills, source, gestures), the period.

import { t } from './ui-api.mjs';
import { gap, h, pills } from './ui-dom.mjs';

// A page header: its title, a line of facts (text, or { text, mono }), a gap, and its gestures.
export function header(title, meta = [], actions = [], gapId = null) {
  return h('header', { class: 'pgh' },
    h('div', { class: 'pghl' },
      h('h1', { class: 'pgt' }, title),
      meta.length || gapId ? h('div', { class: 'pgmeta' }, meta.filter(Boolean).map((m) => (typeof m === 'string' ? h('span', null, m) : h('span', { class: m.mono ? 'mono' : null }, m.text))), gapId ? gap(gapId) : null) : null),
    actions.filter(Boolean));
}

// The tabs of a page, underlined.
export function tabs(items, current, onPick, labelText = '') {
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': labelText }, items.map((item, i) => h('button', {
    type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(current === i), 'data-fk': `tab:${item.label}`, on: { click: () => onPick(i) },
  }, item.label, item.n !== undefined && item.n !== null ? h('span', { class: 'n' }, String(item.n)) : null)));
}

// The bar above a sub-view: an optional title, its pills, where its data comes from, and its gestures.
export function subbar({ title = null, items = [], current = 0, onPick = () => {}, source = null, actions = [] }) {
  return h('div', { class: 'subbar' },
    title ? h('h2', { class: 'sech' }, title) : null,
    items.length ? pills(items, current, onPick) : null,
    h('span', { class: 'grow' }),
    source ? h('span', { class: 'src mono', title: t('ui.source') }, source) : null,
    actions.filter(Boolean));
}

// The period of the measures: 7, 30 or 90 days.
export function period(days, onPick) {
  return h('div', { class: 'ltools' },
    h('span', { class: 'mxgl' }, t('ui.period')),
    h('span', { class: 'seg', role: 'group', 'aria-label': t('ui.period') }, [7, 30, 90].map((n) => h('button', {
      type: 'button', 'aria-pressed': String(days === n), 'data-fk': `days:${n}`, on: { click: () => onPick(n) },
    }, t('ui.period.days', { n })))));
}
