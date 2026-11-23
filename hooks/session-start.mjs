#!/usr/bin/env node
// The plugin's only hook, at session start, in Claude Code (hooks/hooks.json) and in Codex (hooks/codex-hooks.json,
// `--host codex`). It checks nothing: it only says, in one line, what keeps the project rules
// from running (inactive Git hooks) or what makes them lag (a kit older than the plugin). When all is well it says
// nothing: no context cost. It reads neither the conversation nor the tools.
//
// It leaves one trace: the plugin version, in the clone's Git folder (`warden-plugin.json`), written when it changes.
// The interface, served by the kit, reads it there to say a kit behind the plugin (docs/interface.md).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocale } from '../kit/scripts/warden/messages.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_RECORD = 'warden-plugin.json';

const MESSAGES = {
  en: {
    hooks: 'Warden: the Git hooks are inactive in this clone, nothing is checked at commit or push. Turn them on: git config core.hooksPath .githooks',
    behind: 'Warden: the project kit is {kit}, the plugin {plugin}. The {setup} skill updates it.',
    onboard: 'Warden rules this repository: run {onboard} before working.',
  },
  fr: {
    hooks: 'Warden : les crochets Git sont inactifs dans ce clone, rien n’est contrôlé au commit ni au push. Les activer : git config core.hooksPath .githooks',
    behind: 'Warden : le kit du projet est en {kit}, le plugin en {plugin}. La skill {setup} le met à jour.',
    onboard: 'Warden règle ce dépôt : lancer {onboard} avant de travailler.',
  },
};

// How a skill is called: a slash command in Claude Code, a `$` mention in Codex (`--host codex`, given by
// hooks/codex-hooks.json), which turns plugin commands into skills and lists them as `warden:<name>`.
export const skill = (name, host = 'claude') => (host === 'codex' ? `$warden:${name}` : `/warden:${name}`);

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// -1, 0 or 1 between two "a.b.c" versions.
export function compare(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

export function notices({ kit, plugin, hooks, source, locale = 'en', host = 'claude' }) {
  if (!kit) return [];
  const m = MESSAGES[locale] ?? MESSAGES.en;
  const lines = [];
  if (hooks !== '.githooks') lines.push(m.hooks);
  if (plugin && compare(kit.version, plugin.version) < 0) {
    lines.push(m.behind.replace('{kit}', kit.version).replace('{plugin}', plugin.version).replace('{setup}', skill('setup', host)));
  }
  // A new session (not a resume or a compaction) is reminded of the onboarding once.
  if (source === 'startup') lines.push(m.onboard.replace('{onboard}', skill('onboard', host)));
  return lines;
}

// The record of the plugin seen in a clone: its version, the moment it was first seen, and its folder, where the
// interface finds the plugin's kit to update a project with. The same version keeps its moment.
export function pluginRecord(previous, version, now = new Date().toISOString(), root = null) {
  if (!version) return null;
  if (previous?.version === version && (previous.root ?? null) === root) return null;
  return { version, since: previous?.version === version ? previous.since : now, ...(root ? { root } : {}) };
}

function main() {
  const input = readInput();
  const here = input.cwd || process.cwd();
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8', windowsHide: true });
  if (top.status !== 0) return;
  const root = top.stdout.trim();
  const manifest = join(root, 'scripts', 'warden', 'kit.json');
  if (!existsSync(manifest)) return;
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };
  const hooks = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const plugin = read(join(PLUGIN, '.claude-plugin', 'plugin.json'));
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  if (common && existsSync(common)) {
    const record = pluginRecord(read(join(common, PLUGIN_RECORD)), plugin?.version, undefined, PLUGIN);
    try {
      if (record) writeFileSync(join(common, PLUGIN_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      // A Git folder that cannot be written keeps only the notices.
    }
  }
  const at = process.argv.indexOf('--host');
  const host = at > 0 ? process.argv[at + 1] : 'claude';
  const lines = notices({ kit: read(manifest), plugin, hooks, source: input.source, locale: resolveLocale(), host });
  for (const line of lines) console.log(line);
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) main();
