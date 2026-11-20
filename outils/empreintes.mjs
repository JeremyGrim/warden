#!/usr/bin/env node
// Écrit le manifeste du kit, kit/scripts/reglement/kit.json : la version du plugin et l'empreinte de chaque fichier.
// À relancer après toute modification du kit, avant de commiter ; la garde kit.test.mjs refuse un manifeste en retard.
//
//   node outils/empreintes.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { empreintesDuDossier, MANIFESTE } from '../kit/scripts/reglement/kit.mjs';

export const DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KIT = join(DEPOT, 'kit');
export const SCRIPTS_DU_KIT = join(KIT, 'scripts', 'reglement');

export function manifesteDuKit() {
  const plugin = JSON.parse(readFileSync(join(DEPOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  return { nom: plugin.name, version: plugin.version, fichiers: empreintesDuDossier(SCRIPTS_DU_KIT) };
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) {
  const manifeste = manifesteDuKit();
  writeFileSync(join(SCRIPTS_DU_KIT, MANIFESTE), `${JSON.stringify(manifeste, null, 2)}\n`);
  console.log(`${MANIFESTE} : ${manifeste.nom} ${manifeste.version}, ${Object.keys(manifeste.fichiers).length} fichiers.`);
}
