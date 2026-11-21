#!/usr/bin/env node
// The interface: a local page for the person alone, served by the kit. It shows every project of the workstation (the
// global `git config warden.projects`, and the project it is launched from), each read by its own kit, and runs only the
// gestures that bypass nothing: a dry run, the factory's own cleanup, reading the version, a release, turning the hooks
// on, the workstation settings, and the marks the person keeps on the workstation (docs/interface.md).
//
//   node scripts/warden/ui.mjs [--port <n>] [--no-open]
//
// It listens on 127.0.0.1 only. Its address carries a token that every call gives back: another page of the browser can
// neither read it nor act through it. The page loads nothing from outside, and nothing leaves the workstation.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT } from './config.mjs';
import { manifestGaps, MANIFEST } from './kit.mjs';
import { CATALOGS, resolveLocale, t } from './messages.mjs';

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_MAX = 256 * 1024;
const FILE_MAX = 512 * 1024;
const STATE = 'warden-ui.json';
// The page's own files, served from the kit folder: never the server, never a guard.
const STATIC = /^ui\.(html|css)$|^ui-[a-z]+\.mjs$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
// The workstation settings the page may write in a clone (docs/configuration.md). `core.hooksPath` is only ever turned
// on, by its own gesture: switching it off would skip every check of the clone.
export const SETTINGS = ['warden.factory', 'warden.slot', 'warden.tasks', 'warden.ghsa', 'warden.locale'];

const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
// A step launched by the kit never passes on a test runner's context: a `node --test` receiving it skips everything.
const childEnv = () => {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  void NODE_TEST_CONTEXT;
  return env;
};

function git(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: childEnv() });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim(), error: (out.stderr ?? '').trim() };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// -1, 0 or 1 between two "a.b.c" versions; an unreadable one counts as 0.0.0.
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '0.0.0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

// A script of a project's own kit, run in that project; its output as JSON, or null.
function kitJson(root, script, args) {
  const file = join(root, 'scripts', 'warden', script);
  if (!existsSync(file)) return Promise.resolve(null);
  return new Promise((done) => {
    execFile(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26, env: childEnv() }, (error, stdout) => {
      if (error) return done(null);
      try {
        return done(JSON.parse(stdout));
      } catch {
        return done(null);
      }
    });
  });
}

// The project a tree belongs to: the main root of its clone.
export function mainRoot(tree) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], tree);
  return common.ok ? dirname(common.out) : resolve(tree);
}

export function listedProjects(cwd = ROOT) {
  const r = git(['config', '--global', '--get-all', 'warden.projects'], cwd);
  return r.ok ? r.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

// The projects the page covers: those listed on the workstation, and the one it was launched from.
export function projectEntries(listed, here) {
  const entries = [];
  for (const path of [...listed, here]) {
    if (path && !entries.some((e) => samePath(e.path, path))) entries.push({ path: resolve(path) });
  }
  return entries.map((e) => ({ ...e, name: basename(e.path), listed: listed.some((p) => samePath(p, e.path)), here: Boolean(here) && samePath(e.path, here) }));
}

// The marks the person keeps for a project, in its Git folder: never committed, never shared.
function statePath(root) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  return common.ok ? join(common.out, STATE) : null;
}
export const readState = (root) => ({ cases: {}, published: {}, ...(readJson(statePath(root) ?? '') ?? {}) });
function writeState(root, state) {
  const path = statePath(root);
  if (path) writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// A deposit file as it is written: `key = value` lines. A taken deposit adds `taken = <commit> in <main> at <date>`.
export function parseDeposit(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  const taken = /^(\S+) in (\S+)(?: at (\S+))?$/.exec(fields.taken ?? '');
  return { ...fields, taken: taken ? { commit: taken[1], main: taken[2], at: taken[3] ?? null } : null };
}

function readTaken(dock) {
  const folder = dock ? join(dock, 'taken') : null;
  if (!folder || !existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => f.endsWith('.txt')).sort().reverse().map((file) => {
    const fields = parseDeposit(readFileSync(join(folder, file), 'utf8'));
    return { file, name: file.replace(/^\d[\d-]*-/, '').replace(/\.txt$/, ''), ...fields };
  });
}

function readReleases(work) {
  const folder = work ? join(work, 'releases') : null;
  if (!folder || !existsSync(folder)) return [];
  return readdirSync(folder).flatMap((label) => {
    const json = readJson(join(folder, label, 'release.json'));
    return json ? [{ folder: label, ...json }] : [];
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// What a project's kit cannot give, by its version.
export function absentData(version) {
  const before = (v) => compareVersions(version, v) < 0;
  return { history: before('0.4.0'), refusals: before('0.4.0'), releases: before('0.4.0'), version: before('0.4.1'), disk: before('0.4.3'), live_train: before('0.4.3') };
}

export async function readProject(entry) {
  const base = { ...entry, ok: false };
  if (!existsSync(entry.path)) return { ...base, reason: 'missing' };
  if (!git(['rev-parse', '--git-dir'], entry.path).ok) return { ...base, reason: 'not_git' };
  const kit = readJson(join(entry.path, 'scripts', 'warden', MANIFEST));
  if (!kit) return { ...base, reason: 'no_kit' };
  const status = await kitJson(entry.path, 'status.mjs', ['--json']);
  if (!status) return { ...base, reason: 'unreadable', kit: { name: kit.name, version: kit.version } };
  const work = status.slot ? dirname(status.slot.folder) : null;
  const history = work ? readLines(join(work, 'warden-history.jsonl')) : [];
  return {
    ...base, ok: true, kit: { name: kit.name, version: kit.version }, absent: absentData(kit.version), status, work,
    last_train: history.filter((e) => e.kind === 'train').at(-1) ?? null,
    releases: readReleases(work), state: readState(entry.path),
  };
}

export async function projectDetail(project, { days = 7 } = {}) {
  const { path, status, work } = project;
  const dock = status.dock?.folder ?? null;
  const gaps = manifestGaps(join(path, 'scripts', 'warden'), readJson(join(path, 'scripts', 'warden', MANIFEST)) ?? {});
  const config = Object.fromEntries(['factory', 'rules', 'disk', 'disk.local'].map((name) => {
    const file = join(path, 'config', `${name}.json`);
    return [name, existsSync(file) ? (readJson(file) ?? { unreadable: true }) : null];
  }));
  const settings = {};
  for (const key of [...SETTINGS, 'warden.agentTrees', 'core.hooksPath']) {
    const r = git(['config', '--get-all', key], path);
    settings[key] = r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
  }
  const versionScript = join(path, 'scripts', 'warden', 'version.mjs');
  let versionError = null;
  if (existsSync(versionScript)) {
    const r = spawnSync(process.execPath, [versionScript, 'show'], { cwd: path, encoding: 'utf8', windowsHide: true, env: childEnv() });
    if (r.status !== 0) versionError = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  }
  return {
    ...project,
    summary: project.absent.history ? null : await kitJson(path, 'status.mjs', ['--history', '--days', String(days), '--json']),
    days,
    history: work ? readLines(join(work, 'warden-history.jsonl')) : [],
    taken: readTaken(dock),
    version: project.absent.version ? null : await kitJson(path, 'version.mjs', ['show', '--json']),
    version_error: versionError,
    kit_integrity: { files: Object.keys(readJson(join(path, 'scripts', 'warden', MANIFEST))?.files ?? {}).length, ...gaps },
    config, settings,
  };
}

// What waits for the person, from one project's data (docs/interface.md). Only what is theirs: never a refusal (the
// author's), never a red main branch (a deposit repairs it), never an incident being retried.
export function casesFor(project, { newestKit = null, disk = null } = {}) {
  if (!project.ok) return [];
  const state = project.state ?? { cases: {}, published: {} };
  const cases = [];
  const add = (id, kind, fields) => cases.push({ id, kind, project: project.path, state: state.cases?.[id]?.state === 'done' ? 'done' : 'todo', ...fields });
  const halt = project.status.dock?.halt;
  if (halt?.noticed && halt.reason === 'memory') add(`halt:${halt.at}`, 'halt_memory', { since: halt.at, source: '.work/train-ready/_halt.json', vars: { cause: halt.cause } });
  else if (halt?.noticed && halt.class === 'incomplete') add(`halt:${halt.at}`, 'halt_incomplete', { since: halt.at, source: '.work/train-ready/_halt.json', vars: { cause: halt.cause } });
  for (const release of project.releases ?? []) {
    if (!state.published?.[release.label]) add(`release:${release.label}`, 'release', { since: release.at, source: `.work/releases/${release.folder}/`, vars: { label: release.label } });
  }
  for (const tree of disk?.trees ?? []) {
    if (tree.removable) add(`tree:${tree.path}`, tree.absent ? 'tree_absent' : 'tree_removable', { since: null, source: 'disk.mjs report --json', vars: { path: tree.path, branch: tree.branch, days: tree.ageDays } });
  }
  for (const alert of disk?.alerts ?? []) {
    add(`alert:${createHash('sha1').update(alert).digest('hex').slice(0, 12)}`, 'disk_alert', { since: null, source: 'disk.mjs report --json', vars: { alert } });
  }
  if (newestKit && compareVersions(project.kit.version, newestKit) < 0) add(`kit:${project.kit.version}`, 'kit_behind', { since: null, source: 'scripts/warden/kit.json', vars: { kit: project.kit.version, newest: newestKit } });
  if (!project.status.hooks_active) add('hooks', 'hooks_off', { since: null, source: 'status.mjs --json', vars: {} });
  return cases;
}

// A gesture as the person asks for it: the command, the tree it runs in, or a refusal. Nothing else ever runs.
export function gestureCommand(gesture, args, project) {
  const factory = project.status?.factory_tree ?? null;
  const kit = (script, ...rest) => ({ program: process.execPath, args: [join('scripts', 'warden', script), ...rest], show: `node scripts/warden/${script} ${rest.join(' ')}`.trim() });
  const inFactory = (command) => {
    if (!factory || !existsSync(factory)) throw new Error(t('ui_server.no_factory'));
    return { ...command, cwd: factory };
  };
  switch (gesture) {
    case 'train.dry_run':
      return inFactory(kit('train.mjs', 'run', '--dry-run'));
    case 'disk.clean_own':
      return inFactory(kit('disk.mjs', 'clean', '--own', ...(args.deep ? ['--deep'] : []), ...(args.apply ? ['--apply'] : [])));
    case 'version.show':
      return { ...kit('version.mjs', 'show'), cwd: project.path };
    case 'release.build': {
      if (!/^[0-9a-f]{7,40}$/i.test(String(args.commit ?? ''))) throw new Error(t('ui_server.bad_commit'));
      return inFactory(kit('release.mjs', 'build', '--commit', args.commit));
    }
    case 'hooks.on':
      return { program: 'git', args: ['config', 'core.hooksPath', '.githooks'], show: 'git config core.hooksPath .githooks', cwd: project.path };
    case 'setting.set': {
      const key = String(args.key ?? '');
      const value = String(args.value ?? '').trim();
      if (!SETTINGS.includes(key)) throw new Error(t('ui_server.bad_setting', { key }));
      if (key === 'warden.locale' && value && !['en', 'fr'].includes(value)) throw new Error(t('ui_server.bad_setting', { key }));
      const words = value ? ['config', key, value] : ['config', '--unset', key];
      return { program: 'git', args: words, show: `git ${words.join(' ')}`, cwd: project.path };
    }
    default:
      throw new Error(t('ui_server.bad_gesture', { gesture }));
  }
}

function runCommand({ program, args, cwd }) {
  return new Promise((done) => {
    const child = spawn(program, args, { cwd, windowsHide: true, env: childEnv() });
    let output = '';
    const keep = (chunk) => {
      output += chunk;
      if (output.length > OUTPUT_MAX) output = output.slice(-OUTPUT_MAX);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => done({ code: 1, output: error.message }));
    child.on('close', (code) => done({ code: code ?? 1, output }));
  });
}

// A file of the work folder, read only: a train log, a refusal, the halt, a release file, the factory log.
export function workFile(work, file) {
  if (!work || !file || isAbsolute(file)) return null;
  const path = resolve(work, file);
  const rel = relative(work, path);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(path) || !statSync(path).isFile()) return null;
  return path;
}

function readTail(path) {
  const size = statSync(path).size;
  const text = readFileSync(path, 'utf8');
  return { content: size > FILE_MAX ? text.slice(-FILE_MAX) : text, truncated: size > FILE_MAX };
}

export async function startServer({ port = 0, here = mainRoot(ROOT), listed = () => listedProjects(here), token = randomBytes(16).toString('hex') } = {}) {
  const disks = new Map();
  let busy = false;
  let actual = port;

  const entries = () => projectEntries(listed(), here);
  const known = (path) => entries().find((e) => path && samePath(e.path, path)) ?? null;
  const quickDisk = async (project) => {
    if (!project.ok || project.absent.disk) return null;
    const cached = disks.get(project.path);
    if (cached && Date.now() - cached.at < 60 * 1000) return cached.data;
    const data = await kitJson(project.path, 'disk.mjs', ['report', '--json', '--quick']);
    disks.set(project.path, { at: Date.now(), data });
    return data;
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { ...HEADERS, 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  const tokenOk = (given) => typeof given === 'string' && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  const body = (req) => new Promise((done, fail) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        done(JSON.parse(text || '{}'));
      } catch (error) {
        fail(error);
      }
    });
  });

  const api = async (req, res, url) => {
    const route = `${req.method} ${url.pathname}`;
    // Read at each call: a locale changed from the page shows at the next reload, with no restart.
    if (route === 'GET /api/strings') {
      const locale = resolveLocale();
      const strings = Object.fromEntries(Object.entries({ ...CATALOGS.en, ...CATALOGS[locale] }).filter(([key]) => key.startsWith('ui.')));
      return send(res, 200, { locale, strings });
    }
    if (route === 'GET /api/projects') {
      const projects = await Promise.all(entries().map(readProject));
      const newestKit = projects.filter((p) => p.kit).map((p) => p.kit.version).sort(compareVersions).at(-1) ?? null;
      const disksRead = await Promise.all(projects.map(quickDisk));
      const cases = projects.flatMap((p, i) => casesFor(p, { newestKit, disk: disksRead[i] }));
      return send(res, 200, { read_at: new Date().toISOString(), here, newest_kit: newestKit, projects, cases });
    }
    const entry = known(url.searchParams.get('path'));
    if (route === 'POST /api/projects') {
      const { action, target } = await body(req);
      const path = typeof target === 'string' && isAbsolute(target) ? resolve(target) : null;
      if (!path || !['add', 'remove'].includes(action)) return send(res, 400, { error: t('ui_server.bad_project') });
      // A value is removed as it is written: the same project may be listed with other slashes or another case.
      const values = action === 'add' ? (listed().some((p) => samePath(p, path)) ? [] : [path]) : listed().filter((p) => samePath(p, path));
      const runs = values.map((value) => {
        const words = action === 'add' ? ['config', '--global', '--add', 'warden.projects', value] : ['config', '--global', '--fixed-value', '--unset-all', 'warden.projects', value];
        return { command: `git ${words.join(' ')}`, ...git(words, here) };
      });
      const shown = runs.map((r) => r.command).join('\n') || `git config --global ${action === 'add' ? '--add' : '--unset-all'} warden.projects ${path}`;
      return send(res, 200, { command: shown, code: runs.every((r) => r.ok) ? 0 : 1, output: runs.map((r) => r.error).filter(Boolean).join('\n') });
    }
    if (!entry) return send(res, 404, { error: t('ui_server.unknown_project') });
    const project = await readProject(entry);
    if (route === 'GET /api/project') {
      if (!project.ok) return send(res, 200, project);
      return send(res, 200, await projectDetail(project, { days: Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7)) }));
    }
    if (route === 'GET /api/disk') {
      if (!project.ok || project.absent.disk) return send(res, 200, null);
      if (url.searchParams.get('full') !== '1') return send(res, 200, await quickDisk(project));
      return send(res, 200, await kitJson(project.path, 'disk.mjs', ['report', '--json']));
    }
    if (route === 'GET /api/file') {
      const path = workFile(project.work, url.searchParams.get('file'));
      return path ? send(res, 200, { file: url.searchParams.get('file'), ...readTail(path) }) : send(res, 404, { error: t('ui_server.no_file') });
    }
    if (route === 'POST /api/mark') {
      const { id, state, label, published } = await body(req);
      const marks = readState(project.path);
      if (typeof id === 'string') marks.cases[id] = { state: state === 'done' ? 'done' : 'todo', at: new Date().toISOString() };
      if (typeof label === 'string') {
        if (published) marks.published[label] = new Date().toISOString();
        else delete marks.published[label];
      }
      writeState(project.path, marks);
      return send(res, 200, marks);
    }
    if (route === 'POST /api/run') {
      if (busy) return send(res, 409, { error: t('ui_server.busy') });
      const { gesture, args = {} } = await body(req);
      let command;
      try {
        command = gestureCommand(gesture, args, project);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      busy = true;
      try {
        const result = await runCommand(command);
        disks.delete(project.path);
        return send(res, 200, { gesture, command: command.show, cwd: command.cwd, ...result });
      } finally {
        busy = false;
      }
    }
    return send(res, 404, { error: route });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Only this address: a page of another site that renames itself 127.0.0.1 (DNS rebinding) is refused.
    if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host ?? '')) return send(res, 421, { error: 'host' });
    if (url.pathname.startsWith('/api/')) {
      if (!tokenOk(req.headers['x-warden-token'])) return send(res, 403, { error: 'token' });
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'type' });
      return api(req, res, url).catch((error) => send(res, 500, { error: error.message }));
    }
    const name = url.pathname === '/' ? 'ui.html' : url.pathname.slice(1);
    if (req.method !== 'GET' || !STATIC.test(name) || !existsSync(join(KIT_DIR, name))) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, readFileSync(join(KIT_DIR, name)), TYPES[extname(name)]);
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  actual = server.address().port;
  return { server, port: actual, token, url: `http://127.0.0.1:${actual}/#t=${token}` };
}

function openBrowser(url) {
  const [program, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(t('ui_server.open_failed')));
  child.unref();
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  const argv = process.argv.slice(2);
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(t('ui_server.usage'));
    process.exit(2);
  }
  const { url } = await startServer({ port });
  console.log(t('ui_server.listening', { url }));
  if (!argv.includes('--no-open')) openBrowser(url);
}
