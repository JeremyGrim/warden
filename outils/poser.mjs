#!/usr/bin/env node
// Pose le kit dans un projet, ou le met à jour.
//
//   node outils/poser.mjs [<projet>] [--simuler]
//
// Les scripts du kit (scripts/reglement/) se copient tels quels, avec leur manifeste d'empreintes. Un script retouché
// dans le projet, ou un fichier inconnu du kit dans ce dossier, arrête la pose sans rien écrire : l'écart devient une
// option de configuration ou un correctif du kit. Les modèles (AGENTS.md, CLAUDE.md, .githooks/, config/) ne se posent
// que s'ils manquent, adaptés à ce que contient le projet ; un modèle déjà là est gardé tel quel.

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { empreintesDuDossier, MANIFESTE } from '../kit/scripts/reglement/kit.mjs';
import { KIT, manifesteDuKit, SCRIPTS_DU_KIT } from './empreintes.mjs';

const VERROUS = { 'pnpm-lock.yaml': 'pnpm', 'package-lock.json': 'npm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
// Ce qui déclenche les étapes du projet : tout, sauf le kit, la configuration, les documents et les .md de la racine.
const HORS_DU_KIT = '^(?!(scripts/reglement|\\.githooks|config|docs)/|[^/]+\\.md$)';
const RUST_ENTIER = ['^Cargo\\.(toml|lock)$', '^rust-toolchain(\\.toml)?$', '^\\.cargo/'];

function git(racine, args) {
  const sortie = spawnSync('git', args, { cwd: racine, encoding: 'utf8', windowsHide: true });
  return { ok: sortie.status === 0, sortie: (sortie.stdout ?? '').trim() };
}

const union = (a, b) => [...new Set([...a, ...b])];
const lireTexte = (chemin) => (existsSync(chemin) ? readFileSync(chemin, 'utf8') : null);

// Ce qu'il y a à la racine du projet : suivi, ou non suivi et non ignoré.
export function contenuDeLaRacine(racine) {
  const liste = git(racine, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).sortie.split('\0').filter(Boolean);
  const dossiers = new Set();
  const fichiers = new Set();
  for (const chemin of liste) {
    const [premier, ...reste] = chemin.split('/');
    (reste.length ? dossiers : fichiers).add(premier);
  }
  return { dossiers: [...dossiers].sort(), fichiers: [...fichiers].sort() };
}

// Les scripts déjà posés : ce qui a été retouché (une empreinte qu'aucune version ne connaît), ce qui est inconnu du
// kit, et ce qu'une version précédente posait et que celle-ci ne pose plus.
export function jugerLesScripts(dossier, nouveau) {
  if (!existsSync(dossier)) return { retouches: [], inconnus: [], aRetirer: [], ancienne: null };
  const lu = lireTexte(join(dossier, MANIFESTE));
  const ancien = lu ? JSON.parse(lu) : { fichiers: {} };
  const retouches = [];
  const inconnus = [];
  const aRetirer = [];
  for (const [nom, valeur] of Object.entries(empreintesDuDossier(dossier))) {
    const connu = nom in ancien.fichiers || nom in nouveau.fichiers;
    if (!connu) inconnus.push(nom);
    else if (ancien.fichiers[nom] !== valeur && nouveau.fichiers[nom] !== valeur) retouches.push(nom);
    else if (!(nom in nouveau.fichiers)) aRetirer.push(nom);
  }
  return { retouches, inconnus, aRetirer, ancienne: ancien.version ?? null };
}

// La version qu'un manifeste du projet déclare, et comment la lire (voir la section `versions` du règlement).
function lecturesDeVersion(racine) {
  const lectures = [];
  const paquet = lireTexte(join(racine, 'package.json'));
  if (paquet && JSON.parse(paquet).version) lectures.push({ fichier: 'package.json', lire: 'json:version' });
  const cargo = lireTexte(join(racine, 'Cargo.toml'));
  if (cargo && /^\[workspace\.package\][^[]*^version\s*=/ms.test(cargo)) lectures.push({ fichier: 'Cargo.toml', lire: 'toml:workspace.package.version' });
  else if (cargo && /^\[package\][^[]*^version\s*=\s*"/ms.test(cargo)) lectures.push({ fichier: 'Cargo.toml', lire: 'toml:package.version' });
  return lectures;
}

// Le règlement du modèle, ouvert à ce que le projet contient déjà. Ce qui est admis parce que présent est rendu à part :
// la personne le relit.
export function adapterReglement(modele, racine, contenu) {
  const regles = structuredClone(modele);
  const interdits = new Set(regles.segments_interdits);
  const verrous = contenu.fichiers.filter((f) => f in VERROUS);
  // Le verrou présent dit le gestionnaire du projet : il n'est plus interdit, et il échappe aux plafonds comme les autres.
  if (verrous.length === 1) {
    regles.gestionnaires_interdits = regles.gestionnaires_interdits.filter((f) => VERROUS[f] !== VERROUS[verrous[0]]);
    regles.lignes_exemptes = union(regles.lignes_exemptes, verrous);
    regles.taille_exceptions[verrous[0]] ??= 2048;
  }
  if (contenu.fichiers.includes('Cargo.lock')) {
    regles.lignes_exemptes = union(regles.lignes_exemptes, ['Cargo.lock']);
    regles.taille_exceptions['Cargo.lock'] ??= 2048;
  }
  const dossiers = contenu.dossiers.filter((d) => !interdits.has(d) && !regles.racine.dossiers.includes(d));
  const fichiers = contenu.fichiers.filter((f) => !regles.racine.fichiers.includes(f) && !regles.gestionnaires_interdits.includes(f));
  regles.racine.dossiers = union(regles.racine.dossiers, dossiers);
  regles.racine.fichiers = union(regles.racine.fichiers, fichiers);
  if (!contenu.fichiers.includes('README.md')) regles.obligatoires = regles.obligatoires.filter((f) => f !== 'README.md');
  const versions = lecturesDeVersion(racine);
  if (versions.length > 1) regles.versions = versions;
  return { regles, admis: [...dossiers.map((d) => `${d}/`), ...fichiers] };
}

function branchePrincipale(racine) {
  const suivie = git(racine, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (suivie.ok && suivie.sortie) return suivie.sortie.split('/').slice(1).join('/');
  const courante = git(racine, ['rev-parse', '--abbrev-ref', 'HEAD']).sortie;
  return ['main', 'master', 'trunk'].includes(courante) ? courante : 'main';
}

// La fabrique du modèle, réglée sur ce que le projet utilise : Rust, le gestionnaire npm, ses scripts de tests et de
// construction. `cargoDeny` dit si cargo-deny est sur le poste.
export function adapterFabrique(modele, racine, contenu, { cargoDeny = false } = {}) {
  const fabrique = structuredClone(modele);
  fabrique.principale = branchePrincipale(racine);
  const distants = git(racine, ['remote']).sortie.split('\n').filter(Boolean);
  fabrique.distant = distants.includes('origin') || !distants.length ? 'origin' : distants[0];
  if (contenu.fichiers.includes('Cargo.toml')) {
    fabrique.verification.rust = { entier: RUST_ENTIER, clippy: true, tests: true, a_part: [], deny: cargoDeny ? 'config/deny.toml' : null };
  }
  const paquet = lireTexte(join(racine, 'package.json'));
  if (paquet) {
    const json = JSON.parse(paquet);
    const verrou = contenu.fichiers.find((f) => f in VERROUS);
    const gestionnaire = verrou ? VERROUS[verrou] : (json.packageManager ?? 'npm').split('@')[0];
    if (verrou === 'pnpm-lock.yaml') fabrique.verification.avis_npm = { verrou };
    if (verrou) {
      const figee = { pnpm: ['pnpm', 'install', '--frozen-lockfile'], npm: ['npm', 'ci'], yarn: ['yarn', 'install', '--immutable'], bun: ['bun', 'install', '--frozen-lockfile'] }[gestionnaire];
      fabrique.train.installer = { verrou, commande: figee };
    }
    const scripts = json.scripts ?? {};
    if (scripts.test && !/no test specified/.test(scripts.test)) {
      fabrique.verification.etapes.push({ titre: 'Tests du projet', si: [HORS_DU_KIT], commande: [gestionnaire, 'test'] });
    }
    if (scripts.build) fabrique.verification.etapes.push({ titre: 'Construction', si: [HORS_DU_KIT], commande: [gestionnaire, 'run', 'build'] });
  }
  return fabrique;
}

const json = (valeur) => `${JSON.stringify(valeur, null, 2)}\n`;

// Tout ce que la pose ferait, sans rien écrire : les fichiers à écrire, ceux à retirer, et ce qui se dit.
export function planDePose(racine, { cargoDeny = false } = {}) {
  const manifeste = manifesteDuKit();
  const dossierDuKit = join(racine, 'scripts', 'reglement');
  const jugement = jugerLesScripts(dossierDuKit, manifeste);
  if (jugement.retouches.length || jugement.inconnus.length) return { refus: jugement, manifeste };

  const ecrire = [];
  for (const nom of readdirSync(SCRIPTS_DU_KIT)) ecrire.push({ chemin: `scripts/reglement/${nom}`, depuis: join(SCRIPTS_DU_KIT, nom) });
  const retirer = jugement.aRetirer.map((nom) => `scripts/reglement/${nom}`);
  const contenu = contenuDeLaRacine(racine);
  const gardes = [];
  const admis = [];
  const modele = (chemin, fabriquer) => {
    if (existsSync(join(racine, chemin))) gardes.push(chemin);
    else ecrire.push({ chemin, texte: fabriquer() });
  };
  modele('config/reglement.json', () => {
    const adapte = adapterReglement(JSON.parse(readFileSync(join(KIT, 'config', 'reglement.json'), 'utf8')), racine, contenu);
    admis.push(...adapte.admis);
    return json(adapte.regles);
  });
  modele('config/fabrique.json', () => json(adapterFabrique(JSON.parse(readFileSync(join(KIT, 'config', 'fabrique.json'), 'utf8')), racine, contenu, { cargoDeny })));
  modele('config/disque.json', () => readFileSync(join(KIT, 'config', 'disque.json'), 'utf8'));
  if (contenu.fichiers.includes('Cargo.toml') && cargoDeny) modele('config/deny.toml', () => readFileSync(join(KIT, 'config', 'deny.toml'), 'utf8'));
  modele('.githooks/pre-commit', () => readFileSync(join(KIT, '.githooks', 'pre-commit'), 'utf8'));
  modele('.githooks/pre-push', () => readFileSync(join(KIT, '.githooks', 'pre-push'), 'utf8'));
  modele('AGENTS.md', () => readFileSync(join(KIT, 'AGENTS.md'), 'utf8').replaceAll('{{projet}}', basename(racine)));
  modele('CLAUDE.md', () => readFileSync(join(KIT, 'CLAUDE.md'), 'utf8'));

  const avertir = [];
  for (const crochet of ['pre-commit', 'pre-push']) {
    const texte = gardes.includes(`.githooks/${crochet}`) ? lireTexte(join(racine, '.githooks', crochet)) : null;
    if (texte !== null && !texte.includes('scripts/reglement/')) avertir.push(`.githooks/${crochet} existe et ne joue pas le kit : y reporter les lignes de kit/.githooks/${crochet}.`);
  }
  if (gardes.includes('AGENTS.md')) avertir.push('AGENTS.md existe : y reporter les sections du modèle (kit/AGENTS.md), sans perdre les règles du projet.');
  const claude = gardes.includes('CLAUDE.md') ? lireTexte(join(racine, 'CLAUDE.md')) : null;
  if (claude !== null && (claude.split('\n').filter((l) => l.trim()).length > 3 || !claude.includes('AGENTS.md'))) {
    avertir.push('CLAUDE.md porte des règles : les reporter dans AGENTS.md, puis le réduire au renvoi vers AGENTS.md.');
  }
  const crochets = git(racine, ['config', '--get', 'core.hooksPath']).sortie;
  if (crochets && crochets !== '.githooks') avertir.push(`core.hooksPath vaut déjà « ${crochets} » : il n'est pas changé. Y appeler les crochets du kit, ou passer à .githooks.`);
  return { ecrire, retirer, gardes, admis, avertir, manifeste, ancienne: jugement.ancienne, crochets: !crochets || crochets === '.githooks' };
}

function appliquer(racine, plan) {
  for (const { chemin, depuis, texte } of plan.ecrire) {
    const cible = join(racine, chemin);
    mkdirSync(dirname(cible), { recursive: true });
    if (depuis) copyFileSync(depuis, cible);
    else writeFileSync(cible, texte);
    if (chemin.startsWith('.githooks/')) chmodSync(cible, 0o755);
  }
  for (const chemin of plan.retirer) rmSync(join(racine, chemin), { force: true });
  const ignore = lireTexte(join(racine, '.gitignore')) ?? '';
  const manquent = ['.travail/', '.input/'].filter((l) => !ignore.split(/\r?\n/).includes(l));
  if (manquent.length) appendFileSync(join(racine, '.gitignore'), `${ignore && !ignore.endsWith('\n') ? '\n' : ''}${manquent.join('\n')}\n`);
  mkdirSync(join(racine, '.travail'), { recursive: true });
  if (plan.crochets) git(racine, ['config', 'core.hooksPath', '.githooks']);
}

function principal(argv) {
  const simuler = argv.includes('--simuler');
  const demande = resolve(argv.find((a) => !a.startsWith('--')) ?? process.cwd());
  const haut = git(demande, ['rev-parse', '--show-toplevel']);
  if (!haut.ok) {
    console.error(`${demande} n'est pas dans un dépôt Git : git init d'abord.`);
    return false;
  }
  const racine = resolve(haut.sortie);
  const cargoDeny = spawnSync('cargo', ['deny', '--version'], { windowsHide: true }).status === 0;
  const plan = planDePose(racine, { cargoDeny });
  if (plan.refus) {
    const { retouches, inconnus } = plan.refus;
    console.error(`Pose refusée, rien n'est écrit : scripts/reglement/ s'écarte du kit.`);
    for (const nom of retouches) console.error(`  retouché : scripts/reglement/${nom}`);
    for (const nom of inconnus) console.error(`  inconnu du kit : scripts/reglement/${nom}`);
    console.error('Un réglage propre au projet va dans config/ ; un correctif du kit se fait dans le dépôt du plugin. Remettre ces fichiers comme le kit les a posés, ou les sortir du dossier, puis reposer.');
    return false;
  }
  const version = plan.ancienne && plan.ancienne !== plan.manifeste.version ? `${plan.ancienne} → ${plan.manifeste.version}` : plan.manifeste.version;
  console.log(`${simuler ? 'Simulation, rien n’est écrit. ' : ''}Kit ${plan.manifeste.nom} ${version} dans ${racine}`);
  console.log(`  scripts/reglement/ : ${Object.keys(plan.manifeste.fichiers).length + 1} fichiers${plan.retirer.length ? `, ${plan.retirer.length} retiré(s) : ${plan.retirer.join(', ')}` : ''}`);
  const poses = plan.ecrire.filter((e) => !e.chemin.startsWith('scripts/reglement/')).map((e) => e.chemin);
  if (poses.length) console.log(`  posés : ${poses.join(', ')}`);
  if (plan.gardes.length) console.log(`  gardés tels quels : ${plan.gardes.join(', ')}`);
  if (plan.admis.length) console.log(`  admis à la racine parce que présents, à relire dans config/reglement.json : ${plan.admis.join(', ')}`);
  for (const avis of plan.avertir) console.log(`  ! ${avis}`);
  if (!simuler) appliquer(racine, plan);
  console.log('\nEnsuite : relire config/reglement.json et config/fabrique.json, lancer node scripts/reglement/reglement.mjs, puis commiter ces fichiers.');
  return true;
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) process.exitCode = principal(process.argv.slice(2)) ? 0 : 1;
