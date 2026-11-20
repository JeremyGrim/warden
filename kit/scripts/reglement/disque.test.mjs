// En premier : aucun git de ce test n'hérite du dépôt qui le lance (environnement-git.mjs).
import './environnement-git.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  GIO, arbreTenu, arbresDeTravail, ciblePartagee, compilationDansLArbre, evaluer, jetables, lisible, mesurer, nettoyer, nettoyerBuild,
  cachesPartages, raisonDeRefus, verrousDeCargo, verrousTenus,
} from './disque.mjs';

const TYPE_LIEN = process.platform === 'win32' ? 'junction' : 'dir';
const BUDGETS = { espace_libre_min_gio: 0, build_max_gio: 1000, incremental_max_gio: 1000, arbres_max: 1, arbre_age_max_jours: 7 };

function bac(t) {
  const dossier = mkdtempSync(join(tmpdir(), 'disque-'));
  t.after(() => rmSync(dossier, { recursive: true, force: true }));
  return dossier;
}

function ecrire(chemin, octets = 10) {
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, Buffer.alloc(octets));
}

function lier(cible, lien) {
  mkdirSync(dirname(lien), { recursive: true });
  symlinkSync(cible, lien, TYPE_LIEN);
}

function arbreDeBuild(racine) {
  ecrire(join(racine, 'target/debug/deps/a.rlib'), 100);
  ecrire(join(racine, 'target/debug/incremental/a/b.bin'), 200);
  ecrire(join(racine, 'target/x86_64-pc/debug/incremental/c.bin'), 50);
  ecrire(join(racine, 'target/tmp/t.bin'), 5);
  ecrire(join(racine, 'node_modules/.cache/n.bin'), 7);
  ecrire(join(racine, 'node_modules/paquet/index.js'), 30);
}

test('lisible parle en unités binaires', () => {
  assert.equal(lisible(512), '512 o');
  assert.equal(lisible(2048), '2.0 Kio');
  assert.equal(lisible(3 * GIO), '3.0 Gio');
});

test('mesurer ne traverse jamais un lien', async (t) => {
  const racine = bac(t);
  ecrire(join(racine, 'dehors/gros.bin'), 1000);
  ecrire(join(racine, 'dedans/a.bin'), 10);
  lier(join(racine, 'dehors'), join(racine, 'dedans/lien'));
  const mesure = await mesurer(join(racine, 'dedans'));
  assert.equal(mesure.octets, 10);
  assert.equal(mesure.fichiers, 1);
  assert.equal(mesure.liens.length, 1);
});

test('mesurer un dossier absent donne zéro', async (t) => {
  assert.equal((await mesurer(join(bac(t), 'absent'))).octets, 0);
});

test('jetables désigne ce qui se régénère vite, et rien d’autre', async (t) => {
  const racine = bac(t);
  arbreDeBuild(racine);
  const noms = (await jetables(racine)).map((c) => c.slice(racine.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(noms, ['node_modules/.cache', 'target/debug/incremental', 'target/tmp', 'target/x86_64-pc/debug/incremental']);
});

test('nettoyer simule par défaut', async (t) => {
  const racine = bac(t);
  arbreDeBuild(racine);
  const vu = await nettoyer({ racine });
  assert.equal(vu.reduce((somme, r) => somme + r.octets, 0), 262);
  assert.ok(vu.every((r) => !r.retire && !r.refus));
  assert.ok(existsSync(join(racine, 'target/debug/incremental/a/b.bin')));
});

test('nettoyer applique sur les jetables et garde les dépendances', async (t) => {
  const racine = bac(t);
  arbreDeBuild(racine);
  await nettoyer({ racine, appliquer: true });
  assert.ok(!existsSync(join(racine, 'target/debug/incremental')));
  assert.ok(!existsSync(join(racine, 'target/x86_64-pc/debug/incremental')));
  assert.ok(!existsSync(join(racine, 'node_modules/.cache')));
  assert.ok(existsSync(join(racine, 'target/debug/deps/a.rlib')));
  assert.ok(existsSync(join(racine, 'node_modules/paquet/index.js')));
});

test('profond retire le build entier, seulement si on applique', async (t) => {
  const racine = bac(t);
  arbreDeBuild(racine);
  await nettoyer({ racine, profond: true });
  assert.ok(existsSync(join(racine, 'target/debug/deps/a.rlib')));
  await nettoyer({ racine, profond: true, appliquer: true });
  assert.ok(!existsSync(join(racine, 'target')));
  assert.ok(!existsSync(join(racine, 'node_modules')));
});

test('une compilation ne retient que son arbre, pas les autres arbres du poste', () => {
  const racine = process.platform === 'win32' ? 'E:\\arbres\\projet-e2' : '/arbres/projet-e2';
  const autre = racine.replace('e2', 'e1');
  const rustc = (arbre) => ({ nom: 'rustc.exe', ligne: `rustc --crate-name a --out-dir ${join(arbre, 'target', 'debug', 'deps')}`, dossier: '' });
  assert.equal(compilationDansLArbre(racine, [rustc(autre), { nom: 'cargo.exe', ligne: 'cargo check', dossier: '' }]), null);
  assert.equal(compilationDansLArbre(racine, [rustc(`${racine}-bis`)]), null, 'un arbre au nom voisin n’est pas celui-ci');
  assert.equal(compilationDansLArbre(racine, [rustc(racine)])?.nom, 'rustc.exe');
  assert.equal(compilationDansLArbre(racine, [{ nom: 'cargo', ligne: 'cargo test', dossier: `${racine}/crates/a` }])?.nom, 'cargo');
  assert.equal(compilationDansLArbre(racine, [{ nom: 'Code.exe', ligne: `code ${racine}`, dossier: '' }]), null, 'un éditeur n’est pas une compilation');
  const test = { nom: 'tout-1f2e.exe', ligne: 'tout-1f2e.exe b03', executable: join(racine, 'target', 'debug', 'deps', 'tout-1f2e.exe') };
  assert.equal(compilationDansLArbre(racine, [test])?.nom, 'tout-1f2e.exe', 'un test lancé depuis l’arbre le tient');
  assert.equal(compilationDansLArbre(autre, [test]), null);
});

// Un autre processus prend le verrou comme Cargo le fait, et le tient jusqu'à ce qu'on le lâche.
function tenirLeVerrou(t, fichier) {
  const script = process.platform === 'win32'
    ? `$s = [IO.File]::Open('${fichier}', 'Open', 'ReadWrite', 'ReadWrite, Delete'); $s.Lock(0, 1); 'pret'; [Console]::In.ReadLine() | Out-Null`
    : null;
  const enfant = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    : spawn('flock', [fichier, 'sh', '-c', 'echo pret; read ligne']);
  t.after(() => {
    enfant.stdin.end('\n');
    enfant.kill();
  });
  return new Promise((pret, echec) => {
    enfant.on('error', echec);
    enfant.stdout.on('data', (morceau) => String(morceau).includes('pret') && pret());
  });
}

test('un verrou de Cargo tenu retient son arbre, et lui seul', { skip: process.platform === 'darwin' && 'flock absent' }, async (t) => {
  const bacs = bac(t);
  const tenu = join(bacs, 'e2');
  const libre = join(bacs, 'e1');
  for (const arbre of [tenu, libre]) {
    arbreDeBuild(arbre);
    ecrire(join(arbre, 'target/debug/.cargo-lock'), 0);
    ecrire(join(arbre, 'target/x86_64-pc/release/.cargo-build-lock'), 0);
  }
  assert.equal((await verrousDeCargo(join(tenu, 'target'))).length, 2);
  assert.deepEqual(verrousTenus(await verrousDeCargo(join(tenu, 'target'))), [], 'un verrou posé mais lâché ne retient rien');
  await tenirLeVerrou(t, join(tenu, 'target/x86_64-pc/release/.cargo-build-lock'));
  assert.match(await arbreTenu(tenu, []), /Cargo y tient target[\\/]x86_64-pc[\\/]release[\\/]\.cargo-build-lock/);
  assert.equal(await arbreTenu(libre, []), null, 'le build d’un autre arbre ne retient pas celui-ci');
});

test('profond ne retire rien d’un build qu’un programme lancé tient ouvert', { skip: process.platform !== 'win32' && 'seul Windows refuse de renommer un dossier tenu' }, async (t) => {
  const racine = bac(t);
  arbreDeBuild(racine);
  ecrire(join(racine, 'target/debug/app.exe'), 0);
  const verrou = openSync(join(racine, 'target/debug/app.exe'), 'r');
  t.after(() => closeSync(verrou));
  const vu = await nettoyer({ racine, profond: true, appliquer: true });
  const build = vu.find((r) => r.cible.endsWith('target'));
  assert.match(build.refus, /tenu par un processus/);
  assert.equal(build.retire, false);
  assert.ok(existsSync(join(racine, 'target/debug/deps/a.rlib')), 'le build tenu reste entier');
  assert.ok(!existsSync(join(racine, 'node_modules')), 'ce qui n’est pas tenu part quand même');
  assert.deepEqual(readdirSync(racine).filter((nom) => nom.includes('a-supprimer')), [], 'rien n’est laissé à moitié');
});

test('un target qui est un lien vers ailleurs n’est jamais vidé', async (t) => {
  const bacs = bac(t);
  const racine = join(bacs, 'arbre');
  const ailleurs = join(bacs, 'target-partage');
  arbreDeBuild(ailleurs);
  mkdirSync(racine);
  lier(join(ailleurs, 'target'), join(racine, 'target'));

  for (const profond of [false, true]) {
    const vu = await nettoyer({ racine, profond, appliquer: true });
    assert.ok(vu.length > 0);
    assert.ok(vu.every((r) => !r.retire && r.refus));
  }
  assert.ok(existsSync(join(ailleurs, 'target/debug/incremental/a/b.bin')));
  assert.ok(existsSync(join(ailleurs, 'target/debug/deps/a.rlib')));
});

test('une cible qui contient un lien n’est pas retirée', async (t) => {
  const racine = bac(t);
  ecrire(join(racine, 'precieux/garde.bin'), 10);
  ecrire(join(racine, 'target/debug/incremental/a.bin'), 10);
  lier(join(racine, 'precieux'), join(racine, 'target/debug/incremental/lien'));
  const [resultat] = await nettoyer({ racine, appliquer: true });
  assert.equal(resultat.retire, false);
  assert.match(resultat.refus, /lien/);
  assert.ok(existsSync(join(racine, 'precieux/garde.bin')));
  assert.ok(existsSync(join(racine, 'target/debug/incremental/a.bin')));
});

test('un build hors dépôt se traite de la même façon', async (t) => {
  const bacs = bac(t);
  const build = join(bacs, 'cibles/projet-main');
  ecrire(join(build, 'debug/deps/a.rlib'), 100);
  ecrire(join(build, 'debug/incremental/a.bin'), 200);

  const simulation = await nettoyerBuild({ build });
  assert.equal(simulation.reduce((s, r) => s + r.octets, 0), 200);
  assert.ok(existsSync(join(build, 'debug/incremental/a.bin')));

  await nettoyerBuild({ build, appliquer: true });
  assert.ok(!existsSync(join(build, 'debug/incremental')));
  assert.ok(existsSync(join(build, 'debug/deps/a.rlib')));

  await nettoyerBuild({ build, profond: true, appliquer: true });
  assert.ok(!existsSync(build));
});

test('un build hors dépôt qui est un lien n’est pas vidé', async (t) => {
  const bacs = bac(t);
  ecrire(join(bacs, 'vrai/debug/incremental/a.bin'), 10);
  lier(join(bacs, 'vrai'), join(bacs, 'cibles/lien'));
  const [resultat] = await nettoyerBuild({ build: join(bacs, 'cibles/lien'), profond: true, appliquer: true });
  assert.equal(resultat.retire, false);
  assert.ok(resultat.refus);
  assert.ok(existsSync(join(bacs, 'vrai/debug/incremental/a.bin')));
});

test('raisonDeRefus refuse ce qui sort de la racine', async (t) => {
  const racine = bac(t);
  ecrire(join(racine, 'a/b.bin'));
  assert.equal(await raisonDeRefus(racine, join(racine, 'a')), null);
  assert.equal(await raisonDeRefus(racine, racine), 'hors de la racine');
  assert.equal(await raisonDeRefus(join(racine, 'a'), racine), 'hors de la racine');
  assert.equal(await raisonDeRefus(racine, join(racine, 'absent')), 'absent');
});

function depotAvecArbre(t) {
  const bacs = bac(t);
  const racine = join(bacs, 'depot');
  const distant = join(bacs, 'distant.git');
  const arbre = join(bacs, 'arbre');
  mkdirSync(racine);
  const git = (cwd, ...args) => {
    const sortie = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@exemple.test', ...args], { cwd, encoding: 'utf8' });
    assert.equal(sortie.status, 0, sortie.stderr);
  };
  git(racine, 'init', '-b', 'main');
  writeFileSync(join(racine, 'a.txt'), 'a');
  git(racine, 'add', '-A');
  git(racine, 'commit', '-m', 'a');
  git(bacs, 'init', '--bare', '-b', 'main', 'distant.git');
  git(racine, 'remote', 'add', 'origin', distant);
  git(racine, 'worktree', 'add', '-b', 'essai', arbre);
  return { racine, arbre, git };
}

test('un arbre propre et poussé est retirable, les autres non', async (t) => {
  const { racine, arbre, git } = depotAvecArbre(t);

  let [etat] = arbresDeTravail(racine);
  assert.equal(etat.branche, 'essai');
  assert.equal(etat.retirable, false, 'rien n’est poussé');
  assert.equal(etat.nonPousses, 1);

  git(arbre, 'push', 'origin', 'essai');
  [etat] = arbresDeTravail(racine);
  assert.equal(etat.retirable, true);

  writeFileSync(join(arbre, 'b.txt'), 'b');
  [etat] = arbresDeTravail(racine);
  assert.equal(etat.retirable, false, 'un fichier non commité');
  assert.equal(etat.modifies, 1);
});

test('evaluer alerte sur les budgets dépassés', async (t) => {
  const racine = bac(t);
  ecrire(join(racine, 'target/debug/deps/a.rlib'), 2048);
  ecrire(join(racine, 'target/debug/incremental/a.bin'), 1024);

  assert.deepEqual((await evaluer({ racine, config: BUDGETS, env: {} })).alertes, []);

  const serre = { ...BUDGETS, espace_libre_min_gio: 1e9, build_max_gio: 1 / GIO, incremental_max_gio: 1 / GIO };
  const { alertes } = await evaluer({ racine, config: serre, env: {} });
  assert.equal(alertes.length, 3);
  assert.equal((await evaluer({ racine, config: serre, rapide: true, env: {} })).alertes.length, 1);
});

test('evaluer compte les arbres de travail en trop', async (t) => {
  const { racine } = depotAvecArbre(t);
  assert.deepEqual((await evaluer({ racine, config: BUDGETS, rapide: true, env: {} })).alertes, []);
  const { alertes } = await evaluer({ racine, config: { ...BUDGETS, arbres_max: 0 }, rapide: true, env: {} });
  assert.equal(alertes.length, 1);
});

test('evaluer signale un build dans la copie figée', async (t) => {
  const racine = bac(t);
  const config = { ...BUDGETS, copies_figees: ['source_figee'] };
  mkdirSync(join(racine, 'source_figee/crates'), { recursive: true });
  assert.deepEqual((await evaluer({ racine, config, rapide: true, env: {} })).alertes, []);
  mkdirSync(join(racine, 'source_figee/target'));
  assert.deepEqual((await evaluer({ racine, config: BUDGETS, rapide: true, env: {} })).alertes, [], 'sans copie figée déclarée, rien');
  const { alertes } = await evaluer({ racine, config, rapide: true, env: {} });
  assert.equal(alertes.length, 1);
  assert.match(alertes[0], /copie figée/);
});

test('evaluer refuse un build partagé avec un autre arbre', async (t) => {
  const bacs = bac(t);
  const racine = join(bacs, 'arbre');
  mkdirSync(join(bacs, 'ailleurs/target'), { recursive: true });
  mkdirSync(racine);

  assert.deepEqual(await ciblePartagee(racine, {}), null);
  assert.deepEqual(await ciblePartagee(racine, { CARGO_TARGET_DIR: join(racine, 'target') }), null);
  assert.match(await ciblePartagee(racine, { CARGO_TARGET_DIR: join(bacs, 'ailleurs/target') }), /hors de cet arbre/);

  lier(join(bacs, 'ailleurs/target'), join(racine, 'target'));
  assert.match(await ciblePartagee(racine, {}), /lien/);
  const { alertes } = await evaluer({ racine, config: BUDGETS, rapide: true, env: {} });
  assert.equal(alertes.length, 1);
  assert.match(alertes[0], /sans compiler/);
});

test('le cache partagé se lit dans la configuration de Cargo du poste, ou se déclare', () => {
  const cargo = "[build]\nrustc-wrapper = 'sccache'\n[env]\nSCCACHE_DIR = 'D:/cache/sccache'\nSCCACHE_CACHE_SIZE = '20G'\n";
  assert.deepEqual(cachesPartages({}, cargo), [{ chemin: 'D:/cache/sccache', max_gio: 20 }]);
  assert.deepEqual(cachesPartages({}, "SCCACHE_DIR = \"/var/cache/s\"\nSCCACHE_CACHE_SIZE = \"512M\"\n"), [{ chemin: '/var/cache/s', max_gio: 0.5 }]);
  assert.deepEqual(cachesPartages({}, "SCCACHE_DIR = '/c'\n"), [{ chemin: '/c', max_gio: null }], 'sans taille, pas de plafond inventé');
  assert.deepEqual(cachesPartages({}, '[net]\ngit-fetch-with-cli = true\n'), [], 'sans cache branché, rien');
  const declare = [{ chemin: 'X:/autre', max_gio: 5 }];
  assert.deepEqual(cachesPartages({ caches_partages: declare }, cargo), declare, 'la déclaration locale passe devant');
});

test('evaluer mesure le cache partagé et alerte au-delà de son plafond, sans le compter au build', async (t) => {
  const racine = bac(t);
  arbreDeBuild(racine);
  const cache = join(bac(t), 'sccache');
  ecrire(join(cache, 'a', 'b.bin'), 2048);
  const sous = await evaluer({ racine, config: { ...BUDGETS, caches_partages: [{ chemin: cache, max_gio: 1 }] } });
  assert.equal(sous.mesures.caches[0].octets, 2048);
  assert.deepEqual(sous.alertes, []);
  const dessus = await evaluer({ racine, config: { ...BUDGETS, caches_partages: [{ chemin: cache, max_gio: 1 / GIO }] } });
  assert.ok(dessus.alertes.some((a) => a.startsWith(`Cache partagé ${cache}`)));
  assert.equal(dessus.mesures.build.octets, sous.mesures.build.octets, 'le cache n’entre pas dans le build de l’arbre');
  const vu = await nettoyer({ racine, profond: true });
  assert.ok(vu.every((r) => !r.cible.startsWith(cache)), 'nettoyer ne le vise jamais');
});
