// En premier : aucun git de ce test n'hérite du dépôt qui le lance (environnement-git.mjs).
import './environnement-git.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Le parcours des crochets dans un projet jetable : un commit refusé par le règlement, une poussée vérifiée sur son
// périmètre, une poussée refusée par une étape du projet, et le créneau rendu à chaque fois.

const KIT = dirname(fileURLToPath(import.meta.url));
const RACINE_DU_KIT = join(KIT, '..', '..');

const CROCHET_COMMIT = '#!/bin/sh\nexec node scripts/reglement/reglement.mjs --index\n';
const CROCHET_POUSSEE = [
  '#!/bin/sh',
  'envoi=$(cat)',
  'node scripts/reglement/reglement.mjs || exit 1',
  'node --test "scripts/**/*.test.mjs" || exit 1',
  'node scripts/reglement/disque.mjs garde --avertir',
  "printf '%s\\n' \"$envoi\" | node scripts/reglement/verifier.mjs poussee",
  '',
].join('\n');

function projet(t) {
  const bac = mkdtempSync(join(tmpdir(), 'poussee-'));
  t.after(() => rmSync(bac, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  const depot = join(bac, 'projet');
  const distant = join(bac, 'distant.git');
  // Les crochets lancent leurs propres `node --test` : sans le contexte du lanceur parent, qui leur ferait tout sauter.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  void NODE_TEST_CONTEXT;
  const git = (...args) => spawnSync('git', args, { cwd: depot, encoding: 'utf8', env });
  mkdirSync(join(depot, 'scripts', 'reglement'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '--bare', '-b', 'main', distant]);
  git('init', '--quiet', '-b', 'main');
  for (const [cle, valeur] of [['user.name', 'essai'], ['user.email', 'essai@exemple.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.githooks']]) git('config', cle, valeur);
  git('remote', 'add', 'origin', distant);

  for (const nom of readdirSync(KIT).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(KIT, nom), join(depot, 'scripts', 'reglement', nom));
  const ecrire = (chemin, contenu) => {
    mkdirSync(dirname(join(depot, chemin)), { recursive: true });
    writeFileSync(join(depot, chemin), contenu);
  };
  ecrire('.githooks/pre-commit', CROCHET_COMMIT);
  ecrire('.githooks/pre-push', CROCHET_POUSSEE);
  for (const crochet of ['pre-commit', 'pre-push']) chmodSync(join(depot, '.githooks', crochet), 0o755);
  ecrire('config/reglement.json', JSON.stringify({
    racine: { dossiers: ['src', 'config', 'scripts', '.githooks'], fichiers: ['README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore'] },
    obligatoires: ['AGENTS.md'],
    lignes_max: 700,
    segments_interdits: ['.travail'],
  }));
  ecrire('config/fabrique.json', JSON.stringify({ verification: { etapes: [{ titre: 'Tests du projet', si: ['^src/'], commande: ['node', '--test', 'src/**/*.test.mjs'] }] } }));
  ecrire('config/disque.json', JSON.stringify({ espace_libre_min_gio: 0, build_max_gio: 1000, incremental_max_gio: 1000, arbres_max: 2, arbre_age_max_jours: 7 }));
  ecrire('.gitignore', '.travail/\n');
  ecrire('README.md', 'Projet d’essai.\n');
  ecrire('AGENTS.md', 'Les règles.\n');
  ecrire('CLAUDE.md', 'Lire AGENTS.md\n');
  ecrire('scripts/garde.test.mjs', "import { test } from 'node:test';\ntest('garde', () => {});\n");
  ecrire('src/somme.mjs', 'export const somme = (a, b) => a + b;\n');
  ecrire('src/somme.test.mjs', "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { somme } from './somme.mjs';\ntest('somme', () => assert.equal(somme(2, 2), 4));\n");
  mkdirSync(join(depot, '.travail'));
  const creneau = join(depot, '.travail', 'creneau-poussee-main');
  const teteDistante = () => spawnSync('git', ['--git-dir', distant, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
  return { depot, git, ecrire, creneau, teteDistante };
}

// Le créneau se rend quand le distant porte le commit : un processus détaché le relève toutes les 2 s.
async function creneauRendu(creneau) {
  for (let n = 0; n < 60 && existsSync(creneau); n += 1) await new Promise((fin) => setTimeout(fin, 500));
  return !existsSync(creneau);
}

test('les crochets refusent un écart au commit, vérifient la poussée, et rendent le créneau', async (t) => {
  const { depot, git, ecrire, creneau, teteDistante } = projet(t);
  git('add', '-A');
  const premier = git('commit', '--quiet', '-m', 'premier');
  assert.equal(premier.status, 0, premier.stderr + premier.stdout);

  ecrire('notes.txt', 'à la racine\n');
  git('add', 'notes.txt');
  const refuse = git('commit', '--quiet', '-m', 'refusé');
  assert.notEqual(refuse.status, 0, 'un fichier non admis à la racine ne se commite pas');
  assert.match(refuse.stderr, /\[racine\] notes\.txt/);
  git('rm', '--quiet', '--cached', 'notes.txt');
  rmSync(join(depot, 'notes.txt'));

  const poussee = git('push', '--quiet', 'origin', 'main');
  assert.equal(poussee.status, 0, poussee.stderr + poussee.stdout);
  assert.match(poussee.stdout + poussee.stderr, /Tests du projet/, 'l’étape du projet s’est jouée');
  assert.equal(teteDistante(), git('rev-parse', 'HEAD').stdout.trim());
  assert.ok(await creneauRendu(creneau), 'le créneau se rend une fois le commit arrivé');

  ecrire('src/somme.mjs', 'export const somme = (a, b) => a - b;\n');
  git('commit', '--quiet', '-am', 'cassé');
  const avant = teteDistante();
  const echec = git('push', '--quiet', 'origin', 'main');
  assert.notEqual(echec.status, 0, 'une étape en échec refuse la poussée');
  assert.match(echec.stdout + echec.stderr, /✖ Tests du projet/);
  assert.equal(teteDistante(), avant, 'rien n’est arrivé sur le distant');
  assert.ok(!existsSync(creneau), 'le créneau est rendu tout de suite après un refus');

  ecrire('src/somme.mjs', 'export const somme = (a, b) => a + b;\n');
  git('commit', '--quiet', '-am', 'réparé');
  const reparee = git('push', '--quiet', 'origin', 'main');
  assert.equal(reparee.status, 0, reparee.stderr + reparee.stdout);
  assert.ok(await creneauRendu(creneau));
  assert.match(readFileSync(join(RACINE_DU_KIT, 'scripts', 'reglement', 'verifier.mjs'), 'utf8'), /reglement-train-verifie/, 'le témoin du train est celui du kit');
});
