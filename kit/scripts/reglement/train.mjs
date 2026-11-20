#!/usr/bin/env node
// Le train vers la branche principale : la fabrique, seul arbre qui y pousse, fait entrer les branches prêtes par lots.
//
//   node scripts/reglement/train.mjs conduire --agent <nom> [--avec <branche locale>] [--lot N]   prend le créneau et emmène un lot
//   node scripts/reglement/train.mjs conduire --simuler                                          empile et dit ce qui monterait, sans rien vérifier ni pousser
//   node scripts/reglement/train.mjs veille                                                      rend la main quand une branche attend
//
// Une branche prête se dépose dans le dossier `train-pret` voisin du créneau : un fichier `<session>.txt` qui dit
// `arbre`, `branche`, `taches`, `depose`, et `parcours` si le changement se voit à l'écran. Le conducteur prend au plus
// `train.lot_max` branches dans l'ordre des dépôts, les empile sur la branche principale, laisse de côté une branche en
// conflit sans le résoudre à la place de son auteur, puis vérifie et fabrique une seule fois pour le lot, et pousse.
// Si l'essai échoue, il cherche la fautive par moitiés, la sort et pousse le reste. Les branches au-delà du lot
// attendent le train suivant : un lot court borne la recherche par moitiés à deux essais de plus.
// Les commandes d'installation et de fabrication sont dans config/fabrique.json, section `train`.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FABRIQUE_PAR_DEFAUT, lancer, lireFabrique, RACINE, reglageDuPoste } from './config.mjs';
import { prendre, rendre } from './creneau.mjs';
import { processusDuPoste } from './disque.mjs';
import { arbresDuProjet, regler, rendreLesPriorites } from './priorite.mjs';
import { creneauDuPoste, garderLeCreneau, marquerVerifie, registreDuCreneau, verifierFichiers } from './verifier.mjs';

// Un lot de treize qui échoue coûte jusqu'à quatre vérifications de plus ; un lot de quatre, deux.
export const LOT_MAX = FABRIQUE_PAR_DEFAUT.train.lot_max;

// Un dépôt : des lignes `cle = valeur`. Le moment du dépôt `jj/mm hh:mm` (année en cours), sinon la date du fichier.
export function lireDepot(nom, texte, dateDuFichier = 0, annee = new Date().getFullYear()) {
  const champs = {};
  for (const ligne of texte.split(/\r?\n/)) {
    const trouve = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(ligne);
    if (trouve) champs[trouve[1].toLowerCase()] = trouve[2];
  }
  const quand = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(champs.depose ?? '');
  const moment = quand ? new Date(annee, Number(quand[2]) - 1, Number(quand[1]), Number(quand[3]), Number(quand[4])).getTime() : dateDuFichier;
  return {
    nom,
    arbre: champs.arbre,
    branche: champs.branche,
    taches: (champs.taches ?? '').split(/[,\s]+/).filter(Boolean),
    parcours: (champs.parcours ?? '').split(/[,\s]+/).filter(Boolean),
    refuse: champs.refuse ?? null,
    moment,
  };
}

// Les dépôts qui partent : complets, sans refus en cours, dans l'ordre d'arrivée.
export function depotsPrets(depots) {
  return depots.filter((d) => d.arbre && d.branche && !d.refuse).sort((a, b) => a.moment - b.moment || a.nom.localeCompare(b.nom));
}

// Le lot de ce train : les candidates dans l'ordre, chacune empilée sur les précédentes (`empiler(depot)` dit si elle
// s'empile). Une candidate en conflit sort ; le lot se complète avec les suivantes jusqu'à `max`. Le reste attend.
export function choisirLot(candidates, empiler, max = LOT_MAX) {
  const lot = [];
  const conflits = [];
  for (const depot of candidates) {
    if (lot.length >= max) break;
    const cause = empiler(depot);
    if (cause) conflits.push({ depot, cause });
    else lot.push(depot);
  }
  return { lot, conflits };
}

// La recherche par moitiés : `essayer(liste)` dit si la liste passe la vérification. Rend ce qui monte et ce qui sort.
// Les branches gardées restent dans l'ordre ; chaque essai porte celles déjà gardées, puis les candidates. Quand la
// moitié gauche passe entière, l'échec du tout vient de la droite : on ne le revérifie pas.
export async function trier(candidates, essayer, gardees = [], echecConnu = false) {
  if (!candidates.length) return { montees: gardees, sorties: [] };
  if (!echecConnu && (await essayer([...gardees, ...candidates]))) return { montees: [...gardees, ...candidates], sorties: [] };
  if (candidates.length === 1) return { montees: gardees, sorties: candidates };
  const milieu = Math.ceil(candidates.length / 2);
  const gauche = await trier(candidates.slice(0, milieu), essayer, gardees);
  const droite = await trier(candidates.slice(milieu), essayer, gauche.montees, gauche.sorties.length === 0);
  return { montees: droite.montees, sorties: [...gauche.sorties, ...droite.sorties] };
}

// Les commits d'un dépôt que le train n'a pas encore, d'après `git cherry` (« - » : le même patch est déjà dans le train).
// Une branche empilée sur un autre dépôt en porte les commits : rejoué après un commit suivant qui retouche les mêmes
// lignes, un commit déjà pris se dirait en conflit.
export function sansDejaPris(commits, cherry) {
  const pris = new Set(cherry.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()));
  return commits.filter((c) => !pris.has(c));
}

// L'outil des tâches suit le contrat de suivi : `<outil> note <tâche> <texte> --agent <nom>`. Un script Node passe par
// Node ; tout autre programme se lance tel quel.
export function commandeDeNote(outil, agent, tache, texte) {
  const args = ['note', tache, texte, '--agent', agent];
  return /\.(mjs|cjs|js)$/i.test(outil) ? ['node', outil, ...args] : [outil, ...args];
}

function git(args, options = {}) {
  const sortie = spawnSync('git', args, { cwd: RACINE, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, ...options });
  return { ok: sortie.status === 0, sortie: (sortie.stdout ?? '').trim(), erreur: (sortie.stderr ?? '').trim() };
}

function exiger(args) {
  const r = git(args);
  if (!r.ok) throw new Error(`git ${args.join(' ')} : ${r.erreur}`);
  return r.sortie;
}

const heure = () => new Date().toTimeString().slice(0, 5);
const racinePrincipale = () => dirname(exiger(['rev-parse', '--path-format=absolute', '--git-common-dir']));

async function conduire(argv, fabrique) {
  const valeur = (drapeau) => (argv.includes(drapeau) ? argv[argv.indexOf(drapeau) + 1] : undefined);
  const agent = valeur('--agent') ?? 'train';
  const { principale, distant, train } = fabrique;
  const suivi = `${distant}/${principale}`;
  const creneau = creneauDuPoste(fabrique);
  if (!creneau) throw new Error('aucun créneau connu pour cet arbre : créer .travail/ à la racine, ou git config reglement.creneau "<dossier>"');
  const quai = join(dirname(creneau), 'train-pret');
  if (git(['status', '--porcelain', '--untracked-files=no']).sortie) throw new Error('l’arbre a des modifications suivies : le train part d’un arbre propre');
  const depart = exiger(['rev-parse', '--abbrev-ref', 'HEAD']);

  // Les branches d'un lot, empilées sur le train tel qu'il est. Rend la cause d'un conflit, ou null.
  const empiler = (depot) => {
    if (!depot.commits.length) return null;
    const cherry = git(['cherry', 'HEAD', depot.commits.at(-1)]);
    const commits = cherry.ok ? sansDejaPris(depot.commits, cherry.sortie) : depot.commits;
    if (!commits.length) return null;
    const empile = git(['cherry-pick', '--empty=drop', '--allow-empty', ...commits]);
    if (empile.ok) return null;
    const fichiers = git(['diff', '--name-only', '--diff-filter=U']).sortie.split('\n').filter(Boolean);
    git(['cherry-pick', '--abort']);
    return `conflit avec ${principale} ou le train${fichiers.length ? ` : ${fichiers.slice(0, 4).join(', ')}` : ''}`;
  };
  // `-f` : un essai précédent peut laisser un fichier suivi modifié (un outil qui réécrit un verrou pendant l'essai).
  // Chaque essai repart de la branche principale, propre.
  const repartir = () => exiger(['checkout', '--quiet', '-f', '-B', train.branche, suivi]);
  const construire = (depots) => {
    repartir();
    return depots.map((depot) => ({ depot, cause: empiler(depot) })).filter((c) => c.cause);
  };

  const prise = await prendre({ dossier: creneau, arbre: RACINE, commit: 'train', dormir: (ms) => new Promise((f) => setTimeout(f, ms)), dire: (t) => console.log(t), registre: registreDuCreneau(creneau, fabrique) });
  if (!prise.pris) throw new Error(prise.raison);
  console.log('Créneau pris par le train.');
  garderLeCreneau(creneau);
  // La fabrique garde la machine entière pour ses compilations, et la priorité du processeur lui revient tant qu'elle tourne.
  if (!process.env.CARGO_BUILD_JOBS) process.env.CARGO_BUILD_JOBS = String(availableParallelism());
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'priorite', String(process.pid)], { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const outil = reglageDuPoste('taches');
  const noter = (tache, texte) => outil && lancer(commandeDeNote(outil, agent, tache, texte), { encoding: 'utf8' });
  let pousse = false;
  let verrouInstalle = null;
  try {
    exiger(['fetch', '--quiet', distant, principale]);
    const fichiers = existsSync(quai) ? readdirSync(quai).filter((f) => f.endsWith('.txt')) : [];
    const depots = depotsPrets(fichiers.map((f) => lireDepot(f, readFileSync(join(quai, f), 'utf8'), statSync(join(quai, f)).mtimeMs)));
    const avec = valeur('--avec');
    if (avec) depots.push({ nom: `${agent}.txt`, arbre: RACINE, branche: avec, taches: [], parcours: [], refuse: null, moment: Date.now(), propre: true });
    const max = Number(valeur('--lot') ?? train.lot_max);
    if (!Number.isInteger(max) || max < 1) throw new Error('--lot attend un nombre entier, au moins 1');
    if (!depots.length) {
      console.log('Aucune branche n’attend le train.');
      return true;
    }

    const refuses = [];
    const candidats = [];
    for (const depot of depots) {
      const ref = `refs/train/${depot.nom.replace(/[^\w.-]+/g, '-')}`;
      const pris = git(['fetch', '--quiet', depot.arbre, `+${depot.branche}:${ref}`]);
      if (!pris.ok) {
        refuses.push({ depot, cause: `branche introuvable (${pris.erreur.split('\n')[0]})` });
        continue;
      }
      const base = exiger(['merge-base', suivi, ref]);
      candidats.push({ ...depot, commits: exiger(['rev-list', '--reverse', '--no-merges', `${base}..${ref}`]).split('\n').filter(Boolean) });
    }
    // Les conflits se voient sans vérifier : on empile dans l'ordre jusqu'au lot plein, et ce qui ne s'empile pas sort.
    repartir();
    const { lot: empilables, conflits } = choisirLot(candidats, empiler, max);
    refuses.push(...conflits);
    const attendent = candidats.length - empilables.length - conflits.length;
    console.log(`Train : ${empilables.map((d) => `${d.branche} (${d.commits.length})`).join(', ') || 'rien'} ; laissées de côté : ${refuses.length} ; pour le train suivant : ${attendent}.`);

    if (argv.includes('--simuler')) {
      for (const { depot, cause } of refuses) console.log(`Laissée de côté : ${depot.branche}, ${cause}.`);
      console.log(`Simulation : ${empilables.length} branche(s) s'empilent sur ${exiger(['rev-parse', '--short', suivi])} ; rien n'est vérifié, poussé ni noté.`);
      return true;
    }

    // L'essai, toujours dans cet ordre : les dépendances du lot avant toute garde (une branche qui en ajoute se
    // vérifie avec elles) ; le règlement et les gardes des scripts, en quelques secondes (deux branches vertes chacune
    // peuvent ensemble dépasser un plafond) ; la vérification des fichiers changés ; la fabrication, une seule fois.
    const etape = (titre, commande) => {
      console.log(`\n▶ ${titre}`);
      const debut = Date.now();
      const ok = lancer(commande, { cwd: RACINE, stdio: 'inherit' }).status === 0;
      console.log(ok ? `✔ ${titre} (${Math.round((Date.now() - debut) / 1000)} s)` : `✖ ${titre} : échec.`);
      return ok;
    };
    const installer = () => {
      if (!train.installer) return true;
      const verrou = git(['rev-parse', `HEAD:${train.installer.verrou}`]).sortie || 'aucun';
      if (verrou === verrouInstalle) return true;
      const ok = etape('Dépendances', train.installer.commande);
      verrouInstalle = ok ? verrou : null;
      return ok;
    };
    const essayer = (liste) => {
      if (construire(liste).length) return false;
      const changes = git(['diff', '--name-only', suivi, 'HEAD']).sortie.split('\n').filter(Boolean);
      console.log(`\n=== Vérification de ${liste.map((d) => d.branche).join(' + ')} (${changes.length} fichiers)`);
      return installer()
        && etape('Règlement', ['node', 'scripts/reglement/reglement.mjs'])
        && etape('Gardes des scripts', ['node', '--test', '--test-reporter=dot', 'scripts/**/*.test.mjs'])
        && verifierFichiers(changes, fabrique)
        && (!train.fabriquer || etape(train.fabriquer.titre ?? 'Fabrication', train.fabriquer.commande));
    };
    const { montees, sorties } = await trier(empilables, essayer);
    for (const depot of sorties) refuses.push({ depot, cause: `la vérification${train.fabriquer ? ' ou la fabrication' : ''} échoue avec cette branche` });

    if (montees.length) {
      construire(montees);
      const sommet = exiger(['rev-parse', 'HEAD']);
      marquerVerifie(sommet);
      const envoi = git(['push', distant, `${train.branche}:${principale}`], { stdio: 'inherit' });
      if (!envoi.ok) throw new Error('la poussée du train a échoué');
      pousse = true;
      const court = sommet.slice(0, 7);
      console.log(`Train poussé : ${court}.`);
      for (const depot of montees) {
        if (!depot.propre) unlinkSync(join(quai, depot.nom));
        const parcours = depot.parcours?.length ? ` Parcours ${depot.parcours.join(', ')} : pas encore joué.` : ' Aucun parcours déposé.';
        for (const tache of depot.taches) noter(tache, `Sur ${principale} par le train de ${heure()}, commit ${court} (branche ${depot.branche}), vérifié.${parcours}`);
      }
    }
    for (const { depot, cause } of refuses) {
      if (!depot.propre) appendFileSync(join(quai, depot.nom), `\nrefuse = ${cause} (train de ${heure()})\n`);
      for (const tache of depot.taches) noter(tache, `Train de ${heure()} : branche ${depot.branche} laissée de côté, ${cause}. Corriger, rebaser, retirer la ligne refuse du dépôt.`);
      console.log(`Laissée de côté : ${depot.branche}, ${cause}.`);
    }
    return true;
  } finally {
    git(['checkout', '--quiet', '-f', depart]);
    // Après une poussée réussie, le crochet a confié le créneau à son processus détaché, qui le rend à l'arrivée.
    if (!pousse) rendre(creneau, RACINE);
  }
}

// Rend la main quand une branche attend le train, sans rien coûter entre-temps : un relevé du dossier par minute.
async function veille(fabrique) {
  const creneau = creneauDuPoste(fabrique);
  if (!creneau) throw new Error('aucun créneau connu pour cet arbre');
  const quai = join(dirname(creneau), 'train-pret');
  for (;;) {
    const fichiers = existsSync(quai) ? readdirSync(quai).filter((f) => f.endsWith('.txt')) : [];
    const prets = depotsPrets(fichiers.map((f) => lireDepot(f, readFileSync(join(quai, f), 'utf8'))));
    if (prets.length) {
      console.log(`Branches prêtes : ${prets.map((d) => d.branche).join(', ')}.`);
      return true;
    }
    await new Promise((fin) => setTimeout(fin, 60 * 1000));
  }
}

// Tant que le train vit : un passage toutes les 10 secondes. Le train fini, les priorités d'avant reviennent.
async function garderLaPriorite(pid) {
  const vivant = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (erreur) {
      return erreur.code === 'EPERM';
    }
  };
  const autres = arbresDuProjet(racinePrincipale());
  const retenues = new Map();
  while (vivant()) {
    const processus = processusDuPoste();
    if (processus) regler(processus, RACINE, retenues, { autres });
    await new Promise((fin) => setTimeout(fin, 10 * 1000));
  }
  rendreLesPriorites(retenues);
  return true;
}

async function principal([commande, ...reste]) {
  if (commande === 'conduire') return conduire(reste, lireFabrique());
  if (commande === 'veille') return veille(lireFabrique());
  if (commande === 'priorite') return garderLaPriorite(Number(reste[0]));
  console.error('Commande : conduire ou veille.');
  return false;
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) {
  try {
    process.exitCode = (await principal(process.argv.slice(2))) ? 0 : 1;
  } catch (erreur) {
    console.error(`Train arrêté : ${erreur.message}`);
    process.exitCode = 1;
  }
}
