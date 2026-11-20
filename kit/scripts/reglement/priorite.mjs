// La priorité du processeur à la fabrique, tant que son train tourne.
//
// Ce qui compile dans l'arbre du train passe en priorité haute ; ce qui compile dans un autre arbre du projet, en
// priorité basse ; ce qu'on ne sait pas rattacher à un arbre ne bouge pas : on ne pénalise jamais dans le doute.
// Le train fini, chaque processus touché retrouve sa priorité. Rien n'est arrêté ni suspendu.

import { constants, getPriority, setPriority } from 'node:os';

import { dansLArbre, OUTILS_DE_BUILD } from './disque.mjs';

const BINAIRE_DE_BUILD = /[\\/]target[\\/].*[\\/](deps|debug|release|preversion)[\\/][^\\/]+$/i;

// Les arbres du projet : la racine principale et ceux qui portent son nom suivi d'un suffixe (`projet`, `projet-e2`).
export function arbresDuProjet(racinePrincipale) {
  const nom = racinePrincipale.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop();
  return new RegExp(`${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w-]*[\\\\/]`, 'i');
}

// À qui est chaque processus de compilation : 'train', 'autre' ou '' (inconnu). Par sa propre ligne, sinon par ses
// descendants (cargo ne nomme pas son arbre, ses rustc le font), sinon par ses ascendants.
export function classer(processus, racine, autres = arbresDuProjet(racine)) {
  const duTrain = dansLArbre(racine);
  const classe = (texte) => (!texte ? '' : duTrain(texte) ? 'train' : autres.test(texte) ? 'autre' : '');
  const parId = new Map(processus.map((p) => [p.pid, p]));
  const enfants = new Map();
  for (const p of processus) enfants.set(p.parent, [...(enfants.get(p.parent) ?? []), p.pid]);
  const resultat = new Map();
  for (const p of processus) {
    if (!OUTILS_DE_BUILD.test(p.nom) && !BINAIRE_DE_BUILD.test(p.executable ?? '')) continue;
    let k = classe(`${p.ligne} ${p.executable ?? ''}`);
    const file = [...(enfants.get(p.pid) ?? [])];
    for (let n = 0; !k && file.length && n < 300; n += 1) {
      const id = file.shift();
      k = classe(parId.get(id)?.ligne);
      file.push(...(enfants.get(id) ?? []));
    }
    for (let id = p.parent, n = 0; !k && parId.has(id) && n < 12; n += 1) {
      k = classe(parId.get(id).ligne);
      id = parId.get(id).parent;
    }
    resultat.set(p.pid, k);
  }
  return resultat;
}

const VOULUE = { train: constants.priority.PRIORITY_ABOVE_NORMAL, autre: constants.priority.PRIORITY_LOW };

// Un passage : règle la priorité de chaque processus classé, et retient la priorité d'avant pour la rendre.
export function regler(processus, racine, retenues, { lire = getPriority, poser = setPriority, autres } = {}) {
  for (const [pid, k] of classer(processus, racine, autres)) {
    const voulue = VOULUE[k];
    if (voulue === undefined) continue;
    try {
      if (!retenues.has(pid)) retenues.set(pid, lire(pid));
      if (lire(pid) !== voulue) poser(pid, voulue);
    } catch {
      // Un processus fini entre la lecture et le réglage : rien à faire.
    }
  }
}

// Le train fini : chaque processus encore vivant retrouve sa priorité d'avant.
export function rendreLesPriorites(retenues, { poser = setPriority } = {}) {
  for (const [pid, avant] of retenues) {
    try {
      poser(pid, avant);
    } catch {
      // Déjà fini.
    }
  }
  retenues.clear();
}
