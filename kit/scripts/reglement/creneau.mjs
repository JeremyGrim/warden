// Le créneau de poussée sur main : une seule poussée à la fois sur le poste, prise par le crochet lui-même.
// Le verrou est un dossier (`mkdir` échoue s'il existe), partagé par tous les arbres du poste ; `tenu-par.txt` dit
// quel arbre le tient, pour quel commit, depuis quand. Son nom et son registre viennent de config/fabrique.json.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ABANDON_MS = 50 * 60 * 1000;
// Un essai de `mkdir` ne coûte rien : un crochet qui attend relève souvent, sans quoi une prise à la main passe
// toujours devant lui (vu le 11 nov., deux fois de suite à 30 s).
export const PAS_MS = 5 * 1000;

// Où vit le créneau : réglé pour ce clone (`git config reglement.creneau <dossier>`), sinon dans le `.travail` de la
// racine dont cet arbre dépend (la racine elle-même, ou un arbre lié à elle). Un clone à part sans réglage n'en a pas.
export function dossierDuCreneau({ configure, dossierGitCommun, nom = 'creneau-poussee-main' }) {
  if (configure) return configure;
  if (!dossierGitCommun) return null;
  const travail = join(dirname(dossierGitCommun), '.travail');
  return existsSync(travail) ? join(travail, nom) : null;
}

function lire(dossier) {
  try {
    return readFileSync(join(dossier, 'tenu-par.txt'), 'utf8');
  } catch {
    return '';
  }
}

function depuis(dossier) {
  const ecrit = /^depuis: (.+)$/m.exec(lire(dossier))?.[1];
  const date = ecrit ? Date.parse(ecrit) : NaN;
  if (!Number.isNaN(date)) return date;
  try {
    return statSync(dossier).mtimeMs;
  } catch {
    return 0;
  }
}

const tenuParCetArbre = (dossier, arbre) => lire(dossier).split(/\r?\n/).includes(`arbre: ${arbre}`);

function ecrire(dossier, { arbre, commit, maintenant }) {
  writeFileSync(join(dossier, 'tenu-par.txt'), `crochet de poussée\narbre: ${arbre}\ncommit: ${commit}\ndepuis: ${new Date(maintenant).toISOString()}\n`);
}

// Prend le créneau, en attendant qu'il se libère. Un créneau de cet arbre se reprend (un crochet interrompu) ; un
// créneau tenu depuis plus de 50 minutes est abandonné, se reprend, et la reprise s'écrit au registre s'il y en a un
// (`creneau.registre`, un fichier voisin du créneau).
export async function prendre({ dossier, arbre, commit, maintenant = () => Date.now(), dormir, attenteMax = ABANDON_MS, pas = PAS_MS, dire = () => {}, registre = null }) {
  const debut = maintenant();
  let annonce = false;
  for (;;) {
    try {
      mkdirSync(dossier);
      ecrire(dossier, { arbre, commit, maintenant: maintenant() });
      return { pris: true };
    } catch (erreur) {
      if (erreur.code !== 'EEXIST') return { pris: false, raison: `créneau impossible à prendre (${erreur.code})` };
    }
    const tenu = lire(dossier).trim().replace(/\s*\n\s*/g, ' ; ') || '(sans tenu-par.txt)';
    if (tenuParCetArbre(dossier, arbre)) {
      ecrire(dossier, { arbre, commit, maintenant: maintenant() });
      return { pris: true, repris: tenu };
    }
    if (maintenant() - depuis(dossier) > ABANDON_MS) {
      if (registre && existsSync(registre)) appendFileSync(registre, `\n- ${new Date(maintenant()).toISOString()} — créneau de poussée abandonné, repris par le crochet de ${arbre} : ${tenu}\n`);
      ecrire(dossier, { arbre, commit, maintenant: maintenant() });
      return { pris: true, repris: tenu };
    }
    if (maintenant() - debut >= attenteMax) return { pris: false, raison: `créneau tenu : ${tenu}` };
    if (!annonce) {
      dire(`Créneau de poussée tenu : ${tenu}. Le crochet attend qu'il se libère (vérifié toutes les ${Math.round(pas / 1000)} s). Si c'est toi qui le tiens à la main, rends-le : le crochet le prend lui-même.`);
      annonce = true;
    }
    await dormir(pas);
  }
}

// Le tenant rafraîchit son heure pendant une longue vérification : sans quoi, passé 50 minutes, un autre crochet le
// croirait abandonné et le reprendrait en plein travail.
export function rafraichir(dossier, arbre, maintenant = Date.now()) {
  if (!tenuParCetArbre(dossier, arbre)) return false;
  writeFileSync(join(dossier, 'tenu-par.txt'), lire(dossier).replace(/^depuis: .*$/m, `depuis: ${new Date(maintenant).toISOString()}`));
  return true;
}

// Rend le créneau, seulement s'il est à cet arbre.
export function rendre(dossier, arbre) {
  if (existsSync(dossier) && tenuParCetArbre(dossier, arbre)) rmSync(dossier, { recursive: true, force: true });
}

// Le crochet finit avant que Git n'envoie : le créneau se rend quand main porte le commit poussé, ou au bout du délai
// si la poussée a échoué après le crochet.
export async function rendreQuandArrive({ dossier, arbre, commit, teteDistante, dormir, maintenant = () => Date.now(), delai = 180 * 1000, pas = 2 * 1000 }) {
  const debut = maintenant();
  while (maintenant() - debut < delai) {
    if (teteDistante() === commit) break;
    await dormir(pas);
  }
  rendre(dossier, arbre);
}
