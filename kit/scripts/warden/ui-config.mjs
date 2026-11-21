// A project's configuration (§7). The project files are read only, key by key: a change of them goes through a
// deposit, like any change. The workstation settings are written at once, in this clone, by their own gesture;
// `core.hooksPath` is only ever turned on.

import { t } from './ui-api.mjs';
import { badge, box, boxRow, btn, caption, gap, h, icon, link, mono } from './ui-dom.mjs';
import { subbar } from './ui-views.mjs';

// The keys ui.mjs writes (SETTINGS there), with what each means.
const SETTING_MEANINGS = {
  'warden.factory': 'ui.cfg.s_factory', 'warden.slot': 'ui.cfg.s_slot', 'warden.tasks': 'ui.cfg.s_tasks', 'warden.ghsa': 'ui.cfg.s_ghsa', 'warden.locale': 'ui.cfg.s_locale',
};
const SETTINGS = Object.keys(SETTING_MEANINGS);

// [key, meaning key, default]; a default in quotes is a JSON value shown as it is.
const FACTORY = [
  ['ui.cfg.group_repo', [
    ['main_branch', 'ui.cfg.main_branch', '"main"'], ['remote', 'ui.cfg.remote', '"origin"'], ['work_dir', 'ui.cfg.work_dir', '".work"'],
    ['slot.name', 'ui.cfg.slot_name', '"push-slot"'], ['slot.log', 'ui.cfg.slot_log', 'null']]],
  ['ui.cfg.group_verify', [
    ['verify.rust', 'ui.cfg.verify_rust', 'null'], ['verify.npm_advisories', 'ui.cfg.verify_npm', 'null'], ['verify.steps', 'ui.cfg.verify_steps', '[]'],
    ['verify.all', 'ui.cfg.verify_all', '[]'], ['verify.when_missing', 'ui.cfg.verify_when_missing', '"record"'], ['verify.transient_patterns', 'ui.cfg.verify_transient', '[]']]],
  ['ui.col.train', [
    ['train.branch', 'ui.cfg.train_branch', '"warden-train"'], ['train.dock', 'ui.cfg.train_dock', '"train-ready"'], ['train.max_batch', 'ui.cfg.train_max_batch', '4'],
    ['train.install', 'ui.cfg.train_install', 'null'], ['train.build', 'ui.cfg.train_build', 'null'], ['train.min_free_memory_gib', 'ui.cfg.train_memory', '8'],
    ['train.memory_per_job_gib', 'ui.cfg.train_memory_job', '2'], ['train.retry_minutes', 'ui.cfg.train_retry', '10'], ['train.halt_notice_minutes', 'ui.cfg.train_notice', '30']]],
  ['ui.cfg.group_rest', [
    ['history.keep_days', 'ui.cfg.history_keep', '90'], ['version.line', 'ui.cfg.version_line', 'ui.cfg.default_line'], ['version.files', 'ui.cfg.version_files', 'ui.cfg.default_files'],
    ['release', 'ui.cfg.release', 'null'], ['fixes', 'ui.cfg.fixes', '["version","lock","generated"]']]],
];
const RULES = [
  ['ui.cfg.group_root', [['root', 'ui.cfg.r_root'], ['required', 'ui.cfg.r_required'], ['forbidden_segments', 'ui.cfg.r_artifact'], ['forbidden_extensions', 'ui.cfg.r_artifact'], ['forbidden_lockfiles', 'ui.cfg.r_lockfiles']]],
  ['ui.cfg.group_sizes', [['max_size_kib', 'ui.cfg.r_size'], ['size_exceptions', 'ui.cfg.r_size_exceptions'], ['max_lines', 'ui.cfg.r_lines'], ['warn_lines', 'ui.cfg.r_warn_lines'], ['lines_exempt', 'ui.cfg.r_lines_exempt']]],
  ['ui.cfg.group_secrets', [['secrets', 'ui.cfg.r_secrets'], ['secret_exceptions', 'ui.cfg.r_secret_exceptions'], ['foreign_code', 'ui.cfg.r_foreign'], ['single_source', 'ui.cfg.r_single_source'], ['docs', 'ui.cfg.r_docs'], ['versions', 'ui.cfg.r_versions']]],
  ['ui.cfg.group_architecture', [['boundaries.rust', 'ui.cfg.r_boundaries'], ['boundaries.node', 'ui.cfg.r_boundaries'], ['single_test_binary', 'ui.cfg.r_architecture'], ['provenance', 'ui.cfg.r_architecture'], ['registry', 'ui.cfg.r_architecture'], ['debts', 'ui.cfg.r_architecture'], ['chokepoints', 'ui.cfg.r_architecture']]],
];
const DISK = [
  ['ui.cfg.group_disk', [
    ['min_free_gib', 'ui.cfg.d_min_free', '60'], ['max_build_gib', 'ui.cfg.d_max_build', '40'], ['max_incremental_gib', 'ui.cfg.d_max_incremental', '6'],
    ['max_worktrees', 'ui.cfg.d_max_worktrees', '2'], ['max_worktree_age_days', 'ui.cfg.d_max_age', '7'], ['frozen_copies', 'ui.cfg.d_frozen', '[]']]],
];
const DISK_LOCAL = [['max_worktrees', 'ui.cfg.d_max_worktrees'], ['shared_caches', 'ui.cfg.d_shared_caches'], ['roots', 'ui.cfg.d_roots'], ['builds', 'ui.cfg.d_builds']];

const read = (obj, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' && k in v ? v[k] : undefined), obj);
const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const defaultText = (value) => (value?.startsWith('ui.') ? t(value) : value);

function row(key, value, meaning, { dflt = null, missing = null, control = null, action = null, gapId = null }) {
  return h('div', { class: 'cfrow' },
    h('span', { class: 'cfk mono wrap' }, key),
    control ?? (value === undefined ? h('span', { class: 'cfv quiet' }, missing ?? t('ui.cfg.absent')) : h('span', { class: 'cfv mono wrap' }, show(value))),
    h('span', { class: 'cfs' }, meaning, dflt !== null ? ` · ${t('ui.cfg.default', { value: defaultText(dflt) })}` : '', gapId ? gap(gapId) : null),
    h('span', { class: 'lacts' }, action));
}

const groupHead = (title, n) => h('div', { class: 'gh' }, title, h('span', null, String(n)));

function matches(ctx, key, meaning) {
  const q = (ctx.ui.cfq ?? '').toLowerCase();
  return !q || `${key} ${meaning}`.toLowerCase().includes(q);
}

function fileTable(ctx, file, groups, { rules = false } = {}) {
  const out = [];
  if (file === null) out.push(caption(null, rules ? t('ui.cfg.rules_missing') : t('ui.cfg.file_missing')));
  else if (file?.unreadable) out.push(box(boxRow(badge('halt', t('ui.train.unreadable')), h('span', { class: 'grow' }, t('ui.cfg.unreadable_text')))));
  const data = file && !file.unreadable ? file : {};
  const known = new Set();
  const table = h('div', { class: 'cftab' });
  let shown = 0;
  for (const [title, keys] of groups) {
    const rows = [];
    for (const [key, meaningKey, dflt] of keys) {
      known.add(key.split('.')[0]);
      const meaning = t(meaningKey);
      if (!matches(ctx, key, meaning)) continue;
      const value = read(data, key);
      rows.push(row(key, value, meaning, rules ? { missing: t('ui.cfg.not_checked') } : { dflt: dflt ?? null }));
    }
    if (rows.length) table.append(groupHead(t(title), rows.length), ...rows);
    shown += rows.length;
  }
  const others = Object.keys(data).filter((k) => !known.has(k) && matches(ctx, k, ''));
  if (others.length) {
    table.append(groupHead(t('ui.cfg.group_other'), others.length), ...others.map((k) => row(k, data[k], t('ui.cfg.undescribed'), {})));
    shown += others.length;
  }
  out.push(shown ? table : h('p', { class: 'empty' }, t('ui.cfg.no_match')));
  return out;
}

function settingControl(ctx, d, key) {
  const id = `${d.path}|${key}`;
  const current = (d.settings?.[key] ?? []).at(-1) ?? '';
  const edited = ctx.ui.edits[id];
  const value = edited ?? current;
  const changed = edited !== undefined && edited !== current;
  const write = () => {
    const next = String(ctx.ui.edits[id] ?? '').trim();
    delete ctx.ui.edits[id];
    const words = next ? `git config ${key} ${next}` : `git config --unset ${key}`;
    ctx.gesture({ project: d, gesture: 'setting.set', args: { key, value: next }, title: t('ui.cfg.write_title', { key }), command: words, cwd: d.path });
  };
  const onEdit = (e) => {
    if (e.target.value === current) delete ctx.ui.edits[id];
    else ctx.ui.edits[id] = e.target.value;
    ctx.render();
  };
  const control = key === 'warden.locale'
    ? h('select', { class: 'cfin', 'aria-label': key, 'data-fk': `cfg:${key}`, on: { change: onEdit } }, [['', t('ui.cfg.unset')], ['en', 'en'], ['fr', 'fr']].map(([v, l]) => h('option', { value: v }, l)))
    : h('input', { class: 'cfin', type: 'text', 'aria-label': key, placeholder: t('ui.cfg.unset'), value, autocomplete: 'off', spellcheck: 'false', 'data-fk': `cfg:${key}`, on: { input: onEdit, keydown: (e) => {
      if (e.key === 'Enter' && changed) {
        e.preventDefault();
        write();
      }
    } } });
  if (key === 'warden.locale') control.value = value;
  const action = changed ? btn(String(value).trim() ? t('ui.cfg.write') : t('ui.cfg.unset_action'), write, { kind: 'p', small: true, fk: `cfg:${key}:write` }) : null;
  return { control, action, changed };
}

function stationView(ctx, d) {
  const table = h('div', { class: 'cftab' });
  const local = [];
  for (const key of SETTINGS) {
    const meaning = t(SETTING_MEANINGS[key]);
    if (!matches(ctx, key, meaning)) continue;
    const { control, action } = settingControl(ctx, d, key);
    local.push(row(key, null, meaning, { control, action }));
  }
  const agentTrees = d.settings?.['warden.agentTrees'] ?? [];
  if (matches(ctx, 'warden.agentTrees', t('ui.cfg.s_agenttrees'))) {
    local.push(row('warden.agentTrees', agentTrees.length ? agentTrees.join(', ') : undefined, t('ui.cfg.s_agenttrees'), { missing: t('ui.cfg.unset'), action: h('span', { class: 'quiet' }, t('ui.cfg.read_only')) }));
  }
  if (matches(ctx, 'core.hooksPath', t('ui.cfg.s_hooks'))) {
    const on = d.status.hooks_active;
    const hooksPath = (d.settings?.['core.hooksPath'] ?? []).at(-1) ?? '';
    local.push(row('core.hooksPath', null, t('ui.cfg.s_hooks'), {
      control: h('span', { class: 'cfv wrap' }, badge(on ? 'ok' : 'todo', on ? t('ui.hooks.active') : t('ui.hooks.inactive')), hooksPath ? mono(hooksPath) : null),
      action: on ? null : btn(t('ui.gesture.hooks_on'), () => ctx.hooksOn(d), { kind: 'p', small: true, fk: 'cfg:hooks' }),
    }));
  }
  if (local.length) table.append(groupHead(t('ui.cfg.group_clone'), local.length), ...local);
  const diskLocal = d.config?.['disk.local'];
  const localRows = DISK_LOCAL.filter(([key, meaning]) => matches(ctx, key, t(meaning)))
    .map(([key, meaning]) => row(key, diskLocal && !diskLocal.unreadable ? read(diskLocal, key) : undefined, t(meaning), { missing: diskLocal ? t('ui.cfg.absent') : t('ui.cfg.local_missing') }));
  if (diskLocal && !diskLocal.unreadable) {
    for (const key of Object.keys(diskLocal).filter((k) => !DISK_LOCAL.some(([x]) => x === k) && matches(ctx, k, ''))) localRows.push(row(key, diskLocal[key], t('ui.cfg.d_replaces'), {}));
  }
  if (localRows.length) table.append(groupHead(t('ui.cfg.group_local'), localRows.length), ...localRows);
  if (matches(ctx, 'warden.projects', t('ui.cfg.s_projects'))) {
    table.append(groupHead(t('ui.cfg.group_global'), 1), row('warden.projects', null, t('ui.cfg.s_projects'), { control: h('span', { class: 'cfv' }, link(t('ui.cfg.projects_link'), () => ctx.go('projects'))) }));
  }
  return table.childElementCount ? table : h('p', { class: 'empty' }, t('ui.cfg.no_match'));
}

export function renderConfig(ctx, d) {
  const sub = ctx.state.sub.config ?? 0;
  const names = ['factory', 'rules', 'disk'];
  const out = [subbar({
    items: [{ label: 'factory.json' }, { label: 'rules.json' }, { label: 'disk.json' }, { label: t('ui.cfg.station') }],
    current: sub, onPick: (i) => ctx.setSub('config', i),
    source: sub < 3 ? t('ui.cfg.source_project', { file: `config/${names[sub]}.json` }) : t('ui.cfg.source_station'),
  })];
  if (sub < 3) out.push(box(boxRow(badge('wait', t('ui.cfg.by_deposit')), h('span', { class: 'grow' }, t('ui.cfg.by_deposit_text'), ' ', gap('M16')))));
  else out.push(caption(null, t('ui.cfg.station_text')));
  out.push(h('div', { class: 'ltools' }, h('label', { class: 'q' }, icon('search', 14), h('input', {
    type: 'search', placeholder: t('ui.cfg.search'), 'aria-label': t('ui.cfg.search'), value: ctx.ui.cfq ?? '', autocomplete: 'off', 'data-fk': 'cfg:q',
    on: { input: (e) => { ctx.ui.cfq = e.target.value; ctx.render(); } },
  }))));
  if (sub === 0) out.push(...fileTable(ctx, d.config?.factory ?? null, FACTORY));
  else if (sub === 1) out.push(...fileTable(ctx, d.config?.rules ?? null, RULES, { rules: true }));
  else if (sub === 2) out.push(...fileTable(ctx, d.config?.disk ?? null, DISK));
  else out.push(stationView(ctx, d));
  return out;
}
