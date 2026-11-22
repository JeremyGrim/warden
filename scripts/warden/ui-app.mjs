// The Warden interface in the browser: the rail, the pages, the rereads. It shows; it never decides. The only
// gestures are those ui.mjs runs (a dry run, the cleanup of one tree, reading the version, a release, turning the
// hooks on, the workstation settings, answering a decision of the factory, depositing a configuration change, the
// person's marks, the list of projects). Nothing is pushed: the page reads the files again, every 10 s the view shown
// and every 15 s the projects, and right after a gesture.

import { errorText, get, loadStrings, post, readToken, t } from './ui-api.mjs';
import { badge, brandMark, fmtClock, h, icon, keepFocus, samePath } from './ui-dom.mjs';
import { openFile, openForm, runGesture, runStation, setupDrawer } from './ui-drawer.mjs';
import { renderInbox } from './ui-inbox.mjs';
import { projectOf, todoCount, trainState } from './ui-model.mjs';
import { renderProject, renderProjects, tabLabel, TABS } from './ui-projects.mjs';

const PROJECTS_EVERY = 15000;
const VIEW_EVERY = 10000;
const DISK_EVERY = 60000;
const THEME_KEY = 'warden-ui-theme';
const SUB_KEY = { train: 'dock', history: 'history', health: 'health', version: 'version', config: 'config' };
const $ = (id) => document.getElementById(id);

const state = { view: 'inbox', path: null, tab: 'train', sub: {}, days: 7 };
const ui = { addOpen: false, addPath: '', armed: null, edits: {}, cfq: '', railOpen: false };
const store = {
  projects: null, projectsJson: '', projectsAt: 0, projectsError: null, projectsRun: null,
  detail: null, detailKey: '', detailJson: '', detailAt: 0, detailError: null, detailRun: null,
  disks: new Map(), rules: new Map(), readAt: null, refused: false,
};

// The theme: the system's, or the one the person chose, remembered in this browser.
function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // The choice holds for this page only.
  }
  renderRail();
}
applyTheme(storedTheme());

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

const detailKeyNow = () => `${state.path}|${state.days}`;
const onHealth = () => state.view === 'project' && state.tab === 'health';
const onRules = () => onHealth() && (state.sub.health ?? 0) === 3;
const reading = () => Boolean(store.projectsRun || store.detailRun || [...store.disks.values(), ...store.rules.values()].some((d) => d.run));

// One read at a time per kind; `fresh` waits for the read under way, then reads again (after a gesture).
async function loadProjects({ fresh = false } = {}) {
  if (store.projectsRun) {
    if (!fresh) return store.projectsRun;
    await store.projectsRun;
  }
  store.projectsRun = (async () => {
    let changed = false;
    try {
      const answer = await get('/api/projects');
      const json = JSON.stringify({ ...answer, read_at: null });
      store.projectsError = null;
      store.readAt = new Date();
      if (json !== store.projectsJson) {
        store.projects = answer;
        store.projectsJson = json;
        changed = true;
      }
    } catch (error) {
      changed = store.projectsError !== errorText(error);
      store.projectsError = errorText(error);
      if (error.status === 403) store.refused = true;
    } finally {
      store.projectsAt = Date.now();
    }
    return changed;
  })();
  renderRail();
  const changed = await store.projectsRun;
  store.projectsRun = null;
  renderRail();
  if (changed) renderMain();
  return changed;
}

async function loadDetail({ fresh = false } = {}) {
  if (state.view !== 'project' || !state.path) return false;
  const p = projectOf(store.projects, state.path);
  if (p && !p.ok) return false;
  if (store.detailRun) {
    if (!fresh) return store.detailRun;
    await store.detailRun;
  }
  const key = detailKeyNow();
  store.detailRun = (async () => {
    try {
      const answer = await get('/api/project', { path: state.path, days: state.days });
      if (key !== detailKeyNow()) return false;
      const json = JSON.stringify(answer);
      store.detailError = null;
      store.readAt = new Date();
      if (json === store.detailJson && store.detailKey === key) return false;
      Object.assign(store, { detail: answer, detailJson: json, detailKey: key });
      return true;
    } catch (error) {
      if (key !== detailKeyNow()) return false;
      store.detailError = errorText(error);
      if (error.status === 403) store.refused = true;
      return true;
    } finally {
      store.detailAt = Date.now();
    }
  })();
  renderRail();
  const changed = await store.detailRun;
  store.detailRun = null;
  renderRail();
  if (changed) renderMain();
  if (key !== detailKeyNow()) return loadDetail();
  return changed;
}

async function loadDisk(path, { fresh = false } = {}) {
  const p = projectOf(store.projects, path);
  if (!path || (p && (!p.ok || p.absent?.disk))) return;
  const entry = store.disks.get(path) ?? {};
  if (entry.run) {
    if (!fresh) return;
    await entry.run;
  }
  const run = get('/api/disk', { path, full: 1 })
    .then((data) => (data ? { at: new Date(), data, error: null } : { ...entry, error: t('ui.disk.unreadable') }))
    .catch((error) => ({ ...entry, error: errorText(error) }));
  store.disks.set(path, { ...entry, run });
  renderRail();
  const result = await run;
  store.disks.set(path, { ...result, run: null, checked: Date.now() });
  renderRail();
  if (onHealth() && samePath(state.path, path)) renderMain();
}

// The rules over the whole working tree, read on the health tab's Rules view only: rules.mjs reads every file.
async function loadRules(path, { fresh = false } = {}) {
  const p = projectOf(store.projects, path);
  if (!path || (p && (!p.ok || p.absent?.rules))) return;
  const entry = store.rules.get(path) ?? {};
  if (entry.run) {
    if (!fresh) return;
    await entry.run;
  }
  const run = get('/api/rules', { path })
    .then((data) => (data ? { at: new Date(), data, error: null } : { ...entry, error: t('ui.rules.unreadable') }))
    .catch((error) => ({ ...entry, error: errorText(error) }));
  store.rules.set(path, { ...entry, run });
  renderRail();
  const result = await run;
  store.rules.set(path, { ...result, run: null, checked: Date.now() });
  renderRail();
  if (onRules() && samePath(state.path, path)) renderMain();
}

async function rereadAll() {
  await Promise.all([loadProjects({ fresh: true }), loadDetail({ fresh: true }), onHealth() ? loadDisk(state.path, { fresh: true }) : null, onRules() ? loadRules(state.path, { fresh: true }) : null]);
}

// A refused token never becomes valid again (the server was started anew): the page stops reading and says so,
// instead of asking every second (seen on 21 November after a restart of the server).
function tick() {
  if (document.hidden || !readToken() || store.refused) return;
  const now = Date.now();
  if (now - store.projectsAt >= PROJECTS_EVERY) loadProjects();
  if (state.view === 'project' && now - store.detailAt >= VIEW_EVERY) loadDetail();
  const disk = store.disks.get(state.path);
  if (onHealth() && !disk?.run && now - (disk?.checked ?? 0) >= DISK_EVERY) loadDisk(state.path);
  const rules = store.rules.get(state.path);
  if (onRules() && !rules?.run && now - (rules?.checked ?? 0) >= DISK_EVERY) loadRules(state.path);
}

// Moving through the page.
function go(view, path = null, tab = null, subIndex = null) {
  const before = `${state.view}|${state.path}|${state.tab}`;
  state.view = view;
  if (view === 'project') {
    if (!samePath(path, state.path)) {
      state.path = path;
      store.detailError = null;
      if (!store.detailKey.startsWith(`${path}|`)) Object.assign(store, { detail: null, detailJson: '', detailKey: '' });
    }
    state.tab = tab ?? (TABS.includes(state.tab) ? state.tab : 'train');
    if (subIndex !== null && subIndex !== undefined) state.sub[SUB_KEY[state.tab]] = subIndex;
  }
  ui.armed = null;
  ui.railOpen = false;
  renderRail();
  renderMain();
  if (before !== `${state.view}|${state.path}|${state.tab}`) $('page').scrollTop = 0;
  if (view === 'project') {
    loadDetail();
    if (onHealth() && !store.disks.get(state.path)?.data) loadDisk(state.path);
    if (onRules() && !store.rules.get(state.path)?.data) loadRules(state.path);
  }
}

async function mark(project, body, done) {
  try {
    await post('/api/mark', { path: project.path }, body);
    toast(done);
  } catch (error) {
    toast(errorText(error));
  }
  await rereadAll();
}

let armTimer = null;
const ctxActions = {
  go,
  setSub: (name, i) => {
    state.sub[name] = i;
    renderMain();
    if (onHealth() && !store.disks.get(state.path)?.data) loadDisk(state.path);
    if (onRules() && !store.rules.get(state.path)?.data) loadRules(state.path);
  },
  setDays: (n) => {
    state.days = n;
    renderMain();
    loadDetail();
  },
  render: () => renderMain(),
  latest: () => store.detail,
  toast,
  gesture: (spec) => runGesture(spec),
  file: (project, file, title = null, back = null) => openFile({ project, file, title, back }),
  form: (spec) => openForm(spec),
  mark,
  hooksOn: (project) => runGesture({ project, gesture: 'hooks.on', args: {}, title: t('ui.gesture.hooks_on'), command: 'git config core.hooksPath .githooks', cwd: project.path }),
  toggleAdd: (open) => {
    ui.addOpen = open;
    renderMain();
    if (open) document.querySelector('[data-fk="add:path"]')?.focus();
  },
  addProject: (path) => {
    ui.addOpen = false;
    ui.addPath = '';
    renderMain();
    runStation({ title: t('ui.projects.add_title'), action: 'add', target: path, command: `git config --global --add warden.projects ${path}` });
  },
  removeProject: (p) => {
    ui.armed = null;
    if (state.view === 'project' && samePath(state.path, p.path)) go('projects');
    runStation({ title: t('ui.projects.remove_title'), action: 'remove', target: p.path, command: `git config --global --fixed-value --unset-all warden.projects ${p.path}` });
  },
  arm: (path) => {
    ui.armed = path;
    renderMain();
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      ui.armed = null;
      renderMain();
    }, 5000);
  },
};

function context() {
  const detail = store.detail && store.detailKey.startsWith(`${state.path}|`) ? store.detail : null;
  return {
    ...ctxActions, state, ui, data: store.projects, detail, detailError: detail ? null : store.detailError,
    project: state.path ? projectOf(store.projects, state.path) : null, disk: store.disks.get(state.path) ?? null, rules: store.rules.get(state.path) ?? null,
  };
}

// The rail: what waits, the projects, the reading time, the theme.
function renderRail() {
  const data = store.projects;
  const cases = (data?.cases ?? []).filter((c) => c.state !== 'done').length;
  const projects = data?.projects ?? [];
  const nav = (id, label, iconName, count) => h('button', {
    type: 'button', class: 'nav', 'aria-current': state.view === id ? 'page' : null, on: { click: () => go(id) },
  }, icon(iconName), h('span', { class: 'lab' }, label), h('span', { class: 'cnt' }, count ? String(count) : ''));
  const rows = projects.map((p) => {
    const st = trainState(p);
    const n = todoCount(data, p.path);
    return h('button', {
      type: 'button', class: 'proj', 'aria-current': state.view === 'project' && samePath(state.path, p.path) ? 'page' : null, title: p.path, on: { click: () => go('project', p.path) },
    }, h('span', { class: 'dot', 'data-d': st.tone, 'aria-hidden': 'true' }), h('span', { class: 'pn' }, h('span', { class: 'ell' }, p.name), h('span', { class: 'ell ps' }, [st.label, st.sub].filter(Boolean).join(' · '))), h('span', { class: 'cnt' }, n ? String(n) : ''));
  });
  const dark = isDark();
  $('rail').replaceChildren(
    h('div', { class: 'brand' }, brandMark(24), h('span', { class: 'lab' }, 'Warden', h('span', { class: 'point' }, '.')), store.projects?.newest_kit ? h('span', { class: 'ver', title: t('ui.kit.newest') }, store.projects.newest_from === 'plugin' ? t('ui.plugin.version', { v: store.projects.newest_kit }) : t('ui.kit.version', { v: store.projects.newest_kit })) : null),
    h('nav', { class: 'navs', 'aria-label': t('ui.rail.nav') }, nav('inbox', t('ui.rail.yours'), 'inbox', cases), nav('projects', t('ui.rail.projects'), 'folder', projects.length)),
    h('div', { class: 'tree' }, h('div', { class: 'treeh' }, t('ui.rail.station')), rows, h('button', { type: 'button', class: 'rlmore', on: { click: () => go('projects') } }, t('ui.rail.all_projects'))),
    h('div', { class: 'railfoot' },
      h('button', { type: 'button', class: 'nav reread', title: t('ui.rail.reread'), on: { click: () => rereadAll() } },
        h('span', { class: 'rdot', 'data-busy': reading() ? '1' : '0', 'data-err': store.projectsError ? '1' : '0', 'aria-hidden': 'true' }),
        h('span', { class: 'lab col' }, h('span', null, store.readAt ? t('ui.rail.read_at', { at: fmtClock(store.readAt) }) : t('ui.rail.reading')), h('span', { class: 'ps' }, t('ui.rail.local')))),
      h('div', { class: 'railend' }, h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'ib', 'aria-label': dark ? t('ui.theme.to_light') : t('ui.theme.to_dark'), title: dark ? t('ui.theme.to_light') : t('ui.theme.to_dark'), on: { click: toggleTheme } }, icon(dark ? 'moon' : 'sun', 17)))));
  $('rail').dataset.open = ui.railOpen ? '1' : '0';
}

function renderTop() {
  const p = state.path ? projectOf(store.projects, state.path) : null;
  const trail = state.view === 'inbox' ? [t('ui.rail.yours')] : state.view === 'projects' ? [t('ui.rail.projects')] : [p?.name ?? '…', p?.ok ? tabLabel(state.tab) : null].filter(Boolean);
  $('top').replaceChildren(
    h('button', { type: 'button', class: 'ib menu', 'aria-label': t('ui.rail.menu'), 'aria-expanded': String(ui.railOpen), on: { click: () => { ui.railOpen = !ui.railOpen; renderRail(); } } }, icon('menu', 18)),
    h('nav', { class: 'crumbs', 'aria-label': t('ui.rail.trail') }, h('span', null, 'Warden'), trail.map((part, i) => [h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('span', { class: i === trail.length - 1 ? 'here ell' : 'ell' }, part)])));
}

function renderMain() {
  renderTop();
  const ctx = context();
  const content = [];
  if (store.projectsError) {
    content.push(h('div', { class: 'banner' }, badge('unk', t('ui.error.title')), h('span', { class: 'grow' }, store.projectsError), store.readAt ? h('span', { class: 'quiet' }, t('ui.error.last_read', { at: fmtClock(store.readAt) })) : null));
  }
  if (!store.projects) content.push(store.projectsError ? null : h('div', { class: 'skel big', 'aria-busy': 'true' }, h('div', { class: 'sk sk-a' }), h('div', { class: 'sk sk-b' }), h('div', { class: 'sk sk-c' })));
  else if (state.view === 'inbox') content.push(...renderInbox(ctx));
  else if (state.view === 'projects') content.push(...renderProjects(ctx));
  else content.push(...renderProject(ctx));
  keepFocus(() => $('page').replaceChildren(h('div', { class: 'pgi' }, content.filter(Boolean))));
}

// Without the token of the address, nothing answers: the page says how to open it again, in commands only.
function stopped(status) {
  $('page').replaceChildren(h('div', { class: 'pgi' }, h('div', { class: 'banner' }, icon('shield', 18), h('span', { class: 'mono' }, String(status)), h('span', { class: 'mono grow' }, 'node scripts/warden/ui.mjs'))));
}

async function boot() {
  if (!readToken()) {
    stopped(403);
    return;
  }
  try {
    await loadStrings();
  } catch (error) {
    stopped(error.status || 'offline');
    return;
  }
  document.title = t('ui.title');
  setupDrawer({ reread: rereadAll, toast });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.railOpen) {
      ui.railOpen = false;
      renderRail();
    }
  });
  document.addEventListener('visibilitychange', () => !document.hidden && tick());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderRail());
  renderRail();
  renderMain();
  await loadProjects();
  setInterval(tick, 1000);
}

boot();
