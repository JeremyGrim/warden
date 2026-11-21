#!/usr/bin/env node
// Writes the kit manifest, kit/scripts/warden/kit.json: the plugin version and the fingerprint of each file. Run it after
// any change to the kit, before committing; the kit.test.mjs guard refuses a manifest that lags behind.
//
//   node tools/fingerprints.mjs

import { readFileSync, writeFileSync } from 'node:fs';
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

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) {
  const manifest = kitManifest();
  writeFileSync(join(KIT_SCRIPTS, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${MANIFEST}: ${manifest.name} ${manifest.version}, ${Object.keys(manifest.files).length} files.`);
}
