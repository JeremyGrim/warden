#!/usr/bin/env node
// La méthode disque, outillée. Les plafonds sont dans config/disque.json, et dans config/disque.local.json pour ce qui
// est propre au poste (non versionné).
//
//   node scripts/reglement/disque.mjs rapport  [--racine <dépôt>]... [--build <dossier>]...
//   node scripts/reglement/disque.mjs garde    [--avertir]
//   node scripts/reglement/disque.mjs nettoyer [--profond] [--appliquer] [--racine <dépôt>]... [--build <dossier>]...
//
// `nettoyer` simule par défaut. Rien ne suit un lien, rien ne sort de la racine,
// et un arbre de travail n'est jamais retiré par cet outil.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { lstat, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NETTOYER = 'node scripts/reglement/disque.mjs nettoyer';
export const GIO = 1024 ** 3;

export function lisible(octets) {
  const unites = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let valeur = octets;
  let rang = 0;
  while (valeur >= 1024 && rang < unites.length - 1) {
    valeur /= 1024;
    rang += 1;
  }
  return `${rang === 0 ? valeur : valeur.toFixed(1)} ${unites[rang]}`;
}

// Mesure sans jamais traverser un lien. Sous Windows, une jonction compte comme un lien.
export async function mesurer(chemin) {
  const total = { octets: 0, fichiers: 0, liens: [] };
  const depart = await lstat(chemin).catch(() => null);
  if (!depart) return total;
  if (depart.isSymbolicLink()) {
    total.liens.push(chemin);
    return total;
  }
  if (!depart.isDirectory()) {
    total.octets = depart.size;
    total.fichiers = 1;
    return total;
  }

  const lireDossier = async (dossier) => {
    const entrees = await readdir(dossier, { withFileTypes: true }).catch(() => []);
    for (const entree of entrees) {
      const enfant = join(dossier, entree.name);
      if (entree.isSymbolicLink()) {
        total.liens.push(enfant);
      } else if (entree.isDirectory()) {
        pile.push(enfant);
      } else {
        const fiche = await lstat(enfant).catch(() => null);
        if (fiche) {
          total.octets += fiche.size;
          total.fichiers += 1;
        }
      }
    }
  };

  const pile = [chemin];
  let actifs = 0;
  await new Promise((fini, echec) => {
    const suite = () => {
      if (pile.length === 0 && actifs === 0) {
        fini();
        return;
      }
      while (actifs < 32 && pile.length) {
        actifs += 1;
        lireDossier(pile.pop()).then(() => {
          actifs -= 1;
          suite();
        }, echec);
      }
    };
    suite();
  });
  return total;
}

// Une cible est sûre si aucun maillon sous la racine n'est un lien et si elle reste dans la racine une fois résolue.
export async function raisonDeRefus(racine, cible) {
  const relatif = relative(racine, cible);
  if (!relatif || relatif.startsWith('..') || isAbsolute(relatif)) return 'hors de la racine';
  let courant = racine;
  for (const morceau of relatif.split(sep)) {
    courant = join(courant, morceau);
    const fiche = await lstat(courant).catch(() => null);
    if (!fiche) return 'absent';
    if (fiche.isSymbolicLink()) return `« ${courant} » est un lien`;
  }
  const rel = relative(await realpath(racine), await realpath(cible));
  if (rel.startsWith('..') || isAbsolute(rel)) return 'hors de la racine une fois résolu';
  return null;
}

async function sousDossiers(dossier) {
  const entrees = await readdir(dossier, { withFileTypes: true }).catch(() => []);
  return entrees.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Les caches incrémentaux d'un dossier de build, profils et triplets de cible compris.
async function incrementaux(build) {
  const trouves = [];
  for (const niveau1 of await sousDossiers(build)) {
    const dossier1 = join(build, niveau1);
    if (existsSync(join(dossier1, 'incremental'))) trouves.push(join(dossier1, 'incremental'));
    for (const niveau2 of await sousDossiers(dossier1)) {
      const candidat = join(dossier1, niveau2, 'incremental');
      if (existsSync(candidat)) trouves.push(candidat);
    }
  }
  return trouves;
}

// Ce qui se régénère vite dans un dossier de build.
export async function jetablesDeBuild(build) {
  const fixes = ['tmp', 'doc', 'package'].map((c) => join(build, c)).filter((c) => existsSync(c));
  return [...(await incrementaux(build)), ...fixes];
}

// Ce qui se régénère vite dans un dépôt : jetable sans réfléchir.
export async function jetables(racine) {
  const fixes = ['node_modules/.cache', 'coverage']
    .map((c) => join(racine, ...c.split('/')))
    .filter((c) => existsSync(c));
  return [...(await jetablesDeBuild(join(racine, 'target'))), ...fixes];
}

// Ce qui se régénère lentement : seulement sur demande.
export function gros(racine) {
  return ['target', 'node_modules'].map((c) => join(racine, c)).filter((c) => existsSync(c));
}

function git(args, cwd) {
  const sortie = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return sortie.status === 0 ? sortie.stdout : null;
}

export function arbresDeTravail(racine) {
  const sortie = git(['worktree', 'list', '--porcelain'], racine);
  if (!sortie) return [];
  const blocs = sortie.trim().split(/\r?\n\r?\n/).map((bloc) => {
    const lignes = bloc.split(/\r?\n/);
    const valeur = (cle) => lignes.find((l) => l.startsWith(`${cle} `))?.slice(cle.length + 1);
    return { chemin: valeur('worktree'), branche: valeur('branch')?.replace('refs/heads/', '') ?? '(détachée)' };
  });
  return blocs.slice(1).map((arbre) => {
    if (!existsSync(arbre.chemin)) return { ...arbre, absent: true, retirable: true, modifies: 0, nonPousses: 0, ageJours: 0 };
    const modifies = (git(['status', '--porcelain'], arbre.chemin) ?? '').split('\n').filter(Boolean).length;
    const nonPousses = Number(git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], arbre.chemin) ?? 0);
    const date = Number(git(['log', '-1', '--format=%ct'], arbre.chemin) ?? 0);
    const ageJours = Math.floor((Date.now() / 1000 - date) / 86400);
    return { ...arbre, modifies, nonPousses, ageJours, retirable: modifies === 0 && nonPousses === 0 };
  });
}

// Le client du cache partagé (sccache) tient lui aussi l'arbre qu'il compile : une compilation servie par le cache ne
// lance aucun rustc.
export const OUTILS_DE_BUILD = /^(cargo|rustc|clippy-driver|link|lld-link|rust-lld|cc|ld|cargo-deny|sccache|build-script-[\w-]+)(\.exe)?$/i;
const VERROUS_DE_CARGO = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];

// Les processus du poste : identifiant, parent, nom, ligne de commande, exécutable et, hors Windows, dossier courant.
export function processusDuPoste() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress';
    const sortie = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (sortie.status !== 0 || !sortie.stdout.trim()) return null;
    return [JSON.parse(sortie.stdout)].flat().map((p) => ({
      pid: p.ProcessId, parent: p.ParentProcessId, nom: p.Name ?? '', ligne: p.CommandLine ?? '', executable: p.ExecutablePath ?? '', dossier: '',
    }));
  }
  let pids;
  try {
    pids = readdirSync('/proc').filter((nom) => /^\d+$/.test(nom));
  } catch {
    return null;
  }
  const lire = (f) => {
    try {
      return f();
    } catch {
      return '';
    }
  };
  return pids.map((pid) => {
    const ligne = lire(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '));
    return {
      pid: Number(pid),
      parent: Number(lire(() => readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+\S+\s+/, '').split(' ')[0])) || 0,
      nom: basename(ligne.split(' ')[0] ?? ''),
      ligne,
      executable: lire(() => readlinkSync(`/proc/${pid}/exe`)),
      dossier: lire(() => readlinkSync(`/proc/${pid}/cwd`)),
    };
  });
}

export function dansLArbre(racine) {
  const normal = (chemin) => chemin.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const motif = new RegExp(`${normal(racine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/"' ])`);
  return (texte) => Boolean(texte) && motif.test(normal(texte));
}

// Un processus tient cet arbre : un outil de build dont la ligne de commande nomme l'arbre ou qui y travaille, ou
// n'importe quel programme lancé depuis l'arbre (un test, un script de build, l'application construite).
// Les processus des autres arbres du poste ne comptent pas : à plusieurs agents, il y en a toujours un.
export function compilationDansLArbre(racine, processus = processusDuPoste()) {
  if (!processus) return null;
  const dedans = dansLArbre(racine);
  return processus.find((p) => dedans(p.executable) || (OUTILS_DE_BUILD.test(p.nom) && (dedans(p.ligne) || dedans(p.dossier)))) ?? null;
}

// Les verrous que Cargo pose dans un dossier de build, profils et triplets de cible compris.
export async function verrousDeCargo(build) {
  const dossiers = [];
  for (const niveau1 of await sousDossiers(build)) {
    dossiers.push(join(build, niveau1));
    for (const niveau2 of await sousDossiers(join(build, niveau1))) dossiers.push(join(build, niveau1, niveau2));
  }
  return dossiers.flatMap((dossier) => VERROUS_DE_CARGO.map((nom) => join(dossier, nom))).filter((chemin) => existsSync(chemin));
}

// Cargo, lui, ne nomme pas son arbre (sous Windows, son dossier courant ne se lit pas), et ses fichiers ouverts
// n'empêchent pas de renommer `target`. Mais tant qu'il compile, il garde ses verrous : on essaie de les prendre.
export function verrousTenus(fichiers) {
  if (!fichiers.length) return [];
  if (process.platform === 'win32') {
    const script = [
      '$tenus = foreach ($f in $input) {',
      "  try { $s = [IO.File]::Open($f, 'Open', 'ReadWrite', 'ReadWrite, Delete') } catch { $f; continue }",
      '  try { $s.Lock(0, 1); $s.Unlock(0, 1) } catch { $f } finally { $s.Dispose() }',
      '}',
      '$tenus',
    ].join('\n');
    const sortie = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, input: fichiers.join('\n'), encoding: 'utf8' });
    if (sortie.status !== 0) return fichiers;
    return sortie.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  return fichiers.filter((f) => {
    const essai = spawnSync('flock', ['-n', '-E', '75', f, 'true'], { windowsHide: true });
    return essai.error ? false : essai.status === 75;
  });
}

// Ce qui retient un arbre de son nettoyage, ou null. Chaque arbre pour lui-même.
export async function arbreTenu(racine, processus = processusDuPoste()) {
  const tenu = compilationDansLArbre(racine, processus);
  if (tenu) return `${tenu.nom} y travaille`;
  const build = existsSync(join(racine, 'target')) ? join(racine, 'target') : racine;
  const verrous = verrousTenus(await verrousDeCargo(build));
  if (verrous.length) return `Cargo y tient ${relative(racine, verrous[0])}`;
  return null;
}

// Retirer d'abord par un renommage : un `target` à moitié vidé à sa place tromperait le build suivant, alors qu'un
// dossier mis à l'écart le laisse repartir de zéro. Un fichier qu'on ne peut effacer est dit, pas caché.
async function retirer(cible) {
  const mise_a_l_ecart = `${cible}.a-supprimer-${process.pid}`;
  try {
    await rename(cible, mise_a_l_ecart);
  } catch (erreur) {
    if (['EPERM', 'EBUSY', 'EACCES'].includes(erreur.code)) return 'tenu par un processus (une compilation, un programme lancé)';
    throw erreur;
  }
  try {
    await rm(mise_a_l_ecart, { recursive: true, force: true, maxRetries: 3 });
  } catch (erreur) {
    return `mis à l'écart dans ${mise_a_l_ecart}, retiré en partie (${erreur.code}) : un processus y tient encore un fichier`;
  }
  return null;
}

async function espaceLibre(chemin) {
  const fiche = await statfs(chemin);
  return fiche.bavail * fiche.bsize;
}

// Deux arbres sur un même `target` se croient à jour l'un l'autre : Cargo compare des
// dates, et un arbre peut passer au vert sans que son code ait été compilé.
export async function ciblePartagee(racine, env) {
  const fiche = await lstat(join(racine, 'target')).catch(() => null);
  if (fiche?.isSymbolicLink()) return '`target` est un lien';
  if (env.CARGO_TARGET_DIR) {
    const rel = relative(racine, resolve(racine, env.CARGO_TARGET_DIR));
    if (rel.startsWith('..') || isAbsolute(rel)) return 'CARGO_TARGET_DIR pointe hors de cet arbre';
  }
  return null;
}

export async function evaluer({ racine, config, rapide = false, env = process.env }) {
  const alertes = [];
  const libre = await espaceLibre(racine);
  if (libre < config.espace_libre_min_gio * GIO) {
    alertes.push(`Espace libre sur ${parse(racine).root} : ${lisible(libre)} pour ${config.espace_libre_min_gio} Gio au moins. Lancer \`${NETTOYER}\`.`);
  }
  const partage = await ciblePartagee(racine, env);
  if (partage) {
    alertes.push(`${partage} : un build partagé peut passer au vert sans compiler le code de cet arbre. Lui rendre son propre \`target\`.`);
  }
  // Une copie figée (le dépôt d'origine d'une migration) se lit, elle ne se compile pas.
  for (const fige of config.copies_figees ?? []) {
    if (existsSync(join(racine, fige, 'target'))) alertes.push(`\`${fige}/target\` existe : on ne compile rien dans la copie figée. Le retirer.`);
  }
  const arbres = arbresDeTravail(racine);
  if (arbres.length > config.arbres_max) {
    alertes.push(`${arbres.length} arbres de travail en plus de l'arbre principal, pour ${config.arbres_max} au plus.`);
  }
  for (const arbre of arbres) {
    if (arbre.ageJours > config.arbre_age_max_jours) {
      alertes.push(`Arbre de travail vieux de ${arbre.ageJours} jours : ${arbre.chemin}.`);
    }
  }
  const mesures = {};
  if (!rapide) {
    mesures.build = await mesurer(join(racine, 'target'));
    mesures.incremental = 0;
    for (const dossier of await incrementaux(join(racine, 'target'))) mesures.incremental += (await mesurer(dossier)).octets;
    if (mesures.build.octets > config.build_max_gio * GIO) {
      alertes.push(`Build : ${lisible(mesures.build.octets)} pour ${config.build_max_gio} Gio au plus. Lancer \`${NETTOYER} --profond\`.`);
    }
    if (mesures.incremental > config.incremental_max_gio * GIO) {
      alertes.push(`Caches incrémentaux : ${lisible(mesures.incremental)} pour ${config.incremental_max_gio} Gio au plus. Lancer \`${NETTOYER}\`.`);
    }
    mesures.caches = [];
    for (const cache of config.caches_partages ?? []) {
      const mesure = { ...cache, octets: (await mesurer(cache.chemin)).octets, libre: await espaceLibre(cache.chemin).catch(() => null) };
      mesures.caches.push(mesure);
      if (cache.max_gio && mesure.octets > cache.max_gio * GIO) {
        alertes.push(`Cache partagé ${cache.chemin} : ${lisible(mesure.octets)} pour ${cache.max_gio} Gio au plus. Il se borne seul : regarder son réglage.`);
      }
      if (mesure.libre !== null && mesure.libre < config.espace_libre_min_gio * GIO) {
        alertes.push(`Espace libre sur ${parse(cache.chemin).root}, disque du cache partagé : ${lisible(mesure.libre)} pour ${config.espace_libre_min_gio} Gio au moins.`);
      }
    }
  }
  return { alertes, libre, arbres, mesures };
}

// Le cache de compilation partagé par tous les arbres du poste. Il se déclare dans `config/disque.local.json`
// (`caches_partages`), sinon il se lit dans la configuration de Cargo du poste, là où il est branché
// (`SCCACHE_DIR` et `SCCACHE_CACHE_SIZE`). La garde le mesure ; `nettoyer` n'y touche jamais : il se borne lui-même.
export function cachesPartages(config, configurationCargo) {
  if (Array.isArray(config.caches_partages)) return config.caches_partages;
  const valeur = (cle) => new RegExp(`^\\s*${cle}\\s*=\\s*['"]([^'"]+)['"]`, 'm').exec(configurationCargo ?? '')?.[1];
  const chemin = valeur('SCCACHE_DIR');
  if (!chemin) return [];
  const taille = /^(\d+(?:\.\d+)?)\s*([KMGT])?/i.exec(valeur('SCCACHE_CACHE_SIZE') ?? '');
  const unite = { K: 1 / (1024 * 1024), M: 1 / 1024, G: 1, T: 1024 }[(taille?.[2] ?? 'G').toUpperCase()];
  return [{ chemin, max_gio: taille ? Number(taille[1]) * unite : null }];
}

function configurationCargoDuPoste() {
  const fichier = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'config.toml');
  return existsSync(fichier) ? readFileSync(fichier, 'utf8') : '';
}

// Liste, ou applique, ce qu'on peut retirer. Retourne ce qui a été vu pour chaque cible.
export async function nettoyer({ racine, profond = false, appliquer = false }) {
  return traiter(racine, profond ? gros(racine) : await jetables(racine), appliquer);
}

// La même chose pour un dossier de build placé hors d'un dépôt.
export async function nettoyerBuild({ build, profond = false, appliquer = false }) {
  const cibles = profond ? [build] : await jetablesDeBuild(build);
  return traiter(dirname(build), cibles, appliquer);
}

async function traiter(racine, cibles, appliquer) {
  const resultat = [];
  for (const cible of cibles) {
    const refus = await raisonDeRefus(racine, cible);
    if (refus) {
      resultat.push({ cible, octets: 0, retire: false, refus });
      continue;
    }
    const mesure = await mesurer(cible);
    if (mesure.liens.length) {
      resultat.push({ cible, octets: mesure.octets, retire: false, refus: `contient ${mesure.liens.length} lien(s), dont ${mesure.liens[0]}` });
      continue;
    }
    const tenu = appliquer ? await retirer(cible) : null;
    resultat.push({ cible, octets: tenu ? 0 : mesure.octets, retire: appliquer && !tenu, refus: tenu });
  }
  return resultat;
}

export function chargerConfig(racine = RACINE) {
  const lireJson = (chemin) => (existsSync(chemin) ? JSON.parse(readFileSync(chemin, 'utf8')) : {});
  const config = {
    ...lireJson(join(racine, 'config', 'disque.json')),
    ...lireJson(join(racine, 'config', 'disque.local.json')),
  };
  return { ...config, caches_partages: cachesPartages(config, configurationCargoDuPoste()) };
}

function cheminsDemandes(argv, drapeau, depuisConfig = []) {
  const chemins = [];
  argv.forEach((mot, i) => {
    if (mot === drapeau && argv[i + 1]) chemins.push(resolve(argv[i + 1]));
  });
  for (const chemin of depuisConfig) chemins.push(resolve(chemin));
  return [...new Set(chemins)];
}

function racinesDemandees(argv, config) {
  return [...new Set([RACINE, ...cheminsDemandes(argv, '--racine', config.racines)])];
}

function buildsDemandes(argv, config) {
  return cheminsDemandes(argv, '--build', config.builds);
}

function ligneArbre(arbre) {
  const etat = arbre.absent
    ? 'dossier absent : `git worktree prune`'
    : arbre.retirable
      ? `propre et tout poussé : \`git worktree remove "${arbre.chemin}"\``
      : `à traiter : ${arbre.modifies} fichier(s) modifié(s), ${arbre.nonPousses} commit(s) non poussé(s)`;
  return `    ${arbre.chemin} [${arbre.branche}], ${arbre.ageJours} j, ${etat}`;
}

async function commandeRapport(argv, config) {
  for (const racine of racinesDemandees(argv, config)) {
    if (!existsSync(racine)) {
      console.log(`${racine} : absent`);
      continue;
    }
    const { alertes, libre, arbres, mesures } = await evaluer({ racine, config });
    const dependances = await mesurer(join(racine, 'node_modules'));
    const historique = await mesurer(join(racine, '.git'));
    console.log(`${basename(racine)}  (${racine})`);
    console.log(`  Espace libre         ${lisible(libre)}`);
    console.log(`  Build (target)       ${lisible(mesures.build.octets)}, dont ${lisible(mesures.incremental)} d'incrémental`);
    if (mesures.build.liens.length) console.log(`    Lien dans target : ${mesures.build.liens[0]}`);
    console.log(`  node_modules         ${lisible(dependances.octets)}`);
    console.log(`  Historique Git       ${lisible(historique.octets)}`);
    console.log(`  Arbres de travail    ${arbres.length}`);
    for (const arbre of arbres) console.log(ligneArbre(arbre));
    console.log(alertes.length ? alertes.map((a) => `  ! ${a}`).join('\n') : '  Dans les budgets.');
    console.log('');
  }
  for (const build of buildsDemandes(argv, config)) {
    const mesure = await mesurer(build);
    let incremental = 0;
    for (const dossier of await incrementaux(build)) incremental += (await mesurer(dossier)).octets;
    console.log(`Build hors dépôt  ${build}`);
    console.log(`  ${lisible(mesure.octets)}, dont ${lisible(incremental)} d'incrémental`);
    if (mesure.octets > config.build_max_gio * GIO) console.log(`  ! Au-delà de ${config.build_max_gio} Gio.`);
    console.log('');
  }
  for (const cache of config.caches_partages) {
    const octets = (await mesurer(cache.chemin)).octets;
    console.log(`Cache partagé       ${cache.chemin} : ${lisible(octets)}${cache.max_gio ? ` pour ${cache.max_gio} Gio au plus` : ''}, ${lisible(await espaceLibre(cache.chemin).catch(() => 0))} libres sur son disque`);
  }
  console.log(`Temporaire système  ${lisible((await mesurer(tmpdir())).octets)}`);
}

async function commandeGarde(argv, config) {
  const avertir = argv.includes('--avertir');
  const { alertes } = await evaluer({ racine: RACINE, config, rapide: avertir });
  if (!alertes.length) {
    console.log('Disque : dans les budgets.');
    return;
  }
  for (const alerte of alertes) console.error(`Disque : ${alerte}`);
  if (!avertir) process.exitCode = 1;
}

async function commandeNettoyer(argv, config) {
  const appliquer = argv.includes('--appliquer');
  const profond = argv.includes('--profond');
  const processus = appliquer ? processusDuPoste() : [];
  // Chaque arbre pour lui-même : une compilation dans un autre arbre du poste ne retient pas celui-ci.
  const libre = async (chemin) => {
    if (!appliquer) return true;
    const tenu = await arbreTenu(chemin, processus);
    if (!tenu) return true;
    console.error(`Une compilation tourne dans ${chemin} (${tenu}) : rien n’y est retiré. Relancer quand elle est finie.`);
    process.exitCode = 1;
    return false;
  };
  let total = 0;
  const afficher = ({ cible, octets, retire, refus }) => {
    if (refus) {
      console.log(`Refusé    ${cible} : ${refus}`);
      return;
    }
    total += octets;
    console.log(`${retire ? 'Retiré   ' : 'À retirer'} ${lisible(octets).padStart(10)}  ${cible}`);
  };
  for (const racine of racinesDemandees(argv, config)) {
    if (await libre(racine)) (await nettoyer({ racine, profond, appliquer })).forEach(afficher);
  }
  for (const build of buildsDemandes(argv, config)) {
    if (await libre(build)) (await nettoyerBuild({ build, profond, appliquer })).forEach(afficher);
  }
  console.log(`${appliquer ? 'Retiré' : 'Simulation, rien n’est retiré'} : ${lisible(total)}.`);
  if (!appliquer) console.log('Pour retirer vraiment : ajouter --appliquer.');
}

async function principal(argv) {
  const [commande = 'rapport', ...reste] = argv;
  const config = chargerConfig();
  if (commande === 'rapport') return commandeRapport(reste, config);
  if (commande === 'garde') return commandeGarde(reste, config);
  if (commande === 'nettoyer') return commandeNettoyer(reste, config);
  console.error(`Commande inconnue : ${commande}. Commandes : rapport, garde, nettoyer.`);
  process.exitCode = 2;
  return undefined;
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) await principal(process.argv.slice(2));
