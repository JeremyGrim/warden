// "Projets" (F0): every project of the workstation, read by its own kit, and the list itself (git config --global
// warden.projects). Then the page of one project, with its tabs. Removing a project from the list never touches it.

import { t } from './ui-api.mjs';
import { absent, badge, box, boxRow, btn, caption, fmtAge, fmtDate, h, icon, kv, mono, skeleton } from './ui-dom.mjs';
import { renderConfig } from './ui-config.mjs';
import { renderHealth } from './ui-health.mjs';
import { renderHistory } from './ui-history.mjs';
import { cell, list } from './ui-list.mjs';
import { dockCounts, outcomeOf, reasonLong, STATE_STRIP, todoCount, trainState } from './ui-model.mjs';
import { renderTrain } from './ui-train.mjs';
import { renderVersion } from './ui-version.mjs';
import { header, tabs } from './ui-views.mjs';

export const TABS = ['train', 'history', 'health', 'version', 'config'];
const tabLabel = (id) => ({ train: t('ui.col.train'), history: t('ui.tab.history'), health: t('ui.tab.health'), version: t('ui.tab.version'), config: t('ui.tab.config') })[id];
export { tabLabel };

// Removing asks twice: the first click arms, the second removes. The project itself is never touched.
function removeAction(ctx, p) {
  if (!p.listed) return null;
  const armed = ctx.ui.armed === p.path;
  return {
    label: armed ? t('ui.projects.remove_confirm') : t('ui.projects.remove'),
    title: t('ui.projects.remove_note'),
    primary: armed,
    run: () => (armed ? ctx.removeProject(p) : ctx.arm(p.path)),
  };
}

function addBox(ctx) {
  const preview = h('span', null, ctx.ui.addPath || t('ui.projects.add_placeholder_cmd'));
  const submit = () => {
    const path = ctx.ui.addPath.trim();
    if (path) ctx.addProject(path);
  };
  return box(
    boxRow(
      h('label', { class: 'q wide' }, icon('folder', 16), h('input', {
        type: 'text', placeholder: t('ui.projects.add_placeholder'), 'aria-label': t('ui.projects.add_placeholder'), value: ctx.ui.addPath, autocomplete: 'off', spellcheck: 'false', 'data-fk': 'add:path',
        on: {
          input: (e) => {
            ctx.ui.addPath = e.target.value;
            preview.textContent = e.target.value || t('ui.projects.add_placeholder_cmd');
          },
          // The drawer takes the focus as it opens: without preventDefault, this same Enter clicked its close button
          // and the answer of the server was never seen (21 November, first trial of the page).
          keydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          },
        },
      })),
      btn(t('ui.projects.add_submit'), submit, { kind: 'p' }),
      btn(t('ui.cancel'), () => ctx.toggleAdd(false), { kind: 'g' })),
    h('div', { class: 'boxr mono quiet' }, 'git config --global --add warden.projects ', preview),
    h('div', { class: 'boxr quiet' }, t('ui.projects.add_note')));
}

export function renderProjects(ctx) {
  const data = ctx.data;
  const projects = data?.projects ?? [];
  const out = [header(t('ui.rail.projects'), [t('ui.projects.meta', { n: projects.length }), { text: 'git config --global warden.projects', mono: true }],
    [btn(t('ui.projects.add'), () => ctx.toggleAdd(!ctx.ui.addOpen), { fk: 'add:open' })])];
  if (ctx.ui.addOpen) out.push(addBox(ctx));
  const rows = projects.map((p) => {
    const state = trainState(p);
    const n = todoCount(data, p.path);
    const flags = [p.here ? t('ui.projects.here') : null, p.listed ? null : t('ui.projects.not_listed')].filter(Boolean).join(' · ');
    const remove = removeAction(ctx, p);
    if (!p.ok) {
      return {
        id: p.path, st: 'bad', search: `${p.name} ${p.path}`, go: () => ctx.go('project', p.path),
        cells: [cell(null, state.sub, { tone: state.tone, toneLabel: state.label }), cell(p.name, p.path, { strong: true, extra: flags ? h('span', { class: 'cs' }, flags) : null }), cell('—'), cell(p.kit ? t('ui.kit.version', { v: p.kit.version }) : '—'), cell('—'), cell('—', null, { right: true })],
        actions: remove ? [remove] : [],
      };
    }
    const counts = dockCounts(p);
    const holder = p.status.slot?.holder;
    const last = p.last_train;
    const outcome = last ? outcomeOf(last) : null;
    return {
      id: p.path, st: state.kind, search: `${p.name} ${p.path}`, go: () => ctx.go('project', p.path),
      cells: [
        cell(null, state.sub, { tone: state.tone, toneLabel: state.label }),
        cell(p.name, p.path, { strong: true, extra: flags ? h('span', { class: 'cs' }, flags) : null }),
        cell(t('ui.dock.counts', counts), holder ? t('ui.slot.held_short', { tree: holder.tree, since: fmtAge(holder.since) }) : t('ui.slot.free_short')),
        cell(t('ui.kit.version', { v: p.kit.version }), [p.status.hooks_active ? t('ui.hooks.on') : t('ui.hooks.off'), p.status.factory_tree ? t('ui.factory.declared') : t('ui.factory.none')].join(' · ')),
        p.absent?.history ? cell(null, null, { extra: absent(p.kit.version) }) : last ? cell(fmtDate(last.at), null, { extra: badge(outcome.tone, outcome.label) }) : cell(t('ui.train.no_train'), null, { quiet: true }),
        cell(n ? String(n) : '—', null, { right: true }),
      ],
      actions: remove ? [remove] : [],
    };
  });
  out.push(list('projects', {
    cols: [t('ui.col.train'), t('ui.col.project'), t('ui.dock.title'), t('ui.col.kit'), t('ui.col.last_train'), t('ui.rail.yours')], right: 5,
    grid: '150px minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr) 48px', minWidth: 900, actionsWidth: '150px',
    strip: STATE_STRIP(), stripLabel: t('ui.col.train'), rows, search: t('ui.projects.search'), empty: t('ui.projects.empty'),
  }));
  out.push(caption(null, t('ui.projects.remove_note')));
  return out;
}

const RENDER = { train: renderTrain, history: renderHistory, health: renderHealth, version: renderVersion, config: renderConfig };

export function renderProject(ctx) {
  const p = ctx.project;
  if (!p) return [header(t('ui.project.gone')), h('p', { class: 'empty' }, t('ui.project.gone_text'))];
  const remove = removeAction(ctx, p);
  const actions = remove ? [btn(remove.label, remove.run, { kind: remove.primary ? 'p' : 'g', title: remove.title, fk: 'project:remove' })] : [];
  const meta = [{ text: p.path, mono: true }];
  if (p.ok) {
    meta.push(t('ui.kit.version', { v: p.kit.version }), p.status.hooks_active ? t('ui.hooks.on') : t('ui.hooks.off'), p.status.factory_tree ? t('ui.factory.declared') : t('ui.factory.none'));
  }
  if (p.here) meta.push(t('ui.projects.here'));
  if (!p.listed) meta.push(t('ui.projects.not_listed'));
  const out = [header(p.name, meta, actions)];
  if (ctx.ui.armed === p.path) out.push(caption(null, t('ui.projects.remove_note')));
  if (!p.ok) {
    out.push(box(boxRow(badge('unk', t('ui.train.unreadable'), true), h('span', { class: 'grow' }, reasonLong(p.reason)))));
    if (p.kit) out.push(kv([[t('ui.col.kit'), mono(`${p.kit.name} ${p.kit.version}`)]]));
    return out;
  }
  const current = Math.max(0, TABS.indexOf(ctx.state.tab));
  out.push(tabs(TABS.map((id) => ({ label: tabLabel(id) })), current, (i) => ctx.go('project', p.path, TABS[i]), p.name));
  const detail = ctx.detail;
  if (!detail) {
    out.push(ctx.detailError ? box(boxRow(badge('unk', t('ui.error.title')), h('span', { class: 'grow' }, ctx.detailError))) : skeleton());
    return out;
  }
  if (!detail.ok) {
    out.push(box(boxRow(badge('unk', t('ui.train.unreadable'), true), h('span', { class: 'grow' }, reasonLong(detail.reason)))));
    return out;
  }
  return out.concat(RENDER[TABS[current]](ctx, detail));
}
