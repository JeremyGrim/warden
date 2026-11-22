#!/usr/bin/env node
// Writes the kit manifest, kit/scripts/warden/kit.json: the plugin version and the fingerprint of each file. Run it after
// any change to the kit, before committing; the kit.test.mjs guard refuses a manifest that lags behind.
// It also writes the Codex manifest, .codex-plugin/plugin.json, from the Claude Code one, which stays the only source of
// the version; the codex.test.mjs guard refuses a Codex manifest that lags behind.
//
//   node tools/fingerprints.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { folderFingerprints, MANIFEST } from '../kit/scripts/warden/kit.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KIT = join(REPO, 'kit');
export const KIT_SCRIPTS = join(KIT, 'scripts', 'warden');

export function kitManifest() {
  const plugin = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  return { name: plugin.name, version: plugin.version, files: folderFingerprints(KIT_SCRIPTS) };
}

export const CODEX_MANIFEST = join(REPO, '.codex-plugin', 'plugin.json');

// Codex reads .codex-plugin/plugin.json before .claude-plugin/plugin.json. Its own manifest gives it the same skills and
// a session hook it can run: Codex keeps only `command` from hooks/hooks.json and drops its `args`, so it would start a
// bare `node`. Codex replaces ${PLUGIN_ROOT} in a hook command, and launches `commandWindows` through PowerShell.
export function codexManifest() {
  const plugin = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  const same = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'];
  return {
    ...Object.fromEntries(same.filter((key) => key in plugin).map((key) => [key, plugin[key]])),
    skills: './skills/',
    hooks: './hooks/codex-hooks.json',
    interface: {
      displayName: plugin.displayName ?? 'Warden',
      shortDescription: 'Repository rules, by Git',
      longDescription: plugin.description,
      developerName: plugin.author?.name ?? 'ARKA LABS',
      category: 'Developer Tools',
      capabilities: ['Skills', 'Lifecycle hooks'],
    },
  };
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  const manifest = kitManifest();
  writeFileSync(join(KIT_SCRIPTS, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${MANIFEST}: ${manifest.name} ${manifest.version}, ${Object.keys(manifest.files).length} files.`);
  const codex = codexManifest();
  mkdirSync(dirname(CODEX_MANIFEST), { recursive: true });
  writeFileSync(CODEX_MANIFEST, `${JSON.stringify(codex, null, 2)}\n`);
  console.log(`.codex-plugin/plugin.json: ${codex.name} ${codex.version}.`);
}
