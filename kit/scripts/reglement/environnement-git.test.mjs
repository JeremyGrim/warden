// En premier : les git de cette garde n'héritent pas non plus du dépôt qui la lance.
import './environnement-git.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Incident du 10 novembre 2026, dans le premier dépôt du kit : poussé depuis un arbre lié, le crochet de pré-push a
// lancé les tests avec un GIT_DIR absolu, et ceux qui créent leurs propres dépôts ont écrit dans le vrai
// (`core.bare = true`, trois commits « t »). Cette garde les relance avec GIT_DIR sur un témoin jetable : le témoin ne
// bouge pas, et les tests passent.

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_QUI_CREENT_DES_DEPOTS = ['scripts/reglement/disque.test.mjs', 'scripts/reglement/reglement.test.mjs', 'scripts/reglement/poussee.test.mjs'];

function git(cwd, ...args) {
  const sortie = spawnSync('git', ['-c', 'user.name=temoin', '-c', 'user.email=temoin@exemple.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(sortie.status, 0, sortie.stderr);
  return sortie.stdout.trim();
}

test('the_tests_that_create_repositories_never_write_into_an_inherited_GIT_DIR', (t) => {
  const bac = mkdtempSync(join(tmpdir(), 'temoin-git-'));
  t.after(() => rmSync(bac, { recursive: true, force: true }));
  git(bac, 'init', '-b', 'main', 'temoin');
  const temoin = join(bac, 'temoin');
  writeFileSync(join(temoin, 'temoin.txt'), 'témoin');
  git(temoin, 'add', '-A');
  git(temoin, 'commit', '-m', 'témoin');
  const gitDir = join(temoin, '.git');
  const config = readFileSync(join(gitDir, 'config'), 'utf8');
  const tete = git(temoin, 'rev-parse', 'HEAD');
  // L'enfant est un vrai lanceur de tests : sans NODE_TEST_CONTEXT, que le lanceur parent lui passerait.
  const { NODE_TEST_CONTEXT, ...sansContexte } = process.env;
  void NODE_TEST_CONTEXT;
  for (const fichier of TESTS_QUI_CREENT_DES_DEPOTS) {
    const sortie = spawnSync(process.execPath, ['--test', fichier], { cwd: RACINE, encoding: 'utf8', env: { ...sansContexte, GIT_DIR: gitDir } });
    assert.match(sortie.stdout, /ℹ pass [1-9]/, `${fichier} n'a pas tourné : ${sortie.stdout.slice(-800)}`);
    assert.equal(sortie.status, 0, `${fichier}, lancé avec GIT_DIR hérité : ${sortie.stdout.slice(-1500)}${sortie.stderr.slice(-500)}`);
    assert.equal(readFileSync(join(gitDir, 'config'), 'utf8'), config, `${fichier} a réécrit la configuration du témoin`);
    assert.equal(git(temoin, 'rev-parse', 'HEAD'), tete, `${fichier} a commité dans le témoin`);
    assert.equal(git(temoin, 'rev-list', '--all', '--count'), '1', `${fichier} a ajouté des commits au témoin`);
  }
});
