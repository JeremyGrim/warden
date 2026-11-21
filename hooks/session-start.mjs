#!/usr/bin/env node
// The plugin's only hook, at session start. It checks nothing: it only says, in one line, what keeps the project rules
// from running (inactive Git hooks) or what makes them lag (a kit older than the plugin). When all is well it says
// nothing: no context cost. It reads neither the conversation nor the tools.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocale } from '../kit/scripts/warden/messages.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MESSAGES = {
  en: {
    hooks: 'Warden: the Git hooks are inactive in this clone, nothing is checked at commit or push. Turn them on: git config core.hooksPath .githooks',
    behind: 'Warden: the project kit is {kit}, the plugin {plugin}. The /warden:setup skill updates it.',
    onboard: 'Warden rules this repository: run /warden:onboard before working.',
  },
  fr: {
    hooks: 'Warden : les crochets Git sont inactifs dans ce clone, rien n’est contrôlé au commit ni au push. Les activer : git config core.hooksPath .githooks',
    behind: 'Warden : le kit du projet est en {kit}, le plugin en {plugin}. La skill /warden:setup le met à jour.',
    onboard: 'Warden règle ce dépôt : lancer /warden:onboard avant de travailler.',
  },
};

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

export function notices({ kit, plugin, hooks, source, locale = 'en' }) {
  if (!kit) return [];
  const m = MESSAGES[locale] ?? MESSAGES.en;
  const lines = [];
  if (hooks !== '.githooks') lines.push(m.hooks);
  if (plugin && compare(kit.version, plugin.version) < 0) lines.push(m.behind.replace('{kit}', kit.version).replace('{plugin}', plugin.version));
  // A new session (not a resume or a compaction) is reminded of the onboarding once.
  if (source === 'startup') lines.push(m.onboard);
  return lines;
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
  const lines = notices({ kit: read(manifest), plugin: read(join(PLUGIN, '.claude-plugin', 'plugin.json')), hooks, source: input.source, locale: resolveLocale() });
  for (const line of lines) console.log(line);
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) main();
