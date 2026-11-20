#!/usr/bin/env node
// Le seul crochet du plugin, à l'ouverture d'une session. Il ne contrôle rien : il dit seulement, en une ligne, ce qui
// empêche le règlement du projet de jouer (crochets Git inactifs) ou ce qui le met en retard (un kit plus ancien que le
// plugin). Quand tout va, il ne dit rien : aucun coût de contexte. Il ne lit ni la conversation ni les outils.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function lireEntree() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// -1, 0 ou 1 entre deux versions « a.b.c ».
export function comparer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

export function avis({ kit, plugin, crochets }) {
  if (!kit) return [];
  const lignes = [];
  if (crochets !== '.githooks') {
    lignes.push('Règlement du dépôt : les crochets Git sont inactifs dans ce clone, rien n’est contrôlé au commit ni au push. Les activer : git config core.hooksPath .githooks');
  }
  if (plugin && comparer(kit.version, plugin.version) < 0) {
    lignes.push(`Règlement du dépôt : le kit du projet est en ${kit.version}, le plugin en ${plugin.version}. Le skill reglement-poser le met à jour.`);
  }
  return lignes;
}

function principal() {
  const entree = lireEntree();
  const ici = entree.cwd || process.cwd();
  const haut = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ici, encoding: 'utf8', windowsHide: true });
  if (haut.status !== 0) return;
  const racine = haut.stdout.trim();
  const manifeste = join(racine, 'scripts', 'reglement', 'kit.json');
  if (!existsSync(manifeste)) return;
  const lire = (chemin) => {
    try {
      return JSON.parse(readFileSync(chemin, 'utf8'));
    } catch {
      return null;
    }
  };
  const crochets = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: racine, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  for (const ligne of avis({ kit: lire(manifeste), plugin: lire(join(PLUGIN, '.claude-plugin', 'plugin.json')), crochets })) console.log(ligne);
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) principal();
