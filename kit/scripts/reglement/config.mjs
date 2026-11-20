// Ce que le kit lit du projet. Rien de ce qui décrit le projet n'est écrit dans un script : les règles sont dans
// config/reglement.json, la fabrique dans config/fabrique.json, les plafonds du disque dans config/disque.json. Une
// section absente ne se joue pas. Ce qui est propre au poste (un chemin, un outil) se règle par `git config
// reglement.<clé>` et ne se versionne jamais.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Le kit vit dans scripts/reglement/ du projet : la racine est deux dossiers au-dessus.
export const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FABRIQUE_PAR_DEFAUT = {
  principale: 'main',
  distant: 'origin',
  creneau: { nom: 'creneau-poussee-main', registre: null },
  verification: { rust: null, avis_npm: null, etapes: [], tout: [] },
  train: { branche: 'train-vers-main', lot_max: 4, installer: null, fabriquer: null },
};

export function lireJson(chemin, defaut = null) {
  if (!existsSync(chemin)) return defaut;
  try {
    return JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (erreur) {
    throw new Error(`${chemin} : JSON illisible (${erreur.message})`);
  }
}

// La fabrique du projet : ses sections complètent celles par défaut, clé par clé.
export function lireFabrique(racine = RACINE) {
  const donne = lireJson(join(racine, 'config', 'fabrique.json'), {});
  const D = FABRIQUE_PAR_DEFAUT;
  return {
    ...D,
    ...donne,
    creneau: { ...D.creneau, ...donne.creneau },
    verification: { ...D.verification, ...donne.verification },
    train: { ...D.train, ...donne.train },
  };
}

// Un réglage du poste, jamais versionné : `git config reglement.<clé>`.
export function reglageDuPoste(cle, racine = RACINE) {
  const sortie = spawnSync('git', ['config', '--get', `reglement.${cle}`], { cwd: racine, encoding: 'utf8', windowsHide: true });
  return sortie.status === 0 ? sortie.stdout.trim() || null : null;
}

// Une commande du projet telle que la configuration la donne : un tableau, le programme d'abord. `node` est le Node qui
// tourne. Sous Windows, pnpm, npm ou npx sont des scripts .cmd : ils passent par le shell, leurs arguments cités.
export function commandeDuPoste(commande) {
  const [programme, ...args] = commande;
  if (programme === 'node') return { programme: process.execPath, args, shell: false };
  if (process.platform !== 'win32' || /^(git|cargo|rustc)(\.exe)?$/i.test(programme)) return { programme, args, shell: false };
  const citer = (mot) => (/^[\w@%+=:,./\\-]+$/.test(mot) ? mot : `"${mot.replaceAll('"', '\\"')}"`);
  return { programme: [programme, ...args].map(citer).join(' '), args: [], shell: true };
}

// Une étape lancée depuis un lanceur de tests n'hérite pas de son contexte : un `node --test` qui le reçoit saute tous
// ses fichiers et se dit réussi.
export function lancer(commande, options = {}) {
  const { programme, args, shell } = commandeDuPoste(commande);
  const { NODE_TEST_CONTEXT, ...env } = options.env ?? process.env;
  void NODE_TEST_CONTEXT;
  return spawnSync(programme, args, { windowsHide: true, shell, ...options, env });
}
