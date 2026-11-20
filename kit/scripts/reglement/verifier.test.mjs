import assert from 'node:assert/strict';
import { test } from 'node:test';

import { avecLeursDependants, envois, paquetsDeLEspace, planDePoussee, testsEnEchec } from './verifier.mjs';

// Un petit espace : le modèle, le magasin qui en dépend, le cœur qui dépend du magasin, la coque du cœur, et un
// outil à part. Le magasin dépend du modèle seulement pour ses tests.
const RACINE = process.platform === 'win32' ? 'E:\\depot' : '/depot';
const sep = process.platform === 'win32' ? '\\' : '/';
const paquet = (nom, dossier, dependances = []) => ({
  id: `${nom} 1.0.0`,
  name: nom,
  manifest_path: [RACINE, ...dossier.split('/').filter(Boolean), 'Cargo.toml'].join(sep),
  dependencies: dependances.map(([d, kind]) => ({ name: d, kind: kind ?? null, path: [RACINE, 'x', d].join(sep) })),
});
const METADATA = {
  workspace_root: RACINE,
  workspace_members: ['modele 1.0.0', 'magasin 1.0.0', 'coeur 1.0.0', 'coque 1.0.0', 'outil 1.0.0'],
  packages: [
    paquet('modele', 'crates/modele'),
    paquet('magasin', 'crates/magasin', [['modele', 'dev'], ['serde']]),
    paquet('coeur', 'crates/coeur', [['magasin']]),
    paquet('coque', 'apps/coque', [['coeur']]),
    paquet('outil', 'crates/outil'),
  ],
};
const PAQUETS = paquetsDeLEspace(METADATA);
const VERIFICATION = {
  rust: { entier: ['^Cargo\\.(toml|lock)$', '^rust-toolchain\\.toml$', '^\\.cargo/', '^vendor/'], deny: 'config/deny.toml' },
  avis_npm: { verrou: 'pnpm-lock.yaml' },
  etapes: [
    { titre: 'Construction du front', si: ['^apps/front/', '^pnpm-lock\\.yaml$'], commande: ['pnpm', '--filter', 'front', 'build'] },
    { titre: 'Tests de la passerelle', si: ['^apps/passerelle/'], commande: ['pnpm', '--filter', 'passerelle', 'test'] },
  ],
};
const plan = (fichiers, verification = VERIFICATION) => planDePoussee(fichiers, PAQUETS, verification);
const titres = (p) => p.etapes.map((e) => e.titre);

test('les paquets de l’espace gardent leurs dépendances dans l’espace, de test comprises', () => {
  const magasin = PAQUETS.find((p) => p.nom === 'magasin');
  assert.equal(magasin.dossier, 'crates/magasin');
  assert.deepEqual(magasin.dependances, ['modele'], 'serde n’est pas de l’espace');
});

test('un changement vérifie son paquet et tout ce qui en dépend, même de loin', () => {
  assert.deepEqual(avecLeursDependants(['magasin'], PAQUETS), ['coeur', 'coque', 'magasin']);
  const p = plan(['crates/magasin/src/lib.rs', 'docs/disque.md']);
  assert.deepEqual(p.rust, { tout: false, clippy: ['coeur', 'coque', 'magasin'], tests: ['magasin'] });
  assert.deepEqual(p.etapes, []);
});

test('un fichier hors de tout paquet Rust ne compile rien', () => {
  assert.deepEqual(plan(['docs/disque.md', 'scripts/reglement/disque.mjs', '.githooks/pre-push']).rust, { tout: false, clippy: [], tests: [] });
});

test('les fichiers de la racine Rust vérifient tout l’espace', () => {
  for (const fichier of ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', '.cargo/config.toml', 'vendor/surrealdb/src/lib.rs']) {
    assert.equal(plan([fichier]).rust.tout, true, fichier);
  }
  assert.equal(plan(['crates/modele/src/lib.rs']).rust.tout, false, 'le modèle n’atteint pas l’outil');
  assert.equal(plan(['crates/modele/src/lib.rs', 'crates/outil/src/lib.rs']).rust.tout, true, 'tous les paquets atteints');
});

test('un dossier au nom voisin n’est pas le paquet', () => {
  assert.deepEqual(plan(['crates/modele-bis/src/lib.rs']).rust.clippy, []);
});

test('un paquet à la racine prend ce qu’aucun autre ne prend', () => {
  const seul = paquetsDeLEspace({ workspace_root: RACINE, workspace_members: ['racine 1.0.0'], packages: [paquet('racine', '')] });
  assert.equal(seul[0].dossier, '');
  assert.deepEqual(planDePoussee(['src/main.rs'], seul, VERIFICATION).rust, { tout: true, clippy: [], tests: [] }, 'un seul paquet, tout l’espace');
});

test('les étapes du projet se jouent quand leurs chemins changent', () => {
  assert.deepEqual(titres(plan(['apps/front/src/App.tsx'])), ['Construction du front']);
  assert.deepEqual(titres(plan(['pnpm-lock.yaml'])), ['Construction du front']);
  assert.equal(plan(['pnpm-lock.yaml']).avisNpm, true, 'un verrou npm changé passe les avis');
  assert.equal(plan(['apps/front/src/App.tsx']).avisNpm, false);
  assert.deepEqual(titres(plan(['apps/passerelle/proxy.mjs'])), ['Tests de la passerelle']);
  assert.deepEqual(titres(plan(['docs/a.md'])), []);
});

test('sans section Rust ni avis npm, rien de Rust ni d’avis', () => {
  const nodeSeul = { etapes: [{ titre: 'Tests', si: ['^src/'], commande: ['node', '--test'] }] };
  const p = planDePoussee(['Cargo.lock', 'pnpm-lock.yaml', 'src/a.mjs'], null, nodeSeul);
  assert.deepEqual(p.rust, { tout: false, clippy: [], tests: [] });
  assert.equal(p.dependances, false);
  assert.equal(p.avisNpm, false);
  assert.deepEqual(titres(p), ['Tests']);
});

test('le crochet lit ce que Git pousse, et passe les suppressions', () => {
  const zero = '0'.repeat(40);
  const entree = `refs/heads/a ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\nrefs/heads/x ${zero} refs/heads/x ${'c'.repeat(40)}\n`;
  assert.deepEqual(envois(entree), [{ refLocale: 'refs/heads/a', local: 'a'.repeat(40), refDistante: 'refs/heads/main', distant: 'b'.repeat(40) }]);
  assert.deepEqual(envois(''), []);
});

test('une dépendance ajoutée ou montée passe le contrôle des dépendances, s’il est réglé', () => {
  for (const fichier of ['Cargo.lock', 'Cargo.toml', 'crates/magasin/Cargo.toml', 'config/deny.toml']) {
    assert.equal(plan([fichier]).dependances, true, fichier);
  }
  assert.equal(plan(['crates/magasin/src/lib.rs']).dependances, false);
  assert.equal(plan(['Cargo.lock'], { ...VERIFICATION, rust: { ...VERIFICATION.rust, deny: null } }).dependances, false, 'sans cargo deny, rien');
});

test('les tests en échec se lisent dans la sortie de cargo test, une fois chacun', () => {
  const sortie = 'running 3 tests\ntest a::ok ... ok\ntest cognition::c45 ... FAILED\r\ntest b::lent has been running for over 60 seconds\ntest b::lent ... FAILED\n\nfailures:\n    cognition::c45\ntest cognition::c45 ... FAILED\n';
  assert.deepEqual(testsEnEchec(sortie), ['cognition::c45', 'b::lent']);
  assert.deepEqual(testsEnEchec('test result: ok. 3 passed'), []);
});
