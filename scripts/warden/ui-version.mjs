// A project's version (F10) and releases (F11). The page reads the version and builds a release from the latest
// commit the train took, in the factory tree; it never bumps a version and never publishes. "Published" is the
// person's word, kept on this workstation.

import { t } from './ui-api.mjs';
import { absent, badge, box, boxRow, btn, caption, fmtBytes, fmtDate, h, kv, link, short } from './ui-dom.mjs';
import { cell, list } from './ui-list.mjs';
import { subbar } from './ui-views.mjs';

const stat = (label, value) => h('div', { class: 'stat' }, h('span', null, label), h('b', null, value ?? '—'));

function versionView(ctx, d) {
  if (d.absent?.version) return [box(boxRow(badge('unk', t('ui.absent_title')), absent(d.kit.version)))];
  const out = [];
  if (d.version_error) {
    out.push(box(boxRow(badge('halt', t('ui.version.refused')), h('span', { class: 'grow' }, t('ui.version.refused_text'))), h('div', { class: 'boxr' }, h('pre', { class: 'pre grow' }, d.version_error))));
  }
  const v = d.version;
  if (!v) {
    if (!d.version_error) out.push(caption(null, t('ui.version.none')));
    return out;
  }
  out.push(box(boxRow(h('div', { class: 'stats' },
    stat(t('ui.version.current'), v.current), stat(t('ui.version.line'), v.line), stat(t('ui.version.next'), v.next)),
    h('span', { class: 'grow' }),
    link(t('ui.version.change_line'), () => ctx.go('project', d.path, 'config', 0)))));
  out.push(caption(null, t('ui.version.line_note')));
  out.push(list(`vfiles:${d.path}`, {
    title: t('ui.version.files'), cols: [t('ui.col.file'), t('ui.col.read')], grid: 'minmax(0,1.4fr) minmax(0,1fr)', minWidth: 480, search: false,
    empty: t('ui.version.files_empty'),
    rows: (v.files ?? []).map((f) => ({ id: f.file, cells: [cell(f.file, null, { mono: true }), cell(f.read, null, { mono: true })] })),
  }));
  return out;
}

function buildRelease(ctx, d, commit) {
  ctx.gesture({
    project: d, gesture: 'release.build', args: { commit }, title: t('ui.release.build'),
    command: `node scripts/warden/release.mjs build --commit ${commit}`, cwd: d.status.factory_tree,
  });
}

function releasesView(ctx, d) {
  if (d.absent?.releases) return [box(boxRow(badge('unk', t('ui.absent_title')), absent(d.kit.version)))];
  const out = [];
  const published = d.state?.published ?? {};
  const configured = Boolean(d.config?.factory?.release);
  const factoryTree = d.status.factory_tree;
  const holder = d.status.slot?.holder;
  if (!factoryTree) out.push(box(boxRow(badge('unk', t('ui.factory.none_short')), h('span', { class: 'grow' }, t('ui.gesture.needs_factory')))));
  else if (!configured) out.push(box(boxRow(badge('unk', t('ui.release.not_configured')), h('span', { class: 'grow' }, t('ui.release.not_configured_text')))));
  else if (holder) out.push(box(boxRow(badge('run', t('ui.slot.held')), h('span', { class: 'grow' }, t('ui.release.slot_held', { tree: holder.tree ?? '?' })))));
  out.push(caption(null, t('ui.release.cap')));
  out.push(list(`releases:${d.path}`, {
    cols: [t('ui.col.publication'), t('ui.col.release'), t('ui.col.artifacts'), t('ui.col.signature'), t('ui.col.built_at')], right: 4,
    grid: '160px minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr) 110px', minWidth: 880, actionsWidth: '170px',
    strip: [{ id: 'no', label: t('ui.release.unpublished'), tone: 'todo' }, { id: 'yes', label: t('ui.release.published'), tone: 'done' }], stripLabel: t('ui.col.publication'),
    search: t('ui.release.search'), empty: t('ui.release.empty'),
    rows: (d.releases ?? []).map((r) => {
      const when = published[r.label];
      const artifacts = r.artifacts ?? [];
      const folder = `releases/${r.folder ?? r.label}`;
      return {
        id: r.label ?? r.folder, st: when ? 'yes' : 'no', search: `${r.label} ${r.commit} ${artifacts.map((a) => a.name).join(' ')}`,
        cells: [
          when ? cell(null, t('ui.release.published_on', { at: fmtDate(when) }), { tone: 'done', toneLabel: t('ui.release.published') }) : cell(null, t('ui.release.yours'), { tone: 'todo', toneLabel: t('ui.release.unpublished') }),
          cell(r.label ?? r.folder, t('ui.release.commit', { commit: short(r.commit) }), { strong: true }),
          cell(t('ui.release.artifacts', { n: artifacts.length }), artifacts.map((a) => `${a.name} ${fmtBytes(a.bytes)}`).join(' · ')),
          cell(r.signed ? t('ui.release.signed') : t('ui.release.unsigned'), r.signature_checked ? t('ui.release.checked') : t('ui.release.unchecked')),
          cell(fmtDate(r.at), null, { right: true }),
        ],
        actions: [when
          ? { label: t('ui.release.mark_unpublished'), run: () => ctx.mark(d, { label: r.label, published: false }, t('ui.toast.unpublished')) }
          : { label: t('ui.release.mark_published'), primary: true, run: () => ctx.mark(d, { label: r.label, published: true }, t('ui.toast.published')) }],
        detail: () => h('div', { class: 'detail' },
          kv([
            ...artifacts.map((a) => [a.name, h('span', { class: 'col' }, h('span', null, `${fmtBytes(a.bytes)} · ${a.path ?? ''}`), h('span', { class: 'mono wrap' }, `SHA-256 ${a.sha256 ?? '—'}`))]),
            [t('ui.dock.commit'), r.commit ?? '—', { mono: true }],
            [t('ui.release.folder'), `${folder}/`, { mono: true }],
          ]),
          h('div', { class: 'dacts' }, ['release.json', 'SHA256SUMS', 'build.log'].map((name) => btn(t('ui.open.named', { name }), () => ctx.file(d, `${folder}/${name}`), { small: true })))),
      };
    }),
  }));
  return out;
}

export function renderVersion(ctx, d) {
  const sub = ctx.state.sub.version ?? 0;
  const factoryTree = d.status.factory_tree;
  const head = (d.taken ?? []).find((x) => x.taken?.main)?.taken.main ?? null;
  const configured = Boolean(d.config?.factory?.release);
  const held = Boolean(d.status.slot?.holder);
  const actions = sub === 0
    ? [d.absent?.version ? null : btn(t('ui.gesture.version_show'), () => ctx.gesture({ project: d, gesture: 'version.show', args: {}, title: t('ui.gesture.version_show'), command: 'node scripts/warden/version.mjs show', cwd: d.path }), { kind: 'g', fk: 'version:show' })]
    : [d.absent?.releases ? null : btn(head ? t('ui.release.build_from', { commit: short(head) }) : t('ui.release.build'), () => buildRelease(ctx, d, head), {
      disabled: !factoryTree || !head || !configured || held,
      title: !factoryTree ? t('ui.gesture.needs_factory') : !head ? t('ui.release.no_commit') : t('ui.release.build_hint'), fk: 'version:build',
    })];
  const out = [subbar({
    items: [{ label: t('ui.tab.version') }, { label: t('ui.nature.release'), n: (d.releases ?? []).length }],
    current: sub, onPick: (i) => ctx.setSub('version', i),
    source: sub === 0 ? 'version.mjs show --json' : 'releases/<label>/release.json', actions,
  })];
  return out.concat(sub === 0 ? versionView(ctx, d) : releasesView(ctx, d));
}
