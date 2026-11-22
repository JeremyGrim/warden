#!/usr/bin/env node
// Plays the plugin in a real Codex, in a throwaway CODEX_HOME: the person's Codex configuration is never read or
// written. No model turn runs: Codex installs the plugin with its own commands, then its app server lists what it
// loads (the hook, the skills), and the hook is run the way Codex runs it.
//
//   node tools/codex-check.mjs [--codex <codex executable>] [--project <a repository with the kit>]
//
// Exit 0: every check passed. 1: a check failed. 2: no Codex on this workstation, nothing proven.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { REPO } from './fingerprints.mjs';

const value = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);

// The Codex desktop app ships its runtime without putting `codex` on the PATH (Windows package `OpenAI.Codex`).
function findCodex() {
  const given = value('--codex') ?? process.env.WARDEN_CODEX;
  if (given) return given;
  if (spawnSync('codex', ['--version'], { windowsHide: true }).status === 0) return 'codex';
  if (process.platform !== 'win32') return null;
  const shown = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'], { encoding: 'utf8', windowsHide: true });
  const folder = shown.stdout?.trim();
  return folder ? join(folder, 'app', 'resources', 'codex.exe') : null;
}

function appServer(codex, env, cwd) {
  const child = spawn(codex, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    } catch {
      // A line that is not a message.
    }
  });
  let next = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const note = (method) => child.stdin.write(`${JSON.stringify({ method })}\n`);
  const ended = new Promise((resolve) => child.once('exit', resolve));
  const stop = () => {
    child.stdin.end();
    child.kill();
    return ended;
  };
  return { call, note, stop };
}

const results = [];
const check = (title, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${title}${detail ? ` — ${detail}` : ''}`);
};

const codex = findCodex();
if (!codex || spawnSync(codex, ['--version'], { windowsHide: true }).status !== 0) {
  console.log('No Codex on this workstation: nothing proven.');
  process.exit(2);
}
const project = value('--project') ?? REPO;
const home = mkdtempSync(join(tmpdir(), 'warden-codex-'));
const env = { ...process.env, CODEX_HOME: home };
const timer = setTimeout(() => { console.log('✖ Codex did not answer within 90 s'); process.exit(1); }, 90000);
try {
  console.log(`${spawnSync(codex, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim()}, home ${home}`);
  const added = spawnSync(codex, ['plugin', 'marketplace', 'add', REPO], { env, encoding: 'utf8', windowsHide: true });
  check('Codex adds the marketplace of this repository', added.status === 0, added.stderr?.split('\n').find((l) => /error/i.test(l)) ?? '');
  const installed = spawnSync(codex, ['plugin', 'add', 'warden@warden', '--json'], { env, encoding: 'utf8', windowsHide: true });
  const version = installed.status === 0 ? JSON.parse(installed.stdout).version : null;
  check('Codex installs warden@warden', Boolean(version), version ?? '');

  const server = appServer(codex, env, project);
  await server.call('initialize', { clientInfo: { name: 'warden-codex-check', title: 'Warden', version: version ?? '0' } });
  server.note('initialized');
  const hooks = (await server.call('hooks/list', { cwds: [project] })).result?.data?.[0]?.hooks ?? [];
  const skills = (await server.call('skills/list', { cwds: [project] })).result?.data?.[0]?.skills ?? [];
  await server.stop();

  const hook = hooks.find((h) => h.pluginId === 'warden@warden');
  check('Codex reads the session hook of hooks/codex-hooks.json', hook?.key === 'warden@warden:hooks/codex-hooks.json:session_start:0:0', hook?.key ?? 'none');
  check('Codex gives the hook its plugin folder', Boolean(hook?.command) && !hook.command.includes('${PLUGIN_ROOT}'), hook?.command ?? '');
  const ours = readdirSync(join(REPO, 'skills')).map((name) => `warden:${name}`);
  const listed = new Set(skills.filter((s) => s.pluginId === 'warden@warden' && s.enabled).map((s) => s.name));
  check('Codex lists every skill of the plugin', ours.every((name) => listed.has(name)), `${listed.size}/${ours.length}`);

  if (hook?.command) {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: project });
    const shell = process.platform === 'win32' ? ['pwsh', ['-NoProfile', '-Command', hook.command]] : ['sh', ['-c', hook.command]];
    const ran = spawnSync(shell[0], shell[1], { input, cwd: project, encoding: 'utf8', windowsHide: true });
    check(`the hook runs as Codex runs it (${shell[0]})`, ran.status === 0, (ran.stdout || ran.stderr || '').trim().split('\n')[0] ?? '');
    if (ran.stdout?.trim()) check('its notices name the skills as Codex does', !ran.stdout.includes('/warden:'), ran.stdout.trim().split('\n').at(-1));
  }
  console.log(`Trust is the person's: Codex runs the hook once approved (trustStatus: ${hook?.trustStatus ?? 'unknown'}).`);
} finally {
  clearTimeout(timer);
  // A process Codex started may still hold its files a moment after the app server ends.
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
  } catch (error) {
    console.log(`The throwaway home stays, to remove later: ${home} (${error.code})`);
  }
}
process.exit(results.every(Boolean) ? 0 : 1);
