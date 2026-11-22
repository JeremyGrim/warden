// "À vous" (F12): what waits for the person, on every project of the workstation, and only the cases the server gives.
// A case seen stays listed while its cause holds; it goes back to "to do" in one gesture. A decision of the factory is
// answered from here, and a removable tree cleaned (listed first), each by its own gesture.

import { t } from './ui-api.mjs';
import { absent, fmtDate, h } from './ui-dom.mjs';
import { answerDecision, decisionOf, optionsNode, questionNode } from './ui-decisions.mjs';
import { cleanTree } from './ui-health.mjs';
import { cell, list } from './ui-list.mjs';
import { caseWords, NATURES, natureOf, projectOf } from './ui-model.mjs';
import { header, tabs } from './ui-views.mjs';

export function renderInbox(ctx) {
  const data = ctx.data;
  const all = data?.cases ?? [];
  const todo = all.filter((c) => c.state !== 'done');
  const seen = all.filter((c) => c.state === 'done');
  const door = ctx.state.sub.inbox ?? 0;
  const shown = door === 0 ? todo : door === 1 ? seen : all;
  const projectsWith = new Set(todo.map((c) => c.project.toLowerCase())).size;
  const out = [];

  out.push(header(t('ui.rail.yours'), [todo.length ? t('ui.inbox.meta', { n: todo.length, projects: projectsWith }) : t('ui.inbox.meta_none')]));
  out.push(tabs([
    { label: t('ui.inbox.todo'), n: todo.length },
    { label: t('ui.inbox.seen'), n: seen.length },
    { label: t('ui.list.all'), n: all.length },
  ], door, (i) => ctx.setSub('inbox', i)));

  const rows = shown.map((c) => {
    const p = projectOf(data, c.project);
    const name = p?.name ?? c.project;
    const words = caseWords(c);
    const done = c.state === 'done';
    const open = () => ctx.go('project', c.project, words.to[0], words.to[1]);
    const actions = [{ label: words.open, run: open }];
    const cleanable = c.kind === 'tree_removable' && p?.ok && !p.absent?.clean_tree;
    const answerable = c.kind === 'decision' && p?.ok && !p.absent?.decisions;
    if (!done) {
      if (answerable) actions.push({ label: t('ui.decision.answer'), primary: true, run: () => answerDecision(ctx, p, decisionOf(p, c)) });
      if (answerable && c.vars?.context) actions.push({ label: t('ui.decision.context'), run: () => ctx.file(p, c.vars.context) });
      if (cleanable) actions.push({ label: t('ui.clean.tree_list'), primary: true, run: () => cleanTree(ctx, p, c.vars.path) });
      if (c.kind === 'hooks_off' && p) actions.push({ label: t('ui.gesture.hooks_on'), primary: true, run: () => ctx.hooksOn(p) });
      if (c.kind === 'release' && p) actions.push({ label: t('ui.release.mark_published'), primary: true, run: () => ctx.mark(p, { label: c.vars?.label, published: true }, t('ui.toast.published')) });
      actions.push({ label: t('ui.case.mark_seen'), primary: actions.length === 1, run: () => ctx.mark(p ?? { path: c.project }, { id: c.id, state: 'done' }, t('ui.toast.seen')) });
    } else {
      actions.push({ label: t('ui.case.mark_todo'), run: () => ctx.mark(p ?? { path: c.project }, { id: c.id, state: 'todo' }, t('ui.toast.todo')) });
    }
    // A tree the project's kit cannot clean alone: said, with no button.
    const older = c.kind === 'tree_removable' && p?.absent?.clean_tree ? h('span', { class: 'cs' }, t('ui.tree.cleanup_older'), ' ', absent(p.kit?.version)) : null;
    return {
      id: `${c.project}|${c.id}`,
      st: natureOf(c.kind),
      fac: name,
      search: [words.title, words.detail, ...(words.options ?? []), name, c.source, c.kind].join(' '),
      cells: [
        done ? cell(null, t('ui.case.seen_sub'), { tone: 'done', toneLabel: t('ui.case.seen') }) : cell(null, t('ui.case.todo_sub'), { tone: 'todo', toneLabel: t('ui.inbox.todo') }),
        c.kind === 'decision'
          ? cell(words.title, null, { strong: true, extra: [questionNode(words.detail), optionsNode(words.options), h('span', { class: 'cs why' }, words.why)] })
          : cell(words.title, words.detail, { extra: [h('span', { class: 'cs why' }, words.why), older] }),
        cell(name, c.source, { strong: true, extra: h('span', { class: 'cs mono' }, c.kind) }),
        cell(c.since ? fmtDate(c.since) : '—', c.since ? null : t('ui.case.since_none'), { right: true }),
      ],
      actions,
    };
  });

  out.push(list(`inbox:${door}`, {
    cols: [t('ui.col.state'), t('ui.col.case'), t('ui.col.project_source'), t('ui.col.since')], right: 3,
    grid: '120px minmax(0,1.5fr) minmax(0,1fr) 96px', minWidth: 880, actionsWidth: '250px',
    strip: NATURES(), stripLabel: t('ui.inbox.nature'), facets: true, rows,
    search: t('ui.inbox.search'),
    empty: door === 0 ? t('ui.inbox.empty_todo') : t('ui.inbox.empty'),
  }));
  out.push(h('p', { class: 'foot' }, t('ui.inbox.foot')));
  return out;
}
