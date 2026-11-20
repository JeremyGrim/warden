#!/usr/bin/env node
// Les vérifications du dépôt, sur le poste. Rien ne part en ligne : aucune CI ne vérifie le dépôt à la place du poste.
// Ce qui se vérifie est dans config/fabrique.json, section `verification`.
//
//   node scripts/reglement/verifier.mjs poussee   ce que touche une poussée ; le crochet pre-push le lance
//   node scripts/reglement/verifier.mjs tout      tout le dépôt
//
// Une étape qui échoue arrête la vérification, et le code de sortie le dit.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseDesAvis } from './audit-npm-local.mjs';
import { lancer, lireFabrique, RACINE, reglageDuPoste } from './config.mjs';
import { dossierDuCreneau, prendre, rafraichir, rendre, rendreQuandArrive } from './creneau.mjs';

const ZERO = /^0+$/;
const posix = (chemin) => chemin.replaceAll('\\', '/');
const motifs = (liste) => (liste ?? []).map((m) => new RegExp(m));

// Les paquets de l'espace Rust : leur nom, leur dossier relatif, et les paquets de l'espace dont ils dépendent
// (dépendances normales, de test et de build : un test cassé chez un dépendant compte aussi).
export function paquetsDeLEspace(metadata) {
  const racine = metadata.workspace_root;
  const membres = new Set(metadata.workspace_members);
  const paquets = metadata.packages.filter((p) => membres.has(p.id));
  const noms = new Set(paquets.map((p) => p.name));
  return paquets.map((p) => ({
    nom: p.name,
    dossier: posix(relative(racine, dirname(p.manifest_path))),
    dependances: [...new Set(p.dependencies.filter((d) => d.path && noms.has(d.name)).map((d) => d.name))],
  }));
}

// Le paquet d'un fichier : celui dont le dossier est le plus long préfixe du chemin. Un paquet à la racine (dossier
// vide) prend tout ce qu'aucun autre ne prend.
function paquetDe(fichier, paquets) {
  let trouve = null;
  for (const p of paquets) {
    const dedans = p.dossier === '' || fichier === p.dossier || fichier.startsWith(`${p.dossier}/`);
    if (dedans && (!trouve || p.dossier.length > trouve.dossier.length)) trouve = p;
  }
  return trouve;
}

// Les paquets qui dépendent, même de loin, de ceux qu'on donne ; ceux qu'on donne compris.
export function avecLeursDependants(noms, paquets) {
  const atteints = new Set(noms);
  let ajoute = true;
  while (ajoute) {
    ajoute = false;
    for (const p of paquets) {
      if (!atteints.has(p.nom) && p.dependances.some((d) => atteints.has(d))) {
        atteints.add(p.nom);
        ajoute = true;
      }
    }
  }
  return [...atteints].sort();
}

// Ce qu'une poussée demande, d'après les fichiers qu'elle change et la section `verification`.
export function planDePoussee(fichiers, paquets, verification) {
  const chemins = fichiers.map(posix);
  const touche = (liste) => chemins.some((f) => motifs(liste).some((m) => m.test(f)));
  const conf = verification.rust;
  let rust = { tout: false, clippy: [], tests: [] };
  if (conf && paquets) {
    const touches = [...new Set(chemins.map((f) => paquetDe(f, paquets)?.nom).filter(Boolean))].sort();
    rust = touche(conf.entier) ? { tout: true, clippy: [], tests: [] } : { tout: false, clippy: avecLeursDependants(touches, paquets), tests: touches };
    if (!rust.tout && paquets.length && rust.clippy.length === paquets.length) rust = { tout: true, clippy: [], tests: [] };
  }
  return {
    rust,
    // Une dépendance ajoutée ou montée passe le contrôle des dépendances : avis de sécurité, licences, sources.
    dependances: Boolean(conf?.deny) && chemins.some((f) => /(^|\/)Cargo\.(toml|lock)$/.test(f) || f === conf.deny),
    // Un verrou npm changé passe les avis npm, comparés sur le poste.
    avisNpm: Boolean(verification.avis_npm) && chemins.includes(verification.avis_npm.verrou),
    etapes: (verification.etapes ?? []).filter((e) => touche(e.si)),
  };
}

// Les commits qu'une poussée envoie, d'après ce que Git donne au crochet sur l'entrée standard.
export function envois(entree) {
  return entree.split(/\r?\n/).map((ligne) => ligne.trim().split(/\s+/)).filter((mots) => mots.length === 4)
    .map(([refLocale, local, refDistante, distant]) => ({ refLocale, local, refDistante, distant }))
    .filter((envoi) => !ZERO.test(envoi.local));
}

function git(args) {
  const sortie = spawnSync('git', args, { windowsHide: true, cwd: RACINE, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (sortie.status !== 0) throw new Error(`git ${args.join(' ')} : ${sortie.stderr.trim()}`);
  return sortie.stdout.trim();
}

const existe = (commit) => spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { windowsHide: true, cwd: RACINE }).status === 0;

// Les tests qu'une sortie de `cargo test` dit en échec.
export function testsEnEchec(sortie) {
  return [...new Set([...sortie.matchAll(/^test (\S+) \.\.\. FAILED\r?$/gm)].map((m) => m[1]))];
}

// Une étape : `{ titre, commande, inchanges }`. `inchanges` : des chemins que la commande ne doit pas changer (des
// fichiers générés, qu'on ne retouche pas à la main).
function etape({ titre, commande, inchanges = [] }) {
  console.log(`\n▶ ${titre}`);
  const debut = Date.now();
  const tests = commande[0] === 'cargo' && commande[1] === 'test';
  // Les tests se lisent après coup pour savoir lesquels ont échoué ; le reste s'affiche en direct.
  const sortie = lancer(commande, { cwd: RACINE, stdio: tests ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', maxBuffer: 1 << 30 });
  if (tests) process.stdout.write(sortie.stdout ?? '');
  const duree = () => `${Math.round((Date.now() - debut) / 1000)} s`;
  if (sortie.status === 0) {
    const changes = inchanges.length ? git(['status', '--porcelain', '--', ...inchanges]) : '';
    if (changes) {
      console.error(`✖ ${titre} : la commande change ce qui doit rester tel quel (fichiers générés retouchés à la main, ou génération non relancée) :\n${changes}`);
      spawnSync('git', ['checkout', '--', ...inchanges], { windowsHide: true, cwd: RACINE });
      return false;
    }
    console.log(`✔ ${titre} (${duree()})`);
    return true;
  }
  // Un test à délai tombe sur un poste saturé : chaque test en échec se rejoue une fois, seul avec les autres en échec.
  // Il ne compte comme passé que s'il passe ; le rapport le nomme.
  const echecs = tests ? testsEnEchec(sortie.stdout ?? '') : [];
  if (echecs.length && echecs.length <= 20) {
    console.log(`\n↻ ${echecs.length} test(s) en échec, rejoués une fois : ${echecs.join(', ')}`);
    const filtre = commande.filter((a) => a !== '--no-fail-fast');
    const separateur = filtre.indexOf('--');
    const avant = separateur < 0 ? filtre : filtre.slice(0, separateur);
    const apres = separateur < 0 ? [] : filtre.slice(separateur + 1);
    const second = lancer([...avant, '--no-fail-fast', '--', ...apres, '--exact', ...echecs], { cwd: RACINE, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28 });
    const encore = testsEnEchec(second.stdout ?? '');
    if (second.status === 0 && !encore.length) {
      console.log(`✔ ${titre} (${duree()}) — passés au second essai, à surveiller : ${echecs.join(', ')}`);
      return true;
    }
    process.stdout.write(second.stdout ?? '');
    console.error(`✖ ${titre} : échec (${duree()}), aussi au second essai : ${(encore.length ? encore : echecs).join(', ')}.`);
    return false;
  }
  console.error(`✖ ${titre} : échec (${duree()}).`);
  return false;
}

const cargoP = (noms) => noms.flatMap((nom) => ['-p', nom]);

// Avis de sécurité (base RustSec publique, comparée au verrou sur le poste), licences, sources.
const dependances = (conf) => ({ titre: 'Dépendances : avis, licences, sources', commande: ['cargo', 'deny', '--config', conf.deny, 'check'] });

// Les avis npm du verrou, comparés sur le poste à un clone de la base GitHub Advisory Database : rien ne part en ligne.
// Sans clone sur le poste, l'étape se dit sautée.
function avisNpm(conf) {
  if (!baseDesAvis()) {
    console.log('Avis npm : sautés, aucun clone de la base des avis sur ce poste (REGLEMENT_GHSA_DATABASE ou git config reglement.ghsa ; audit-npm-local.mjs dit comment le tenir).');
    return [];
  }
  return [{ titre: 'Avis npm, sur le poste', commande: ['node', 'scripts/reglement/audit-npm-local.mjs', '--verrou', conf.verrou] }];
}

// Les paquets testés à part (`a_part`) : une coque qui ne se teste qu'avec ses propres arguments.
function etapesRust(rust, conf) {
  const aPart = conf.a_part ?? [];
  const etapes = [];
  if (conf.clippy !== false) {
    etapes.push({ titre: 'Clippy, sans avertissement', commande: ['cargo', 'clippy', ...(rust.tout ? ['--workspace'] : cargoP(rust.clippy)), '--all-targets', '--locked', '--', '-D', 'warnings'] });
  }
  if (conf.tests === false) return etapes;
  if (rust.tout) {
    etapes.push({ titre: 'Tests de l’espace', commande: ['cargo', 'test', '--workspace', ...aPart.flatMap((a) => ['--exclude', a.paquet]), '--locked', '--no-fail-fast'] });
    for (const a of aPart) etapes.push({ titre: `Tests de ${a.paquet}`, commande: ['cargo', 'test', '-p', a.paquet, ...(a.tests ?? []), '--locked'] });
    return etapes;
  }
  const seuls = rust.tests.filter((nom) => !aPart.some((a) => a.paquet === nom));
  if (seuls.length) etapes.push({ titre: `Tests de ${seuls.join(', ')}`, commande: ['cargo', 'test', ...cargoP(seuls), '--locked', '--no-fail-fast'] });
  for (const a of aPart.filter((x) => rust.tests.includes(x.paquet))) {
    etapes.push({ titre: `Tests de ${a.paquet}`, commande: ['cargo', 'test', '-p', a.paquet, ...(a.tests ?? []), '--locked'] });
  }
  return etapes;
}

function jouer(etapes) {
  for (const e of etapes) if (!etape(e)) return false;
  return true;
}

function metadata() {
  const sortie = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], { windowsHide: true, cwd: RACINE, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (sortie.status !== 0) throw new Error(`cargo metadata : ${sortie.stderr.trim()}`);
  return JSON.parse(sortie.stdout);
}

// Ce qui est vérifié, c'est l'arbre de travail : il doit être le commit poussé, sans modification suivie.
function arbreEgalAuCommit(local) {
  const tete = git(['rev-parse', 'HEAD']);
  if (tete !== local) return `le commit poussé (${local.slice(0, 7)}) n'est pas celui de l'arbre (${tete.slice(0, 7)}) : se placer dessus, puis pousser`;
  if (git(['status', '--porcelain', '--untracked-files=no'])) return 'des fichiers suivis sont modifiés sans être commités : les commiter ou les mettre de côté';
  return null;
}

const dormir = (ms) => new Promise((fin) => setTimeout(fin, ms));

export function creneauDuPoste(fabrique = lireFabrique()) {
  const commun = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true, cwd: RACINE, encoding: 'utf8' }).stdout?.trim() || null;
  return dossierDuCreneau({ configure: reglageDuPoste('creneau'), dossierGitCommun: commun, nom: fabrique.creneau.nom });
}

export const registreDuCreneau = (dossier, fabrique = lireFabrique()) => (fabrique.creneau.registre ? join(dirname(dossier), fabrique.creneau.registre) : null);

// Tant que ce processus vit, un processus à part rafraîchit l'heure du créneau toutes les 5 minutes : la vérification
// bloque celui-ci, et un créneau qui dépasse 50 minutes aurait l'air abandonné.
export function garderLeCreneau(dossier) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'entretenir-creneau', dossier, String(process.pid)], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const vivant = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erreur) {
    return erreur.code === 'EPERM';
  }
};

// Le crochet finit avant que Git n'envoie : un processus détaché rend le créneau quand la branche principale porte le commit.
function rendreApresLaPoussee(dossier, commit) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'rendre-creneau', dossier, commit], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function commandePoussee(entree) {
  const fabrique = lireFabrique();
  const { principale, distant } = fabrique;
  const liste = envois(entree);
  if (!liste.length) return true;
  for (const envoi of liste) {
    const refus = arbreEgalAuCommit(envoi.local);
    if (refus) {
      console.error(`Vérification refusée : ${refus}.`);
      return false;
    }
  }
  // Une seule poussée vers la branche principale à la fois sur le poste : le créneau se prend avant toute vérification.
  const versPrincipale = liste.find((envoi) => envoi.refDistante === `refs/heads/${principale}`);
  const dossier = versPrincipale ? creneauDuPoste(fabrique) : null;
  if (versPrincipale && !dossier) {
    console.warn(`Aucun créneau de poussée pour ce clone : créer .travail/ à la racine, ou git config reglement.creneau "<dossier>". Poussée sans créneau.`);
  }
  if (dossier) {
    const prise = await prendre({ dossier, arbre: RACINE, commit: versPrincipale.local, dormir, dire: (texte) => console.log(texte), registre: registreDuCreneau(dossier, fabrique) });
    if (!prise.pris) {
      console.error(`Poussée refusée : ${prise.raison}.`);
      return false;
    }
    console.log(prise.repris ? `Créneau de poussée repris (${prise.repris}).` : 'Créneau de poussée pris.');
    garderLeCreneau(dossier);
  }
  let reussi = false;
  try {
    if (versPrincipale) {
      const recu = spawnSync('git', ['fetch', '--quiet', distant, principale], { windowsHide: true, cwd: RACINE, encoding: 'utf8' });
      // Une première poussée vers un distant vide n'a rien à recevoir ; tout autre échec arrête.
      if (recu.status !== 0 && git(['ls-remote', '--heads', distant, principale])) throw new Error(`git fetch ${distant} ${principale} : ${recu.stderr.trim()}`);
      const suivi = `${distant}/${principale}`;
      if (existe(suivi) && spawnSync('git', ['merge-base', '--is-ancestor', suivi, versPrincipale.local], { windowsHide: true, cwd: RACINE }).status !== 0) {
        console.error(`${principale} a bougé depuis ton rebase : rebase sur ${suivi}, puis pousse de nouveau. Rien n’a été vérifié pour rien.`);
        return false;
      }
    }
    // Le train vient de vérifier ce commit exact, dans cet arbre, sous ce créneau : on ne le revérifie pas.
    if (versPrincipale && liste.length === 1 && dejaVerifie(versPrincipale.local)) {
      console.log(`Déjà vérifié par le train : ${versPrincipale.local.slice(0, 7)}.`);
      reussi = true;
    } else {
      reussi = verifierLaPoussee(liste, fabrique);
    }
    return reussi;
  } finally {
    if (dossier && reussi) rendreApresLaPoussee(dossier, versPrincipale.local);
    else if (dossier) rendre(dossier, RACINE);
  }
}

// Le témoin du train : le commit qu'il a vérifié, dans le dossier Git de cet arbre (rien n'en est versionné).
const temoinDuTrain = () => git(['rev-parse', '--git-path', 'reglement-train-verifie']);
export function marquerVerifie(commit) {
  writeFileSync(resolve(RACINE, temoinDuTrain()), `${commit}\n`);
}
function dejaVerifie(commit) {
  try {
    return readFileSync(resolve(RACINE, temoinDuTrain()), 'utf8').trim() === commit;
  } catch {
    return false;
  }
}

function verifierLaPoussee(liste, fabrique) {
  const suivi = `${fabrique.distant}/${fabrique.principale}`;
  let fichiers = [];
  for (const envoi of liste) {
    let base = !ZERO.test(envoi.distant) && existe(envoi.distant) ? envoi.distant : null;
    if (!base && existe(suivi)) base = git(['merge-base', envoi.local, suivi]);
    // Une première poussée, sans rien en face : tout ce que porte le commit.
    const changes = base ? git(['diff', '--name-only', base, envoi.local]) : git(['ls-tree', '-r', '--name-only', envoi.local]);
    fichiers = fichiers.concat(changes.split('\n').filter(Boolean));
  }
  return verifierFichiers(fichiers, fabrique);
}

const avecRust = (verification) => Boolean(verification.rust) && spawnSync('git', ['ls-files', '--error-unmatch', 'Cargo.toml'], { windowsHide: true, cwd: RACINE }).status === 0;

// Ce qu'une liste de fichiers changés demande, joué sur l'arbre de travail tel qu'il est.
export function verifierFichiers(fichiers, fabrique = lireFabrique()) {
  const { verification } = fabrique;
  const plan = planDePoussee(fichiers, avecRust(verification) ? paquetsDeLEspace(metadata()) : null, verification);
  const etapes = [];
  if (plan.dependances) etapes.push(dependances(verification.rust));
  if (plan.avisNpm) etapes.push(...avisNpm(verification.avis_npm));
  etapes.push(...plan.etapes);
  if (plan.rust.tout || plan.rust.clippy.length) etapes.push(...etapesRust(plan.rust, verification.rust));
  if (!etapes.length) {
    console.log('Rien à vérifier de plus dans cette poussée : le règlement et les gardes des scripts suffisent.');
    return true;
  }
  const portee = plan.rust.tout ? 'tout l’espace Rust' : plan.rust.clippy.length ? `${plan.rust.clippy.length} paquet(s) Rust` : 'aucun paquet Rust';
  console.log(`Poussée : ${fichiers.length} fichier(s) changé(s), ${portee}, ${plan.etapes.length} étape(s) du projet.`);
  return jouer(etapes);
}

function commandeTout() {
  const { verification } = lireFabrique();
  const etapes = [
    { titre: 'Règlement', commande: ['node', 'scripts/reglement/reglement.mjs'] },
    { titre: 'Gardes des scripts', commande: ['node', '--test', 'scripts/**/*.test.mjs'] },
  ];
  const rust = avecRust(verification);
  if (rust && verification.rust.deny) etapes.push(dependances(verification.rust));
  if (verification.avis_npm) etapes.push(...avisNpm(verification.avis_npm));
  etapes.push(...(verification.etapes ?? []));
  if (rust) etapes.push(...etapesRust({ tout: true }, verification.rust));
  etapes.push(...(verification.tout ?? []));
  return jouer(etapes);
}

async function principal(argv) {
  const [commande, ...reste] = argv;
  if (commande === 'poussee') return commandePoussee(readFileSync(0, 'utf8'));
  if (commande === 'entretenir-creneau') {
    // Il relève souvent si la vérification vit encore, pour finir avec elle ; il ne rafraîchit l'heure que toutes les
    // 5 minutes.
    const [dossier, pid] = reste;
    let dernier = Date.now();
    while (vivant(Number(pid))) {
      if (Date.now() - dernier >= 5 * 60 * 1000) {
        if (!rafraichir(dossier, RACINE)) break;
        dernier = Date.now();
      }
      await dormir(5 * 1000);
    }
    return true;
  }
  if (commande === 'rendre-creneau') {
    const [dossier, commit] = reste;
    const { distant, principale } = lireFabrique();
    const teteDistante = () => spawnSync('git', ['ls-remote', distant, `refs/heads/${principale}`], { windowsHide: true, cwd: RACINE, encoding: 'utf8' }).stdout?.split(/\s/)[0];
    await rendreQuandArrive({ dossier, arbre: RACINE, commit, teteDistante, dormir });
    return true;
  }
  if (commande === 'tout') return commandeTout();
  console.error('Commande : poussee ou tout.');
  return false;
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) {
  try {
    process.exitCode = (await principal(process.argv.slice(2))) ? 0 : 1;
  } catch (erreur) {
    console.error(`Vérification arrêtée : ${erreur.message}`);
    process.exitCode = 1;
  }
}
