#!/usr/bin/env node
// L'épreuve du kit, de bout en bout, sur des projets vierges : le kit posé, des commits refusés, des poussées vérifiées
// et refusées, un train de branches dont une fautive. Rien n'est simulé : de vrais dépôts, de vrais crochets, Cargo et
// pnpm. Les projets vivent dans un dossier temporaire, retiré à la fin ; le rapport reste.
//
//   node outils/epreuve.mjs [--sortie <dossier>] [--garder]
//
// Le rapport : <sortie>/rapport.md et <sortie>/verdicts.json, et le journal de chaque pas dans <sortie>/journaux/.
// Un pas qui casse se dit en contrôle, et l'épreuve continue.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SORTIE = resolve(argv.includes('--sortie') ? argv[argv.indexOf('--sortie') + 1] : mkdtempSync(join(tmpdir(), 'epreuve-reglement-')));
const BAC = mkdtempSync(join(tmpdir(), 'epreuve-projets-'));
const { NODE_TEST_CONTEXT, ...ENV } = process.env;
void NODE_TEST_CONTEXT;
mkdirSync(join(SORTIE, 'journaux'), { recursive: true });

const controles = [];
let numero = 0;
let pasCourant = '';

function lancer(programme, args, cwd) {
  const shell = process.platform === 'win32' && ['pnpm', 'npm'].includes(programme);
  const ligne = shell ? [programme, ...args].join(' ') : programme;
  const r = spawnSync(ligne, shell ? [] : args, { cwd, encoding: 'utf8', env: ENV, shell, windowsHide: true, maxBuffer: 1 << 28 });
  numero += 1;
  const texte = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(SORTIE, 'journaux', `${String(numero).padStart(3, '0')}.txt`), `$ ${programme} ${args.join(' ')}\n(dans ${cwd})\n\n${texte}\ncode : ${r.status}\n`);
  return { status: r.status, texte, journal: `journaux/${String(numero).padStart(3, '0')}.txt` };
}

const git = (cwd, ...args) => lancer('git', args, cwd);
const node = (cwd, ...args) => lancer(process.execPath, args, cwd);

function controler(controle, ok, detail = '') {
  controles.push({ pas: pasCourant, controle, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✖'} [${pasCourant}] ${controle}${detail ? ` — ${detail}` : ''}`);
}

async function pas(nom, fonction) {
  pasCourant = nom;
  try {
    await fonction();
  } catch (erreur) {
    controler('le pas va au bout', false, erreur.message);
  }
}

function ecrire(racine, fichiers) {
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    mkdirSync(dirname(join(racine, chemin)), { recursive: true });
    writeFileSync(join(racine, chemin), contenu);
  }
}

// Le créneau se rend quand le distant porte le commit : on attend qu'il soit rendu avant la poussée suivante.
async function creneauRendu(racine) {
  const creneau = join(racine, '.travail', 'creneau-poussee-main');
  for (let n = 0; n < 60 && existsSync(creneau); n += 1) await new Promise((fin) => setTimeout(fin, 500));
  return !existsSync(creneau);
}

function nouveauDepot(nom, fichiers) {
  const racine = join(BAC, nom);
  const distant = join(BAC, `${nom}.git`);
  mkdirSync(racine);
  lancer('git', ['init', '--quiet', '--bare', '-b', 'main', distant], BAC);
  git(racine, 'init', '--quiet', '-b', 'main');
  for (const [cle, valeur] of [['user.name', 'epreuve'], ['user.email', 'epreuve@exemple.test'], ['commit.gpgsign', 'false']]) git(racine, 'config', cle, valeur);
  git(racine, 'remote', 'add', 'origin', distant);
  ecrire(racine, fichiers);
  return { racine, distant, tete: () => lancer('git', ['--git-dir', distant, 'rev-parse', 'refs/heads/main'], BAC).texte.trim() };
}

// Le projet tel qu'il était avant le kit : commité et poussé sans crochets, puis le kit posé et commité.
async function poserLeKit(projet, adapter) {
  const { racine } = projet;
  git(racine, 'add', '-A');
  git(racine, 'commit', '--quiet', '-m', 'Le projet, avant le règlement');
  git(racine, 'push', '--quiet', 'origin', 'main');
  const pose = node(racine, join(DEPOT, 'outils', 'poser.mjs'), racine);
  controler('la pose réussit', pose.status === 0, pose.journal);
  controler('le kit et ses modèles sont posés', ['scripts/reglement/kit.json', 'config/reglement.json', 'config/fabrique.json', '.githooks/pre-push', 'AGENTS.md'].every((c) => existsSync(join(racine, c))));
  adapter?.(racine);
  const regle = node(racine, 'scripts/reglement/reglement.mjs');
  controler('le projet posé respecte son règlement', regle.status === 0, regle.journal);
  git(racine, 'add', 'scripts/reglement', '.githooks', 'config', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.gitattributes');
  const commit = git(racine, 'commit', '--quiet', '-m', 'Le règlement du dépôt');
  controler('le commit du kit passe le crochet', commit.status === 0, commit.journal);
  const poussee = git(racine, 'push', 'origin', 'main');
  controler('la poussée du kit passe le crochet et arrive', poussee.status === 0 && projet.tete() === git(racine, 'rev-parse', 'HEAD').texte.trim(), poussee.journal);
  controler('le créneau est rendu', await creneauRendu(racine));
}

function commitRefuse(racine, chemin, contenu, regle) {
  ecrire(racine, { [chemin]: contenu });
  git(racine, 'add', chemin);
  const r = git(racine, 'commit', '--quiet', '-m', 'refusé');
  controler(`un commit est refusé : ${regle}`, r.status !== 0 && r.texte.includes(`[${regle}] ${chemin}`), r.journal);
  git(racine, 'reset', '--quiet', 'HEAD', '--', chemin);
  rmSync(join(racine, chemin), { force: true });
}

async function pousser(projet, message, attendu) {
  const { racine } = projet;
  git(racine, 'commit', '--quiet', '-am', message);
  const r = git(racine, 'push', 'origin', 'main');
  const arrive = projet.tete() === git(racine, 'rev-parse', 'HEAD').texte.trim();
  return { ...r, arrive, rendu: await creneauRendu(racine), attendu: attendu.every((m) => r.texte.includes(m)) };
}

// Le train : des arbres d'agents, chacun avec une branche et son dépôt au quai ; la fabrique conduit depuis la racine.
async function train(projet, branches) {
  const { racine } = projet;
  git(racine, 'fetch', '--quiet', 'origin');
  const quai = join(racine, '.travail', 'train-pret');
  mkdirSync(quai, { recursive: true });
  for (const { nom, fichiers, message } of branches) {
    const arbre = join(BAC, `${racine.split(/[\\/]/).pop()}-${nom}`);
    git(racine, 'worktree', 'add', '--quiet', '-b', nom, arbre, 'origin/main');
    ecrire(arbre, fichiers);
    git(arbre, 'add', '-A');
    const c = git(arbre, 'commit', '--quiet', '-m', message);
    controler(`la branche ${nom} se commite dans son arbre`, c.status === 0, c.journal);
    const d = new Date();
    writeFileSync(join(quai, `${nom}.txt`), `arbre = ${arbre}\nbranche = ${nom}\ntaches = ${nom.toUpperCase()}\ndepose = ${d.getDate()}/${d.getMonth() + 1} ${d.toTimeString().slice(0, 5)}\n`);
  }
  const avant = projet.tete();
  const r = node(racine, 'scripts/reglement/train.mjs', 'conduire', '--agent', 'fabrique');
  const apres = projet.tete();
  const montees = lancer('git', ['--git-dir', projet.distant, 'log', '--format=%s', `${avant}..${apres}`], BAC).texte.split('\n').filter(Boolean);
  return { ...r, montees, quai, rendu: await creneauRendu(racine) };
}

async function projetRustNode() {
  const projet = nouveauDepot('rust-node', {
    'Cargo.toml': '[workspace]\nmembers = ["crates/*", "apps/*"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'crates/coeur/Cargo.toml': '[package]\nname = "coeur"\nversion.workspace = true\nedition.workspace = true\npublish = false\n',
    'crates/coeur/src/lib.rs': 'pub fn double(x: i64) -> i64 {\n    x * 2\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn double() {\n        assert_eq!(super::double(2), 4);\n    }\n}\n',
    'crates/journal/Cargo.toml': '[package]\nname = "journal"\nversion.workspace = true\nedition.workspace = true\npublish = false\n',
    'crates/journal/src/lib.rs': 'pub fn ligne(texte: &str) -> String {\n    format!("- {texte}")\n}\n',
    'apps/outil/Cargo.toml': '[package]\nname = "outil"\nversion.workspace = true\nedition.workspace = true\npublish = false\n\n[dependencies]\ncoeur = { path = "../../crates/coeur" }\n',
    'apps/outil/src/main.rs': 'fn main() {\n    println!("{}", coeur::double(21));\n}\n',
    'package.json': `${JSON.stringify({ name: 'essai-rust-node', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test "web/**/*.test.mjs"' } }, null, 2)}\n`,
    'web/somme.mjs': 'export const somme = (a, b) => a + b;\n',
    'web/somme.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { somme } from './somme.mjs';\ntest('somme', () => assert.equal(somme(2, 2), 4));\n",
    'README.md': '# Essai Rust et Node\n',
    '.gitignore': 'target/\nnode_modules/\n',
  });
  const { racine } = projet;
  await pas('A. Projet Rust et Node : le poser', async () => {
    controler('Cargo écrit son verrou', lancer('cargo', ['generate-lockfile', '--offline'], racine).status === 0);
    controler('pnpm écrit son verrou', lancer('pnpm', ['install'], racine).status === 0 && existsSync(join(racine, 'pnpm-lock.yaml')));
    await poserLeKit(projet, (r) => {
      const regles = JSON.parse(readFileSync(join(r, 'config/reglement.json'), 'utf8'));
      controler('la pose lit une seule version dans les deux manifestes', regles.versions?.length === 2);
      regles.frontieres = { rust: { crates: { zones_interdites: ['apps'] } } };
      regles.binaire_de_test_unique = { zones: ['crates', 'apps'] };
      writeFileSync(join(r, 'config/reglement.json'), `${JSON.stringify(regles, null, 2)}\n`);
      const fabrique = JSON.parse(readFileSync(join(r, 'config/fabrique.json'), 'utf8'));
      controler('la pose règle Rust, les avis npm et l’installation pnpm', Boolean(fabrique.verification.rust && fabrique.verification.avis_npm && fabrique.train.installer));
      fabrique.train.fabriquer = { titre: 'Application', commande: ['cargo', 'build', '-p', 'outil'] };
      writeFileSync(join(r, 'config/fabrique.json'), `${JSON.stringify(fabrique, null, 2)}\n`);
    });
  });
  await pas('A. Commits refusés', async () => {
    commitRefuse(racine, 'crates/coeur/src/gros.rs', '// ligne\n'.repeat(701), 'lignes');
    commitRefuse(racine, 'web/chemin.mjs', `export const c = '${['C:', 'Users', 'quelqu_un', 'projet'].join('\\\\')}';\n`, 'secret');
  });
  await pas('A. Une frontière franchie, refusée à la poussée', async () => {
    ecrire(racine, {
      'apps/ecran/Cargo.toml': '[package]\nname = "ecran"\nversion.workspace = true\nedition.workspace = true\npublish = false\n',
      'apps/ecran/src/lib.rs': 'pub fn titre() -> &\'static str {\n    "écran"\n}\n',
      'crates/coeur/Cargo.toml': '[package]\nname = "coeur"\nversion.workspace = true\nedition.workspace = true\npublish = false\n\n[dependencies]\necran = { path = "../../apps/ecran" }\n',
    });
    lancer('cargo', ['generate-lockfile', '--offline'], racine);
    git(racine, 'add', '-A');
    const r = await pousser(projet, 'le cœur dépend d’un écran', []);
    controler('la poussée est refusée par la frontière', r.status !== 0 && /\[frontiere\] coeur : dépend de ecran \(apps\/\)/.test(r.texte) && !r.arrive, r.journal);
    git(racine, 'reset', '--quiet', '--hard', 'origin/main');
    git(racine, 'clean', '--quiet', '-fd', 'apps/ecran');
  });
  await pas('A. Une poussée vérifiée sur son périmètre Rust', async () => {
    ecrire(racine, { 'crates/coeur/src/lib.rs': 'pub fn double(x: i64) -> i64 {\n    x * 2\n}\n\npub fn triple(x: i64) -> i64 {\n    x * 3\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn double() {\n        assert_eq!(super::double(2), 4);\n    }\n\n    #[test]\n    fn triple() {\n        assert_eq!(super::triple(2), 6);\n    }\n}\n' });
    const r = await pousser(projet, 'triple', ['Clippy, sans avertissement', 'Tests de coeur', '2 paquet(s) Rust']);
    controler('clippy sur le paquet touché et son dépendant, puis ses tests, et la poussée arrive', r.status === 0 && r.attendu && r.arrive, r.journal);
    controler('le créneau est rendu', r.rendu);
  });
  await pas('A. Une poussée refusée par un test Rust, rejoué une fois', async () => {
    ecrire(racine, { 'crates/coeur/src/lib.rs': readFileSync(join(racine, 'crates/coeur/src/lib.rs'), 'utf8').replace('x * 3', 'x * 4') });
    const r = await pousser(projet, 'triple cassé', ['aussi au second essai']);
    controler('la poussée est refusée, le test rejoué une fois, rien n’arrive', r.status !== 0 && r.attendu && !r.arrive, r.journal);
    controler('le créneau est rendu tout de suite', r.rendu);
    git(racine, 'reset', '--quiet', '--hard', 'origin/main');
  });
  await pas('A. Un train de trois branches, dont une fautive', async () => {
    const r = await train(projet, [
      { nom: 'agent-a', message: 'produit', fichiers: { 'web/produit.mjs': 'export const produit = (a, b) => a * b;\n', 'web/produit.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { produit } from './produit.mjs';\ntest('produit', () => assert.equal(produit(2, 3), 6));\n" } },
      { nom: 'agent-b', message: 'moitié', fichiers: { 'crates/coeur/src/moitie.rs': 'pub fn moitie(x: i64) -> i64 {\n    x / 2\n}\n', 'crates/coeur/src/lib.rs': `pub mod moitie;\n\n${readFileSync(join(racine, 'crates/coeur/src/lib.rs'), 'utf8')}` } },
      { nom: 'agent-c', message: 'écart', fichiers: { 'web/ecart.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('écart', () => assert.equal(1, 2));\n" } },
    ]);
    controler('le train va au bout', r.status === 0, r.journal);
    controler('les deux branches saines montent, dans l’ordre', r.montees.join(',') === 'moitié,produit', r.montees.join(', '));
    controler('la fautive est laissée de côté, avec sa cause', r.texte.includes('Laissée de côté : agent-c') && /refuse = /.test(readFileSync(join(r.quai, 'agent-c.txt'), 'utf8')));
    controler('les dépôts montés sont retirés du quai', !existsSync(join(r.quai, 'agent-a.txt')) && !existsSync(join(r.quai, 'agent-b.txt')));
    controler('la fabrication se joue une fois par essai', r.texte.includes('✔ Application'));
    controler('le crochet ne revérifie pas ce que le train a vérifié', r.texte.includes('Déjà vérifié par le train'));
    controler('le créneau est rendu', r.rendu);
  });
}

async function projetNode() {
  const projet = nouveauDepot('node-seul', {
    'package.json': `${JSON.stringify({ name: 'essai-node', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test "src/**/*.test.mjs"' } }, null, 2)}\n`,
    'src/somme.mjs': 'export const somme = (a, b) => a + b;\n',
    'src/somme.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { somme } from './somme.mjs';\ntest('somme', () => assert.equal(somme(2, 2), 4));\n",
    'README.md': '# Essai Node\n',
    '.gitignore': 'node_modules/\n',
  });
  const { racine } = projet;
  await pas('B. Projet Node seul : le poser', async () => {
    controler('pnpm écrit son verrou', lancer('pnpm', ['install'], racine).status === 0 && existsSync(join(racine, 'pnpm-lock.yaml')));
    await poserLeKit(projet, (r) => {
      const fabrique = JSON.parse(readFileSync(join(r, 'config/fabrique.json'), 'utf8'));
      controler('la pose ne règle pas Rust, et règle les tests du projet', fabrique.verification.rust === null && fabrique.verification.etapes.some((e) => e.titre === 'Tests du projet'));
    });
  });
  await pas('B. Commits refusés', async () => {
    commitRefuse(racine, 'package-lock.json', '{}\n', 'gestionnaire');
    commitRefuse(racine, 'notes.txt', 'à la racine\n', 'racine');
  });
  await pas('B. Une poussée vérifiée, puis une refusée', async () => {
    ecrire(racine, { 'src/somme.mjs': 'export const somme = (a, b) => a + b;\nexport const reste = (a, b) => a - b;\n' });
    const ok = await pousser(projet, 'reste', ['Tests du projet']);
    controler('les tests du projet se jouent et la poussée arrive', ok.status === 0 && ok.attendu && ok.arrive && ok.rendu, ok.journal);
    ecrire(racine, { 'src/somme.mjs': 'export const somme = (a, b) => a - b;\n' });
    const ko = await pousser(projet, 'somme cassée', ['✖ Tests du projet']);
    controler('une étape en échec refuse la poussée, et rien n’arrive', ko.status !== 0 && ko.attendu && !ko.arrive && ko.rendu, ko.journal);
    git(racine, 'reset', '--quiet', '--hard', 'origin/main');
  });
  await pas('B. Un train de deux branches', async () => {
    const r = await train(projet, [
      { nom: 'agent-d', message: 'carré', fichiers: { 'src/carre.mjs': 'export const carre = (a) => a * a;\n' } },
      { nom: 'agent-e', message: 'cube', fichiers: { 'src/cube.mjs': 'export const cube = (a) => a * a * a;\n' } },
    ]);
    controler('le train monte les deux branches', r.status === 0 && r.montees.join(',') === 'cube,carré', `${r.montees.join(', ')} — ${r.journal}`);
    controler('le créneau est rendu', r.rendu);
  });
}

function rapport() {
  const echecs = controles.filter((c) => !c.ok);
  const lignes = [
    `# Épreuve du kit reglement-depot ${JSON.parse(readFileSync(join(DEPOT, '.claude-plugin', 'plugin.json'), 'utf8')).version}`,
    '',
    `${controles.length} contrôles, ${echecs.length} en échec. Node ${process.version}, ${process.platform}.`,
    '',
    '| Pas | Contrôle | Verdict | Détail |',
    '|---|---|---|---|',
    ...controles.map((c) => `| ${c.pas} | ${c.controle} | ${c.ok ? 'ok' : '**ÉCHEC**'} | ${c.detail} |`),
    '',
  ];
  writeFileSync(join(SORTIE, 'rapport.md'), lignes.join('\n'));
  writeFileSync(join(SORTIE, 'verdicts.json'), `${JSON.stringify(controles, null, 2)}\n`);
  console.log(`\n${controles.length} contrôles, ${echecs.length} en échec. Rapport : ${join(SORTIE, 'rapport.md')}`);
  return echecs.length === 0;
}

try {
  await projetRustNode();
  await projetNode();
} finally {
  const ok = rapport();
  if (!argv.includes('--garder')) rmSync(BAC, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  else appendFileSync(join(SORTIE, 'rapport.md'), `\nProjets gardés dans ${BAC}.\n`);
  process.exitCode = ok ? 0 : 1;
}
