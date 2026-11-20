// En premier : aucun git de ce test n'hérite du dépôt qui le lance.
import '../kit/scripts/reglement/environnement-git.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { empreinte } from '../kit/scripts/reglement/kit.mjs';
import { adapterFabrique, adapterReglement } from './poser.mjs';

const POSER = join(dirname(fileURLToPath(import.meta.url)), 'poser.mjs');
const MODELE_REGLEMENT = JSON.parse(readFileSync(join(dirname(POSER), '..', 'kit', 'config', 'reglement.json'), 'utf8'));
const MODELE_FABRIQUE = JSON.parse(readFileSync(join(dirname(POSER), '..', 'kit', 'config', 'fabrique.json'), 'utf8'));

function projet(t, fichiers) {
  const racine = mkdtempSync(join(tmpdir(), 'pose-'));
  t.after(() => rmSync(racine, { recursive: true, force: true }));
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: racine });
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    mkdirSync(dirname(join(racine, chemin)), { recursive: true });
    writeFileSync(join(racine, chemin), contenu);
  }
  const poser = (...args) => spawnSync(process.execPath, [POSER, racine, ...args], { encoding: 'utf8' });
  const lire = (chemin) => readFileSync(join(racine, chemin), 'utf8');
  return { racine, poser, lire };
}

const NODE = {
  'package.json': JSON.stringify({ name: 'essai', version: '0.2.0', scripts: { test: 'node --test', build: 'node build.mjs' } }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'src/a.mjs': 'export const a = 1;\n',
  'notes.txt': 'x\n',
};

test('la pose écrit le kit, ses modèles adaptés au projet, et active les crochets', (t) => {
  const { racine, poser, lire } = projet(t, NODE);
  const r = poser();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(racine, 'scripts/reglement/kit.json')));
  const regles = JSON.parse(lire('config/reglement.json'));
  assert.ok(regles.racine.dossiers.includes('src'));
  assert.ok(regles.racine.fichiers.includes('notes.txt') && regles.racine.fichiers.includes('pnpm-lock.yaml'));
  assert.match(r.stdout, /admis à la racine parce que présents.*src\/.*notes\.txt/);
  assert.ok(!regles.gestionnaires_interdits.includes('pnpm-lock.yaml'));
  const fabrique = JSON.parse(lire('config/fabrique.json'));
  assert.deepEqual(fabrique.verification.etapes.map((e) => e.commande), [['pnpm', 'test'], ['pnpm', 'run', 'build']]);
  assert.deepEqual(fabrique.train.installer, { verrou: 'pnpm-lock.yaml', commande: ['pnpm', 'install', '--frozen-lockfile'] });
  assert.match(lire('AGENTS.md'), new RegExp(`Règlement du dépôt ${racine.split(/[\\/]/).pop()}`));
  assert.match(lire('.gitignore'), /^\.travail\/$/m);
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: racine, encoding: 'utf8' }).stdout.trim(), '.githooks');
  const regle = spawnSync(process.execPath, ['scripts/reglement/reglement.mjs'], { cwd: racine, encoding: 'utf8' });
  assert.equal(regle.status, 0, `le projet posé respecte son règlement : ${regle.stderr}`);
});

test('une seconde pose garde les modèles et remplace le kit', (t) => {
  const { poser, lire } = projet(t, NODE);
  poser();
  const avant = lire('config/fabrique.json');
  const r = poser();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gardés tels quels : config\/reglement\.json, config\/fabrique\.json/);
  assert.equal(lire('config/fabrique.json'), avant);
});

test('un script du kit retouché, ou un fichier inconnu du kit, arrête la pose sans rien écrire', (t) => {
  const { racine, poser } = projet(t, NODE);
  poser();
  writeFileSync(join(racine, 'scripts/reglement/train.mjs'), '// retouché\n', { flag: 'a' });
  rmSync(join(racine, 'config/disque.json'));
  const r = poser();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /retouché : scripts\/reglement\/train\.mjs/);
  assert.ok(!existsSync(join(racine, 'config/disque.json')), 'rien n’est écrit');

  const { racine: autre, poser: poserAutre } = projet(t, NODE);
  poserAutre();
  writeFileSync(join(autre, 'scripts/reglement/a-moi.mjs'), '');
  const inconnu = poserAutre();
  assert.equal(inconnu.status, 1);
  assert.match(inconnu.stderr, /inconnu du kit : scripts\/reglement\/a-moi\.mjs/);
});

test('un fichier qu’une version précédente posait, et que celle-ci ne pose plus, se retire s’il n’est pas retouché', (t) => {
  const { racine, poser } = projet(t, NODE);
  poser();
  const manifeste = JSON.parse(readFileSync(join(racine, 'scripts/reglement/kit.json'), 'utf8'));
  writeFileSync(join(racine, 'scripts/reglement/ancien.mjs'), 'export {};\n');
  manifeste.fichiers['ancien.mjs'] = empreinte(Buffer.from('export {};\n'));
  manifeste.version = '0.0.1';
  writeFileSync(join(racine, 'scripts/reglement/kit.json'), JSON.stringify(manifeste));
  const r = poser();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0\.0\.1 → /);
  assert.ok(!existsSync(join(racine, 'scripts/reglement/ancien.mjs')));
});

test('le règlement adapté prend le gestionnaire présent et la version de chaque manifeste', (t) => {
  const { racine } = projet(t, {
    'package-lock.json': '{}',
    'package.json': JSON.stringify({ version: '1.0.0' }),
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.0.0"\n',
  });
  const { regles } = adapterReglement(MODELE_REGLEMENT, racine, { dossiers: ['crates', 'target'], fichiers: ['Cargo.toml', 'package-lock.json', 'package.json'] });
  assert.ok(!regles.gestionnaires_interdits.includes('package-lock.json') && regles.gestionnaires_interdits.includes('yarn.lock'));
  assert.ok(!regles.racine.dossiers.includes('target'), 'un dossier interdit n’est pas admis');
  assert.deepEqual(regles.versions, [{ fichier: 'package.json', lire: 'json:version' }, { fichier: 'Cargo.toml', lire: 'toml:workspace.package.version' }]);
  const fabrique = adapterFabrique(MODELE_FABRIQUE, racine, { dossiers: [], fichiers: ['Cargo.toml', 'package-lock.json', 'package.json'] }, { cargoDeny: true });
  assert.equal(fabrique.verification.rust.deny, 'config/deny.toml');
  assert.deepEqual(fabrique.train.installer.commande, ['npm', 'ci']);
  assert.equal(fabrique.verification.avis_npm, null, 'les avis du poste lisent un verrou pnpm seulement');
});
