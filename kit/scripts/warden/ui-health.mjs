// A project's health (F8, F9): the disk against its budgets, the trees, the memory against the train's threshold, and
// the kit with its hooks and the plugin. The full disk report walks folders: it is read on this tab only. The factory
// cleans its own tree; another tree is the person's, cleaned alone on their gesture, and never removed from here.

import { t } from './ui-api.mjs';
import { absent, badge, box, btn, caption, compareVersions, fmtClock, fmtDate, fmtGib, fmtNum, GIB, h, kv, measure, samePath, skeleton } from './ui-dom.mjs';
import { cell, list } from './ui-list.mjs';
import { factoryOf } from './ui-model.mjs';
import { subbar } from './ui-views.mjs';

const roleText = (role) => ({ factory: t('ui.role.factory'), agent: t('ui.role.agent'), unset: t('ui.role.unset') })[role] ?? String(role ?? '—');

// The factory's own cleanup: always listed first, then applied with the same `--deep`.
export function cleanOwn(ctx, d, deep = false) {
  const words = (apply) => ['node scripts/warden/disk.mjs clean --own', deep ? '--deep' : '', apply ? '--apply' : ''].filter(Boolean).join(' ');
  ctx.gesture({
    project: d, gesture: 'disk.clean_own', args: { deep, apply: false }, title: t('ui.clean.list_title'), command: words(false), cwd: d.status.factory_tree,
    option: { label: '--deep', on: deep, set: (value) => cleanOwn(ctx, d, value) },
    next: () => ({
      label: deep ? t('ui.clean.apply_deep') : t('ui.clean.apply'),
      run: () => ctx.gesture({ project: d, gesture: 'disk.clean_own', args: { deep, apply: true }, title: t('ui.gesture.clean_own'), command: words(true), cwd: d.status.factory_tree }),
    }),
  });
}

// Another tree of the clone, on the person's gesture: listed first, then cleaned with the same `--deep`. It runs from
// the project root; the kit refuses a tree that is not the clone's, the factory tree, and a tree being compiled, and it
// never removes a worktree.
export function cleanTree(ctx, d, tree, deep = false) {
  const words = (apply) => ['node scripts/warden/disk.mjs clean --tree', tree, deep ? '--deep' : '', apply ? '--apply' : ''].filter(Boolean).join(' ');
  ctx.gesture({
    project: d, gesture: 'disk.clean_tree', args: { tree, deep, apply: false }, title: t('ui.clean.tree_list'), command: words(false), cwd: d.path,
    option: { label: '--deep', on: deep, set: (value) => cleanTree(ctx, d, tree, value) },
    next: () => ({
      label: deep ? t('ui.clean.apply_deep') : t('ui.clean.apply'),
      run: () => ctx.gesture({ project: d, gesture: 'disk.clean_tree', args: { tree, deep, apply: true }, title: deep ? t('ui.clean.apply_deep') : t('ui.clean.apply'), command: words(true), cwd: d.path }),
    }),
  });
}

function diskRows(data) {
  const b = data.budgets ?? {};
  const rows = [];
  const minFree = b.min_free_gib;
  rows.push(measure(t('ui.disk.free'), fmtGib(data.free), {
    ratio: minFree ? data.free / Math.max(data.free, minFree * GIB * 2) : null, tick: minFree ? (minFree * GIB) / Math.max(data.free, minFree * GIB * 2) : null,
    over: minFree ? data.free < minFree * GIB : false, cap: minFree ? t('ui.disk.min', { n: minFree }) : t('ui.disk.no_budget'),
    tone: minFree && data.free < minFree * GIB ? 'halt' : null, toneLabel: t('ui.disk.under'),
  }));
  const m = data.measures;
  if (m) {
    const build = m.build ?? {};
    const over = (bytes, max) => Boolean(max) && bytes > max * GIB;
    rows.push(measure(t('ui.disk.build'), t('ui.disk.build_value', { size: fmtGib(build.bytes ?? 0), files: fmtNum(build.files ?? 0, 0), links: Array.isArray(build.links) ? build.links.length : fmtNum(build.links ?? 0, 0) }), {
      ratio: b.max_build_gib ? (build.bytes ?? 0) / (b.max_build_gib * GIB) : null, over: over(build.bytes ?? 0, b.max_build_gib), cap: b.max_build_gib ? t('ui.disk.max', { n: b.max_build_gib }) : t('ui.disk.no_budget'),
    }));
    rows.push(measure(t('ui.disk.incremental'), fmtGib(m.incremental ?? 0), {
      ratio: b.max_incremental_gib ? (m.incremental ?? 0) / (b.max_incremental_gib * GIB) : null, over: over(m.incremental ?? 0, b.max_incremental_gib), cap: b.max_incremental_gib ? t('ui.disk.max', { n: b.max_incremental_gib }) : t('ui.disk.no_budget'),
    }));
    for (const c of m.caches ?? []) {
      rows.push(measure(t('ui.disk.cache'), t('ui.disk.cache_value', { path: c.path, size: fmtGib(c.bytes), free: fmtGib(c.free) }), {
        mono: false, ratio: c.max_gib ? c.bytes / (c.max_gib * GIB) : null, over: over(c.bytes, c.max_gib), cap: c.max_gib ? t('ui.disk.max', { n: fmtNum(c.max_gib, 1) }) : t('ui.disk.no_budget'),
      }));
    }
    if (!(m.caches ?? []).length) rows.push(measure(t('ui.disk.cache'), t('ui.disk.no_cache')));
  }
  const trees = data.trees ?? [];
  rows.push(measure(t('ui.disk.trees'), t('ui.disk.trees_value', { n: trees.length }), {
    ratio: b.max_worktrees ? trees.length / Math.max(trees.length, b.max_worktrees + 1) : null, tick: b.max_worktrees ? b.max_worktrees / Math.max(trees.length, b.max_worktrees + 1) : null,
    over: Boolean(b.max_worktrees) && trees.length > b.max_worktrees, cap: b.max_worktrees ? t('ui.disk.trees_max', { n: b.max_worktrees }) : t('ui.disk.no_budget'),
  }));
  if (b.max_worktree_age_days) {
    const oldest = trees.reduce((max, tree) => Math.max(max, tree.ageDays ?? 0), 0);
    rows.push(measure(t('ui.disk.age'), t('ui.period.days', { n: oldest }), {
      ratio: oldest / Math.max(oldest, b.max_worktree_age_days * 1.5), tick: b.max_worktree_age_days / Math.max(oldest, b.max_worktree_age_days * 1.5),
      over: oldest > b.max_worktree_age_days, cap: t('ui.disk.age_max', { n: b.max_worktree_age_days }),
    }));
  }
  const alerts = data.alerts ?? [];
  if (alerts.length) for (const alert of alerts) rows.push(measure(t('ui.disk.alert'), alert, { tone: 'halt', toneLabel: t('ui.disk.over') }));
  else rows.push(measure(t('ui.disk.alert'), t('ui.disk.no_alert')));
  return rows;
}

function treesList(ctx, d, data) {
  const trees = data.trees ?? [];
  const older = Boolean(d.absent?.clean_tree);
  // What the person may do to a tree, said in its detail: clean it alone, or why not.
  const cleanup = (tree) => {
    if (tree.absent) return [t('ui.tree.cleanup'), t('ui.tree.cleanup_gone')];
    if (older) return [t('ui.tree.cleanup'), h('span', { class: 'wrap' }, t('ui.tree.cleanup_older'), ' ', absent(d.kit.version))];
    return [t('ui.tree.cleanup'), t('ui.tree.cleanup_text')];
  };
  return list(`trees:${d.path}`, {
    title: t('ui.disk.trees'),
    cols: [t('ui.col.state'), t('ui.col.tree_branch'), t('ui.col.age'), t('ui.col.modified'), t('ui.col.unpushed')],
    grid: '170px minmax(0,1.8fr) 100px 100px 100px', minWidth: 980, actionsWidth: '170px',
    strip: [{ id: 'removable', label: t('ui.tree.removable'), tone: 'todo' }, { id: 'busy', label: t('ui.tree.busy'), tone: 'idle' }, { id: 'absent', label: t('ui.tree.absent'), tone: 'unk' }],
    stripLabel: t('ui.col.state'), search: t('ui.disk.search_trees'), empty: t('ui.disk.trees_empty'),
    cap: t('ui.disk.trees_cap'),
    rows: trees.map((tree) => {
      const st = tree.absent ? 'absent' : tree.removable ? 'removable' : 'busy';
      const state = { absent: cell(null, t('ui.tree.absent_sub'), { tone: 'unk', toneLabel: t('ui.tree.absent') }), removable: cell(null, t('ui.tree.removable_sub'), { tone: 'todo', toneLabel: t('ui.tree.removable') }), busy: cell(null, null, { tone: 'idle', toneLabel: t('ui.tree.busy') }) }[st];
      return {
        id: tree.path, st, search: `${tree.path} ${tree.branch ?? ''}`,
        cells: [state, cell(tree.path, tree.branch ?? null, { mono: true }), cell(tree.absent ? '—' : t('ui.period.days', { n: tree.ageDays ?? 0 })), cell(tree.absent ? '—' : String(tree.modified ?? 0)), cell(tree.absent ? '—' : String(tree.unpushed ?? 0))],
        actions: tree.absent || older || samePath(tree.path, d.status.factory_tree) ? [] : [{ label: t('ui.clean.tree_list'), title: t('ui.clean.tree_only'), run: () => cleanTree(ctx, d, tree.path) }],
        detail: () => h('div', { class: 'detail' }, kv([cleanup(tree), [t('ui.tree.removal'), t('ui.tree.removal_text')]])),
      };
    }),
  });
}

function diskView(ctx, d) {
  const out = [];
  if (d.absent?.disk) return [box(h('div', { class: 'boxr' }, badge('unk', t('ui.absent_title')), absent(d.kit.version)))];
  const disk = ctx.disk;
  if (!disk?.data) {
    out.push(disk?.error ? box(h('div', { class: 'boxr' }, badge('unk', t('ui.error.title')), h('span', { class: 'grow' }, disk.error))) : skeleton());
    out.push(caption(null, t('ui.disk.walking')));
    return out;
  }
  out.push(caption(null, t('ui.disk.measured', { at: fmtClock(disk.at) })));
  out.push(box(diskRows(disk.data)));
  out.push(treesList(ctx, d, disk.data));
  return out;
}

function memoryView(ctx, d) {
  if (d.absent?.disk) return [box(h('div', { class: 'boxr' }, badge('unk', t('ui.absent_title')), absent(d.kit.version)))];
  const min = factoryOf(d).min_free_memory_gib;
  const disk = ctx.disk;
  if (!disk?.data) return [disk?.error ? caption(null, disk.error) : skeleton()];
  const memory = disk.data.memory;
  const scale = Math.max(memory ?? 0, min * GIB * 3);
  const under = memory !== null && memory !== undefined && memory < min * GIB;
  return [
    caption(null, t('ui.disk.measured', { at: fmtClock(disk.at) })),
    box(
      memory === null || memory === undefined
        ? measure(t('ui.memory.free'), t('ui.memory.unknown'))
        : measure(t('ui.memory.free'), fmtGib(memory), { ratio: memory / scale, tick: (min * GIB) / scale, over: under, cap: t('ui.memory.threshold', { n: fmtNum(min, 1) }), tone: under ? 'halt' : null, toneLabel: t('ui.memory.below') }),
      measure(t('ui.memory.below'), t('ui.memory.below_text')),
      measure(t('ui.memory.setting'), `train.min_free_memory_gib = ${fmtNum(min, 1)}`, { mono: true, cap: d.config?.factory?.train?.min_free_memory_gib === undefined ? t('ui.memory.default') : 'config/factory.json' })),
  ];
}

// The plugin of this clone, as its session hook left it (from the plugin 0.4.4): its version, since when, and whether
// the kit lags behind it.
function pluginRow(d) {
  const plugin = d.plugin?.version ? d.plugin : null;
  if (!plugin) return measure(t('ui.kit.plugin'), t('ui.kit.plugin_none'));
  const behind = compareVersions(d.kit.version, plugin.version) < 0;
  const since = plugin.since ? t('ui.kit.plugin_since', { at: fmtDate(plugin.since) }) : '';
  return measure(t('ui.kit.plugin'), plugin.version, {
    mono: true, tone: behind ? 'todo' : null, toneLabel: t('ui.kit.behind'),
    cap: [since, behind ? t('ui.kit.plugin_behind', { kit: d.kit.version, plugin: plugin.version }) : ''].filter(Boolean).join(' · '),
  });
}

function kitView(ctx, d) {
  const s = d.status;
  const newest = ctx.data?.newest_kit ?? null;
  const fromPlugin = ctx.data?.newest_from === 'plugin';
  const behind = Boolean(newest) && compareVersions(d.kit.version, newest) < 0;
  const integrity = d.kit_integrity ?? { files: 0, changed: [], extra: [], missing: [] };
  const gaps = [...(integrity.changed ?? []).map((f) => ['changed', f]), ...(integrity.extra ?? []).map((f) => ['extra', f]), ...(integrity.missing ?? []).map((f) => ['missing', f])];
  const gapLabel = (kind) => ({ changed: t('ui.kit.changed'), extra: t('ui.kit.extra'), missing: t('ui.kit.missing') })[kind];
  const hooks = s.hooks_active
    ? measure(t('ui.kit.hooks'), 'core.hooksPath = .githooks', { mono: true, tone: 'ok', toneLabel: t('ui.hooks.active') })
    : h('div', { class: 'mrow' }, h('span', { class: 'k' }, t('ui.kit.hooks')), h('span', { class: 'mv' }, badge('todo', t('ui.hooks.inactive')), h('span', null, t('ui.hooks.off'))), h('span', { class: 'mcap' }, btn(t('ui.gesture.hooks_on'), () => ctx.hooksOn(d), { kind: 'p', small: true })));
  return [
    box(
      measure(t('ui.col.kit'), `${d.kit.name} ${d.kit.version}`, { mono: true }),
      measure(t('ui.kit.newest'), newest ?? '—', {
        mono: true, tone: behind ? 'todo' : null, toneLabel: t('ui.kit.behind'),
        cap: [fromPlugin ? t('ui.kit.newest_cap_plugin') : t('ui.kit.newest_cap'), behind ? t('ui.kit.behind_text') : ''].filter(Boolean).join(' · '),
      }),
      pluginRow(d),
      measure(t('ui.kit.integrity'), gaps.length ? t('ui.kit.integrity_gaps', { n: gaps.length, files: integrity.files }) : t('ui.kit.integrity_ok', { files: integrity.files }), { tone: gaps.length ? 'todo' : 'ok', toneLabel: gaps.length ? t('ui.kit.integrity_bad') : t('ui.kit.integrity_good') }),
      hooks,
      measure(t('ui.kit.rules'), s.rules_source ?? t('ui.kit.no_rules'), { mono: Boolean(s.rules_source) }),
      measure(t('ui.kit.role'), roleText(s.role), { cap: s.tree ?? '' }),
      measure(t('ui.kit.factory_tree'), s.factory_tree ?? t('ui.factory.none'), { mono: Boolean(s.factory_tree) }),
      measure(t('ui.kit.fixes'), (s.factory_fixes ?? []).join(', ') || '—', { mono: true }),
      measure(t('ui.kit.branch'), `${s.branch ?? '—'} · ${s.clean ? t('ui.kit.clean') : t('ui.kit.not_clean')}`, { cap: t('ui.kit.main_branch', { branch: s.main_branch ?? 'main', remote: s.remote ?? 'origin' }) }),
      measure(t('ui.kit.tasks'), s.task_tool ? t('ui.kit.set') : t('ui.cfg.unset')),
      measure(t('ui.kit.cache'), Array.isArray(s.shared_build_cache) ? (s.shared_build_cache.join(', ') || t('ui.none')) : t('ui.kit.no_rust'))),
    list(`integrity:${d.path}`, {
      title: t('ui.kit.integrity_title'), cols: [t('ui.col.gap'), t('ui.col.file')], grid: '170px minmax(0,1fr)', minWidth: 520, search: false,
      strip: [{ id: 'changed', label: t('ui.kit.changed'), tone: 'todo' }, { id: 'extra', label: t('ui.kit.extra'), tone: 'todo' }, { id: 'missing', label: t('ui.kit.missing'), tone: 'todo' }],
      stripLabel: t('ui.col.gap'), empty: t('ui.kit.integrity_ok', { files: integrity.files }),
      rows: gaps.map(([kind, file]) => ({ id: `${kind}:${file}`, st: kind, cells: [cell(null, null, { tone: 'todo', toneLabel: gapLabel(kind) }), cell(file, null, { mono: true })] })),
    }),
  ];
}

export function renderHealth(ctx, d) {
  const sub = ctx.state.sub.health ?? 0;
  const factoryTree = d.status.factory_tree;
  const clean = sub === 0 && !d.absent?.disk ? btn(t('ui.gesture.clean_own'), () => cleanOwn(ctx, d, false), { disabled: !factoryTree, title: factoryTree ? t('ui.clean.own_only') : t('ui.gesture.needs_factory'), fk: 'health:clean' }) : null;
  const out = [subbar({
    items: [{ label: t('ui.nature.disk') }, { label: t('ui.health.memory') }, { label: t('ui.nature.kit') }],
    current: sub, onPick: (i) => ctx.setSub('health', i),
    source: sub === 2 ? 'scripts/warden/kit.json · status.mjs --json' : 'disk.mjs report --json',
    actions: [clean],
  })];
  if (sub === 0) out.push(...diskView(ctx, d));
  else if (sub === 1) out.push(...memoryView(ctx, d));
  else out.push(...kitView(ctx, d));
  if (sub === 0 && !factoryTree) out.push(caption(null, t('ui.gesture.needs_factory')));
  return out;
}
