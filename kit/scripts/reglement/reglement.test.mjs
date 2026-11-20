// En premier : aucun git de ce test n'hérite du dépôt qui le lance (environnement-git.mjs).
import './environnement-git.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compiler, compterLignes, frontieresNode, frontieresRust, lireVersion, verifierFichiers } from './reglement.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));

// Les règles de ces gardes sont les leurs : le kit se pose dans des projets qui ont chacun leur configuration.
const DONNEES = {
  racine: { dossiers: ['apps', 'crates', 'packages', 'vendor', 'docs', 'config', 'scripts', '.githooks'], fichiers: ['README.md', 'AGENTS.md', 'CLAUDE.md', 'Cargo.toml', 'Cargo.lock', 'package.json', 'pnpm-lock.yaml', '.gitignore'] },
  obligatoires: ['README.md', 'AGENTS.md', 'CLAUDE.md'],
  lignes_max: 700,
  lignes_avertissement: 650,
  lignes_exemptes: ['Cargo.lock', 'pnpm-lock.yaml'],
  taille_max_kio: 512,
  taille_exceptions: { 'Cargo.lock': 2048 },
  segments_interdits: ['target', 'node_modules', 'dist', '.input', '.travail', '.claude'],
  extensions_interdites: ['.exe', '.zip', '.pdf', '.log', '.png'],
  gestionnaires_interdits: ['package-lock.json', 'yarn.lock'],
  secrets: [
    { nom: 'clé privée', motif: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    { nom: 'jeton GitHub', motif: '\\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\\b' },
    { nom: 'clé Anthropic', motif: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b' },
    { nom: 'chemin de machine', motif: "\\b[A-Za-z]:[\\\\/]+Users[\\\\/]+(?![\\\\/])(?!personne[\\\\/])[^\\s\"'`]+|/home/(?!personne/)[a-z][a-z0-9_-]+/|/Users/(?!personne/)[A-Za-z][A-Za-z0-9._-]+/" },
  ],
  source_unique: { fichier: 'CLAUDE.md', renvoi: 'AGENTS.md', lignes_max: 3 },
  docs: { dossier: 'docs/', fichiers_max: 15, noms_interdits: ['^(CR|BRIEF|AUDIT|PLAN)[-_ .]', '\\d{8}', '\\d{4}-\\d{2}-\\d{2}'], statuts_interdits: 'statut\\s*:\\s*\\**\\s*(archiv|histori|informatif)' },
  versions: [{ fichier: 'package.json', lire: 'json:version' }, { fichier: 'Cargo.toml', lire: 'toml:workspace.package.version' }],
};
const REGLES = compiler(DONNEES);

const BASE = {
  'README.md': 'x\n',
  'AGENTS.md': 'x\n',
  'CLAUDE.md': 'Lire AGENTS.md\n',
  'package.json': JSON.stringify({ version: '1.0.0' }),
  'Cargo.toml': '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.0.0"\n',
};

function ecartsDe(ajouts = {}, retraits = [], regles = REGLES) {
  const depot = { ...BASE, ...ajouts };
  for (const chemin of retraits) delete depot[chemin];
  const lire = (chemin) => (chemin in depot ? Buffer.from(depot[chemin]) : null);
  return verifierFichiers({ fichiers: Object.keys(depot), regles, lire });
}

const reglesDe = (ecarts) => ecarts.map((e) => e.regle);
const avec = (sections) => compiler({ ...DONNEES, ...sections });

test('un dépôt minimal respecte le règlement', () => {
  assert.deepEqual(ecartsDe(), []);
});

test('une section absente ne se joue pas', () => {
  const vide = compiler({});
  assert.deepEqual(reglesDe(ecartsDe({ 'notes.txt': 'x\n'.repeat(5000), 'a/b.exe': 'x' }, [], vide)), []);
});

test('la racine est fermée', () => {
  assert.deepEqual(reglesDe(ecartsDe({ 'notes.txt': 'x' })), ['racine']);
  assert.deepEqual(reglesDe(ecartsDe({ 'outil-plugin/a.md': 'x' })), ['racine']);
  assert.deepEqual(reglesDe(ecartsDe({}, ['AGENTS.md'])), ['racine']);
});

test('les artefacts ne se versionnent pas', () => {
  assert.ok(reglesDe(ecartsDe({ 'scripts/target/a.txt': 'x' })).includes('artefact'));
  assert.ok(reglesDe(ecartsDe({ 'scripts/.input/a.txt': 'x' })).includes('artefact'));
  assert.ok(reglesDe(ecartsDe({ 'docs/rapport.pdf': 'x' })).includes('artefact'));
  assert.ok(reglesDe(ecartsDe({ 'scripts/app.exe': 'x' })).includes('artefact'));
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/build.rs': 'x' })), []);
});

test('la taille est plafonnée, avec des exceptions nommées', () => {
  const gros = 'x'.repeat(513 * 1024);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/gros.txt': gros })), ['taille']);
  assert.deepEqual(reglesDe(ecartsDe({ 'Cargo.lock': gros })), []);
});

test('un fichier fait 700 lignes au plus, et approche du plafond sans refus', () => {
  assert.equal(compterLignes(Buffer.from('a\nb')), 2);
  assert.equal(compterLignes(Buffer.from('a\nb\n')), 2);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': 'x\n'.repeat(700) })), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': 'x\n'.repeat(701) })), ['lignes']);
  assert.deepEqual(reglesDe(ecartsDe({ 'Cargo.lock': 'x\n'.repeat(9000) })), []);
  const avertis = [];
  const depot = { ...BASE, 'scripts/a.mjs': 'x\n'.repeat(651) };
  const ecarts = verifierFichiers({ fichiers: Object.keys(depot), regles: REGLES, avertir: (a) => avertis.push(a.chemin), lire: (c) => Buffer.from(depot[c]) });
  assert.deepEqual([reglesDe(ecarts), avertis], [[], ['scripts/a.mjs']]);
});

test('un seul gestionnaire de paquets', () => {
  assert.ok(reglesDe(ecartsDe({ 'packages/a/package-lock.json': '{}' })).includes('gestionnaire'));
});

test('aucun secret ni chemin de machine, sauf la personne fictive des tests', () => {
  const jeton = ['ghp', 'a'.repeat(36)].join('_');
  const cle = ['sk', 'ant', 'a'.repeat(30)].join('-');
  const chemin = ['C:', 'Users', 'quelqu_un', 'x'].join('\\');
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `const t = "${jeton}";` })), ['secret']);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `const t = "${cle}";` })), ['secret']);
  assert.deepEqual(reglesDe(ecartsDe({ 'docs/a.md': `voir ${chemin}\n` })), ['secret']);
  const double = ['C:', 'Users', 'quelqu_un', 'x'].join('\\\\');
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `const c = '${double}';` })), ['secret'], 'des séparateurs doublés, dans une chaîne de code');
  const fictif = ['C:', 'Users', 'personne', 'projet'];
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `"${fictif.join('\\')}"; "${fictif.join('/')}"; "/${fictif.slice(1).join('/')}/"` })), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `"${fictif.join('\\\\')}"` })), [], 'la personne fictive, séparateurs doublés');
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `"/${['Users', 'personne2', 'x'].join('/')}"` })), ['secret']);
});

test('une exception de secret vaut pour un fichier et un type', () => {
  const faux = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
  const regles = avec({ secrets_exceptions: { 'scripts/a.mjs': { 'clé privée': 'faux secret d’un test' } } });
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': faux }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/b.mjs': faux }, [], regles)), ['secret']);
  assert.deepEqual(reglesDe(ecartsDe({ 'scripts/a.mjs': `sk-ant-${'a'.repeat(24)}` }, [], regles)), ['secret']);
});

test('le code étranger échappe aux lignes et à la taille, pas aux secrets', () => {
  const regles = avec({ code_etranger: { 'vendor/lib/': 'correctif nommé' } });
  assert.deepEqual(reglesDe(ecartsDe({ 'vendor/lib/a.rs': 'x\n'.repeat(701) }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'vendor/lib/a.rs': 'y'.repeat(513 * 1024) }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'vendor/lib/a.rs': `sk-ant-${'a'.repeat(24)}` }, [], regles)), ['secret']);
});

test('docs/ parle au présent', () => {
  assert.deepEqual(reglesDe(ecartsDe({ 'docs/CR-lot3.md': 'x' })), ['present']);
  assert.deepEqual(reglesDe(ecartsDe({ 'docs/notes-20261105.md': 'x' })), ['present']);
  assert.deepEqual(reglesDe(ecartsDe({ 'docs/notes-2026-11-05.md': 'x' })), ['present']);
  assert.deepEqual(reglesDe(ecartsDe({ 'docs/vieux.md': '# Vieux\n\nStatut : historique\n' })), ['present']);
  assert.deepEqual(reglesDe(ecartsDe({ 'docs/planning.md': 'x' })), []);
  const beaucoup = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`docs/d${i}.md`, 'x']));
  assert.deepEqual(reglesDe(ecartsDe(beaucoup)), ['present']);
});

test('le fichier des agents d’un outil ne porte aucune règle', () => {
  assert.deepEqual(reglesDe(ecartsDe({ 'CLAUDE.md': 'Toujours tester.\n' })), ['source-unique']);
  assert.deepEqual(reglesDe(ecartsDe({ 'CLAUDE.md': 'AGENTS.md\na\nb\nc\n' })), ['source-unique']);
});

test('la version est la même partout, lue en JSON comme en TOML', () => {
  assert.deepEqual(reglesDe(ecartsDe({ 'package.json': JSON.stringify({ version: '2.0.0' }) })), ['version']);
  assert.equal(lireVersion('[package]\nname = "a"\nversion = "0.3.1"\n[dependencies]\nversion = "9"\n', 'toml:package.version'), '0.3.1');
  assert.equal(lireVersion('version = "1.2.3"\n[table]\nversion = "9"\n', 'toml:version'), '1.2.3');
  assert.equal(lireVersion('[workspace.package]\r\nversion = "4.0.0"\r\n', 'toml:workspace.package.version'), '4.0.0');
  assert.equal(lireVersion('{"outil":{"version":"5.0.0"}}', 'json:outil.version'), '5.0.0');
  assert.equal(lireVersion('[autre]\n', 'toml:package.version'), null);
});

test('tout élément d’une zone déclare sa provenance', () => {
  const regles = avec({ provenance: { fichier: 'config/provenance.json', zones: ['crates', 'vendor'] } });
  const fiche = (elements, sources = {}) => ({ 'config/provenance.json': JSON.stringify({ sources, elements }) });
  const crate = { 'crates/a/Cargo.toml': 'x', 'crates/a/src/lib.rs': 'x' };
  assert.deepEqual(reglesDe(ecartsDe(crate, [], regles)), ['provenance']);
  assert.deepEqual(reglesDe(ecartsDe({ ...crate, ...fiche({ 'crates/a': { origine: 'neuf' } }) }, [], regles)), []);
  const source = { amont: 'https://exemple.test/amont.git' };
  assert.deepEqual(reglesDe(ecartsDe({ ...crate, ...fiche({ 'crates/a': { origine: 'amont', revision: 'abc', chemin: 'crates/a' } }, source) }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ ...crate, ...fiche({ 'crates/a': { origine: 'amont' } }, source) }, [], regles)), ['provenance']);
  assert.deepEqual(reglesDe(ecartsDe(fiche({ 'crates/absent': { origine: 'neuf' } }), [], regles)), ['provenance']);
});

test('tout composant a sa place au registre, et le registre ne nomme que ce qui existe', () => {
  const regles = avec({ registre: { fichier: 'config/registre.json', zones: ['crates', 'packages'] } });
  const registre = (categories) => ({ 'config/registre.json': JSON.stringify({ categories }) });
  const depot = { 'crates/a/Cargo.toml': 'x', 'packages/b/package.json': '{}' };
  assert.deepEqual(reglesDe(ecartsDe({ ...depot, ...registre({ socle: ['crates/a'], banc: ['packages/b'] }) }, [], regles)), []);
  const manque = ecartsDe({ ...depot, ...registre({ socle: ['crates/a'] }) }, [], regles);
  assert.deepEqual([reglesDe(manque), manque[0].chemin], [['registre'], 'packages/b']);
  const absent = ecartsDe({ ...depot, ...registre({ socle: ['crates/a', 'packages/b', 'crates/parti'] }) }, [], regles);
  assert.deepEqual([reglesDe(absent), absent[0].chemin], [['registre'], 'crates/parti']);
});

test('une dette ne vit que dans son fichier, et son fichier ne grandit pas', () => {
  const regles = avec({ dettes: [{ nom: 'mocks', racine: 'apps/front/', motif: '(mock|fixture)', fichier: 'apps/front/src/mocks.ts', ne_grandit_pas: true }] });
  assert.deepEqual(reglesDe(ecartsDe({ 'apps/front/src/mocks.ts': 'x\n' }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'apps/front/src/ecran/fixtures.ts': 'x\n' }, [], regles)), ['dette']);
  const depot = { ...BASE, 'apps/front/src/mocks.ts': 'a\nb\nc\n' };
  const juger = (avant) => reglesDe(verifierFichiers({ fichiers: Object.keys(depot), regles, lire: (c) => Buffer.from(depot[c]), lireAvant: (c) => (c === 'apps/front/src/mocks.ts' ? Buffer.from(avant) : null) }));
  assert.deepEqual(juger('a\nb\n'), ['dette'], 'elle a grandi');
  assert.deepEqual(juger('a\nb\nc\nd\n'), [], 'elle a diminué');
});

test('un passage obligé refuse ce qui est écrit en dur dans sa zone, sauf exception nommée', () => {
  const regles = avec({ passages: [{ nom: 'couleur', zones: ['apps/front/src/'], extensions: ['.tsx'], motif: '#[0-9a-fA-F]{6}\\b', message: 'une couleur se lit dans les jetons', exceptions: { 'apps/front/src/jetons.tsx': 'la source des jetons' } }] });
  const ecarts = ecartsDe({ 'apps/front/src/Bouton.tsx': 'color: "#ff0000"' }, [], regles);
  assert.deepEqual(reglesDe(ecarts), ['passage']);
  assert.match(ecarts[0].message, /jetons/);
  assert.deepEqual(reglesDe(ecartsDe({ 'apps/front/src/jetons.tsx': '#ff0000' }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'apps/front/src/style.css': '#ff0000' }, [], regles)), [], 'une autre extension');
  assert.deepEqual(reglesDe(ecartsDe({ 'apps/autre/a.tsx': '#ff0000' }, [], regles)), [], 'hors de la zone');
});

test('un seul binaire de test par crate', () => {
  const regles = avec({ binaire_de_test_unique: { zones: ['crates'] } });
  assert.deepEqual(reglesDe(ecartsDe({ 'crates/a/tests/tout/main.rs': 'x', 'crates/a/tests/tout/contrats.rs': 'x' }, [], regles)), []);
  assert.deepEqual(reglesDe(ecartsDe({ 'crates/a/tests/un.rs': 'x', 'crates/a/tests/deux.rs': 'x' }, [], regles)), ['disque']);
  assert.deepEqual(reglesDe(ecartsDe({ 'crates/a/src/x/tests/un.rs': 'x', 'crates/a/src/x/tests/deux.rs': 'x' }, [], regles)), [], 'un dossier tests/ dans src/ ne fait pas de binaire');
});

function metadata({ resolu }) {
  const paquet = (id, name, manifest_path, source = null, dependencies = []) => ({ id, name, manifest_path, source, dependencies });
  return {
    workspace_root: 'C:\\r',
    workspace_members: ['coeur', 'mod', 'app'],
    packages: [
      paquet('coeur', 'coeur', 'C:\\r\\crates\\coeur\\Cargo.toml', null, [{ name: 'mod', path: 'C:\\r\\modules\\mod' }]),
      paquet('mod', 'mod', 'C:\\r\\modules\\mod\\Cargo.toml'),
      paquet('app', 'app', 'C:\\r\\apps\\app\\Cargo.toml'),
      paquet('tiers', 'tiers', 'C:\\cache\\tiers\\Cargo.toml', 'registry'),
      paquet('tauri', 'tauri-runtime', 'C:\\cache\\tauri\\Cargo.toml', 'registry'),
    ],
    resolve: resolu ? { nodes: [{ id: 'coeur', dependencies: ['tiers'] }, { id: 'tiers', dependencies: ['tauri'] }, { id: 'mod', dependencies: [] }, { id: 'app', dependencies: ['coeur', 'mod', 'tauri'] }] } : null,
  };
}
const ZONES_RUST = { crates: { zones_interdites: ['modules', 'apps'], paquets_interdits: ['tauri*'] } };

test('Rust : le cœur ne dépend d’aucun hôte, même par transitivité, ni d’un module', () => {
  const transitif = frontieresRust(metadata({ resolu: true }), ZONES_RUST);
  assert.deepEqual(transitif.map((e) => e.chemin), ['coeur']);
  assert.match(transitif[0].message, /tauri-runtime/);
  const direct = frontieresRust(metadata({ resolu: false }), ZONES_RUST);
  assert.match(direct[0].message, /modules\//);
  const linux = JSON.parse(JSON.stringify(metadata({ resolu: true })).replaceAll('C:\\\\', '/').replaceAll('\\\\', '/'));
  assert.deepEqual(frontieresRust(linux, ZONES_RUST).map((e) => e.chemin), ['coeur'], 'les chemins Linux comme Windows');
});

test('une exception de frontière ne fait que raccourcir', () => {
  const zones = { modules: { directes_interdites: [{ paquet: 'plateforme', raison: 'pourquoi', sauf: ['ancien', 'libere'] }] } };
  const module = (nom, dependencies) => ({ id: nom, name: nom, manifest_path: `/r/modules/${nom}/Cargo.toml`, source: null, dependencies });
  const plateforme = { name: 'plateforme', path: '/r/crates/plateforme' };
  const meta = { workspace_root: '/r', workspace_members: ['propre', 'revenu', 'ancien', 'libere'], resolve: null, packages: [module('propre', []), module('revenu', [plateforme]), module('ancien', [plateforme]), module('libere', [])] };
  const ecarts = frontieresRust(meta, zones);
  assert.deepEqual(ecarts.map((e) => e.chemin), ['revenu', 'libere']);
  assert.match(ecarts[1].message, /retirer son exception/);
});

test('Node : une zone n’atteint pas une zone interdite, même par un autre paquet de l’espace', () => {
  const manifestes = {
    'package.json': JSON.stringify({ name: 'racine', devDependencies: { outils: '*' } }),
    'packages/coeur/package.json': JSON.stringify({ name: 'coeur', dependencies: { utile: 'workspace:*', 'electron-tiers': '1' } }),
    'packages/utile/package.json': JSON.stringify({ name: 'utile', dependencies: { ecran: 'workspace:*' } }),
    'apps/ecran/package.json': JSON.stringify({ name: 'ecran' }),
  };
  const ecarts = frontieresNode(manifestes, { packages: { zones_interdites: ['apps'], paquets_interdits: ['electron*'] } });
  assert.deepEqual(ecarts.map((e) => `${e.chemin} ${e.message}`).sort(), [
    'coeur dépend de ecran (apps/), interdit depuis packages/',
    'coeur dépend de electron-tiers, interdit depuis packages/',
    'utile dépend de ecran (apps/), interdit depuis packages/',
  ]);
});

test('le crochet de commit bloque un écart et laisse passer le reste', () => {
  const depot = mkdtempSync(join(tmpdir(), 'reglement-'));
  try {
    mkdirSync(join(depot, 'scripts', 'reglement'), { recursive: true });
    mkdirSync(join(depot, 'config'));
    for (const f of ['reglement.mjs', 'controles.mjs', 'frontieres.mjs', 'config.mjs']) cpSync(join(KIT, f), join(depot, 'scripts', 'reglement', f));
    writeFileSync(join(depot, 'config', 'reglement.json'), JSON.stringify(DONNEES));
    for (const [chemin, contenu] of Object.entries(BASE)) writeFileSync(join(depot, chemin), contenu);

    const git = (...args) => spawnSync('git', args, { cwd: depot, encoding: 'utf8' });
    const controle = () => spawnSync(process.execPath, ['scripts/reglement/reglement.mjs', '--index'], { cwd: depot, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('add', '-A');
    assert.equal(controle().status, 0, controle().stderr);

    writeFileSync(join(depot, 'capture.png'), 'x');
    git('add', 'capture.png');
    const refus = controle();
    assert.equal(refus.status, 1);
    assert.match(refus.stderr, /capture\.png/);
  } finally {
    rmSync(depot, { recursive: true, force: true });
  }
});
