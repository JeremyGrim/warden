// First: the git commands of this guard do not inherit the repository that launches it.
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { absentData, casesFor, compareVersions, gestureCommand, newestSeen, parseDeposit, projectEntries, startServer, workFile } from './ui.mjs';

const project = (fields = {}) => ({
  ok: true, path: '/p/alpha', kit: { version: '0.4.3' }, releases: [], state: { cases: {}, published: {} },
  status: { hooks_active: true, factory_tree: null, dock: { halt: null } }, ...fields,
});

test('versions compare part by part, and the kit version says what a project cannot give', () => {
  assert.equal(compareVersions('0.4.10', '0.4.9'), 1);
  assert.equal(compareVersions('0.3.0', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.3', '0.4.3'), 0);
  assert.deepEqual(absentData('0.3.0'), { history: true, refusals: true, releases: true, version: true, disk: true, live_train: true, decisions: true, clean_tree: true, config_change: true, rules: true });
  assert.equal(absentData('0.4.1').version, false);
  assert.equal(absentData('0.4.2').disk, true);
  assert.deepEqual([absentData('0.4.3').decisions, absentData('0.4.4').decisions, absentData('0.4.4').config_change], [true, false, false]);
  assert.deepEqual([absentData('0.4.6').rules, absentData('0.4.7').rules], [true, false]);
});

// The page modules run in the browser only: no other guard loads them. A name imported and declared again in one of
// them stopped the whole page (23 November, the mark of the rail).
test('every module of the page parses', () => {
  const folder = dirname(fileURLToPath(import.meta.url));
  for (const file of readdirSync(folder).filter((name) => /^ui-[a-z]+\.mjs$/.test(name))) {
    const parsed = spawnSync(process.execPath, ['--check', join(folder, file)], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
  }
});

test('the projects are those listed and the one launched from, once each', () => {
  const entries = projectEntries(['/p/alpha', '/p/beta', '/p/alpha'], '/p/beta');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => [e.name, e.listed, e.here]), [['alpha', true, false], ['beta', true, true]]);
  assert.equal(projectEntries([], '/p/gamma')[0].listed, false, 'the project it runs from, even unlisted');
});

test('a taken deposit gives the commit taken, the main commit and the moment', () => {
  const d = parseDeposit('tree = /t\nbranch = agent-a\ncommit = abc1234\ntaken = abc1234 in def5678 at 2026-11-21T10:00:00.000Z\n');
  assert.equal(d.branch, 'agent-a');
  assert.deepEqual(d.taken, { commit: 'abc1234', main: 'def5678', at: '2026-11-21T10:00:00.000Z' });
  assert.equal(parseDeposit('taken = abc in def\n').taken.at, null, 'a line written before the moment was added');
});

test('only what is the person\'s waits for them', () => {
  const halt = (fields) => project({ status: { hooks_active: true, dock: { halt: { at: 'h1', cause: 'c', noticed: true, ...fields } } } });
  assert.deepEqual(casesFor(halt({ class: 'transient', reason: 'memory' })).map((c) => c.kind), ['halt_memory']);
  assert.deepEqual(casesFor(halt({ class: 'incomplete', reason: null })).map((c) => c.kind), ['halt_incomplete']);
  assert.deepEqual(casesFor(halt({ class: 'baseline', reason: null })), [], 'a red main branch is repaired by a deposit');
  assert.deepEqual(casesFor(halt({ class: 'incomplete', reason: null, noticed: false })), [], 'not before its notice');
  assert.deepEqual(casesFor(halt({ class: 'transient', reason: null })), [], 'an incident being retried');
  const releases = [{ label: 'v1.0.0', folder: 'v1.0.0', at: 'r' }, { label: 'v0.9.0', folder: 'v0.9.0', at: 'r' }];
  const published = project({ releases, state: { cases: {}, published: { 'v0.9.0': 'x' } } });
  assert.deepEqual(casesFor(published).map((c) => c.id), ['release:v1.0.0'], 'a published release is no longer a case');
  const disk = { trees: [{ path: '/t/a', branch: 'a', ageDays: 9, removable: true }, { path: '/t/b', removable: false }, { path: '/t/c', absent: true, removable: true }], alerts: ['too many trees'] };
  assert.deepEqual(casesFor(project(), { disk }).map((c) => c.kind), ['tree_removable', 'tree_absent', 'disk_alert']);
  assert.deepEqual(casesFor(project({ kit: { version: '0.4.1' } }), { newestKit: '0.4.3' }).map((c) => [c.kind, c.vars.newest]), [['kit_behind', '0.4.3']]);
  const decisions = [
    { id: '20261121-160509-abcd', at: 'd', title: 'Keep?', question: 'q', options: ['Keep', 'Drop'], state: 'open' },
    { id: '20261121-150000-abcd', at: 'd', title: 'Done', question: 'q', options: [], state: 'answered' },
  ];
  assert.deepEqual(casesFor(project({ decisions })).map((c) => [c.kind, c.vars.title, c.vars.options.length]), [['decision', 'Keep?', 2]], 'an answered decision waits for the factory, not the person');
  const off = casesFor(project({ status: { hooks_active: false, dock: { halt: null } }, state: { cases: { hooks: { state: 'done' } }, published: {} } }));
  assert.deepEqual(off.map((c) => [c.kind, c.state]), [['hooks_off', 'done']], 'marked seen, it stays while its cause holds');
  assert.deepEqual(casesFor({ ok: false }), []);
});

test('the newest version seen on the workstation is a kit\'s or the plugin\'s, the plugin first at equal versions', () => {
  const kits = [{ kit: { version: '0.4.3' } }, { kit: { version: '0.4.1' }, plugin: { version: '0.4.4' } }, { kit: null }];
  assert.deepEqual(newestSeen(kits), { version: '0.4.4', from: 'plugin' });
  assert.deepEqual(newestSeen([{ kit: { version: '0.4.4' } }, { kit: { version: '0.4.2' }, plugin: { version: '0.4.4' } }]), { version: '0.4.4', from: 'plugin' });
  assert.equal(newestSeen([]), null);
  const behind = casesFor(project({ kit: { version: '0.4.3' } }), { newestKit: '0.4.4', newestFrom: 'plugin' });
  assert.deepEqual(behind.map((c) => c.vars.from), ['plugin']);
});

test('only the gestures that bypass nothing run, each in its own tree', () => {
  const p = project({ status: { factory_tree: process.cwd(), dock: { halt: null } } });
  assert.match(gestureCommand('train.dry_run', {}, p).show, /train\.mjs run --dry-run$/);
  assert.equal(gestureCommand('train.dry_run', {}, p).cwd, process.cwd(), 'in the factory tree');
  assert.match(gestureCommand('disk.clean_own', { deep: true, apply: true }, p).show, /clean --own --deep --apply$/);
  assert.match(gestureCommand('release.build', { commit: 'abc1234' }, p).show, /release\.mjs build --commit abc1234$/);
  assert.throws(() => gestureCommand('release.build', { commit: 'abc; rm -rf /' }, p), /commit/);
  assert.equal(gestureCommand('hooks.on', {}, p).show, 'git config core.hooksPath .githooks');
  assert.deepEqual(gestureCommand('setting.set', { key: 'warden.locale', value: 'fr' }, p).args, ['config', 'warden.locale', 'fr']);
  assert.deepEqual(gestureCommand('setting.set', { key: 'warden.tasks', value: '' }, p).args, ['config', '--unset', 'warden.tasks']);
  assert.throws(() => gestureCommand('setting.set', { key: 'core.hooksPath', value: '' }, p), /core\.hooksPath/, 'never switched off');
  assert.throws(() => gestureCommand('setting.set', { key: 'warden.locale', value: 'de' }, p));
  for (const gesture of ['train.run', 'train.recover', 'version.bump', 'disk.clean', 'git.push']) assert.throws(() => gestureCommand(gesture, {}, p), new RegExp(gesture.replace('.', '\\.')));
  assert.throws(() => gestureCommand('train.dry_run', {}, project()), /warden\.factory/, 'no factory, no factory gesture');
  const tree = gestureCommand('disk.clean_tree', { tree: '/t/agent-a', apply: true }, p);
  assert.deepEqual([tree.args.slice(1), tree.cwd], [['clean', '--tree', '/t/agent-a', '--apply'], '/p/alpha'], 'from the project root, the kit checks the tree');
  for (const bad of ['relative/tree', '/t/a\nb', null]) assert.throws(() => gestureCommand('disk.clean_tree', { tree: bad }, p));
  const answer = gestureCommand('decision.answer', { id: '20261121-160509-abcd', choice: 2, note: 'because' }, p);
  assert.deepEqual(answer.args.slice(1), ['answer', '20261121-160509-abcd', '--choice', '2', '--note', 'because']);
  for (const bad of [{ id: '../x', choice: 1 }, { id: '20261121-160509-abcd', choice: 9 }, { id: '20261121-160509-abcd', note: 'n'.repeat(4001) }]) assert.throws(() => gestureCommand('decision.answer', bad, p));
  const deposit = gestureCommand('config.deposit', { file: 'config/disk.json', content: '{}', message: 'Disk: more trees' }, p);
  assert.deepEqual([deposit.args.slice(1), deposit.input, deposit.cwd], [['deposit', 'config/disk.json', '--message', 'Disk: more trees'], '{}', '/p/alpha']);
  for (const bad of [{ file: 'config/disk.local.json', content: '{}' }, { file: '../config/disk.json', content: '{}' }, { file: 'config/disk.json', content: 1 }, { file: 'config/disk.json', content: '{}', message: 'a\nb' }]) {
    assert.throws(() => gestureCommand('config.deposit', bad, p), /config/);
  }
});

test('a file is read inside the work folder only', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ui-work-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'train-logs'));
  writeFileSync(join(work, 'train-logs', 'a.log'), 'log');
  writeFileSync(join(work, '..', `${join(work).split(/[\\/]/).pop()}-outside.txt`), 'outside');
  assert.ok(workFile(work, 'train-logs/a.log'));
  assert.equal(workFile(work, '../package.json'), null);
  assert.equal(workFile(work, `../${join(work).split(/[\\/]/).pop()}-outside.txt`), null);
  assert.equal(workFile(work, join(work, 'train-logs', 'a.log')), null, 'never an absolute path');
  assert.equal(workFile(work, 'train-logs'), null, 'never a folder');
  assert.equal(workFile(null, 'a.log'), null);
  rmSync(join(work, '..', `${join(work).split(/[\\/]/).pop()}-outside.txt`), { force: true });
});

function call(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

test('the server answers its own page only, with its token, on its own address', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-project-'));
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  const { server, port, token } = await startServer({ here: root, listed: () => [] });
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const auth = { 'x-warden-token': token };
  assert.equal((await call(port, '/api/projects')).status, 403, 'no token');
  assert.equal((await call(port, '/api/projects', { headers: { 'x-warden-token': 'x'.repeat(token.length) } })).status, 403, 'another token');
  assert.equal((await call(port, '/api/projects', { headers: { ...auth, Host: `attacker.example:${port}` } })).status, 421, 'a rebound name');
  assert.equal((await call(port, '/ui.mjs')).status, 404, 'never the server itself');
  assert.equal((await call(port, '/ui.test.mjs')).status, 404);
  assert.equal((await call(port, '/../config.mjs')).status, 404);
  const font = await call(port, '/ui-poppins-900.woff2');
  assert.deepEqual([font.status, font.headers['content-type']], [200, 'font/woff2'], 'the page serves its own font');
  assert.match(font.headers['content-security-policy'], /font-src 'self'/);
  assert.equal((await call(port, '/ui-poppins-OFL.txt')).status, 404, 'the license travels with the kit, the page does not serve it');
  const strings = JSON.parse((await call(port, '/api/strings', { headers: auth })).text);
  assert.ok(Object.keys(strings.strings).every((key) => key.startsWith('ui.')));
  const listing = await call(port, '/api/projects', { headers: auth });
  assert.match(listing.headers['content-security-policy'], /default-src 'none'/);
  const { projects } = JSON.parse(listing.text);
  assert.deepEqual(projects.map((p) => [p.ok, p.reason, p.here]), [[false, 'no_kit', true]]);
  const json = { ...auth, 'Content-Type': 'application/json' };
  const unknown = await call(port, `/api/run?path=${encodeURIComponent(join(root, '..', 'elsewhere'))}`, { method: 'POST', headers: json, body: '{"gesture":"version.show"}' });
  assert.equal(unknown.status, 404, 'a project off the list is never touched');
  const form = await call(port, `/api/run?path=${encodeURIComponent(root)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415, 'what a form of another site could send');
  const relative = await call(port, '/api/projects', { method: 'POST', headers: json, body: '{"action":"add","target":"some/where"}' });
  assert.equal(relative.status, 400, 'an absolute path only');
  const deposit = await call(port, `/api/run?path=${encodeURIComponent(root)}`, { method: 'POST', headers: json, body: '{"gesture":"config.deposit","args":{"file":"config/disk.local.json","content":"{}"}}' });
  assert.equal(deposit.status, 400, 'a workstation file is never deposited');
  const check = await call(port, `/api/check?path=${encodeURIComponent(root)}`, { method: 'POST', headers: json, body: '{"file":"config/disk.json","content":"{}"}' });
  assert.deepEqual(JSON.parse(check.text), { unavailable: true }, 'a project with no kit checks nothing');
  const rules = await call(port, `/api/rules?path=${encodeURIComponent(root)}`, { headers: auth });
  assert.deepEqual([rules.status, JSON.parse(rules.text)], [200, null], 'a project with no kit has no rules to read');
});

test('the workstation list gains and loses a project as it is written, whatever its slashes', async (t) => {
  const tray = mkdtempSync(join(tmpdir(), 'ui-list-'));
  const global = join(tray, 'gitconfig');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  // The list lives in the global Git configuration: the guard gives the server its own, never the workstation's.
  process.env.GIT_CONFIG_GLOBAL = global;
  const project = join(tray, 'alpha');
  mkdirSync(project);
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: project });
  writeFileSync(global, `[warden]\n\tprojects = ${project.replaceAll('\\', '/')}\n`);
  const { server, port, token } = await startServer({ here: project });
  t.after(() => {
    server.close();
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    rmSync(tray, { recursive: true, force: true });
  });
  const post = (body) => call(port, '/api/projects', { method: 'POST', headers: { 'x-warden-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const listed = () => spawnSync('git', ['config', '--global', '--get-all', 'warden.projects'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const again = JSON.parse((await post({ action: 'add', target: project })).text);
  assert.deepEqual([again.code, listed().length], [0, 1], 'listed once, whatever its slashes');
  const removed = JSON.parse((await post({ action: 'remove', target: project })).text);
  assert.equal(removed.code, 0, removed.output);
  assert.deepEqual(listed(), []);
  assert.ok(existsSync(project), 'the project itself is never touched');
});
