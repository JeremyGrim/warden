import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { test } from 'node:test';

import { arbresDuProjet, classer, regler, rendreLesPriorites } from './priorite.mjs';

const TRAIN = process.platform === 'win32' ? 'C:\\depots\\projet-fabrique' : '/depots/projet-fabrique';
const AGENT = process.platform === 'win32' ? 'E:\\arbres\\projet-e3' : '/arbres/projet-e3';
const AUTRES = arbresDuProjet(process.platform === 'win32' ? 'C:\\depots\\projet' : '/depots/projet');
const p = (pid, parent, nom, ligne, executable = '') => ({ pid, parent, nom, ligne, executable });

// Un poste : le train compile (cargo, puis rustc qui nomme l'arbre), un agent aussi, un test d'agent tourne depuis son
// target, et un cargo sans enfant ni parent reconnaissable.
const POSTE = [
  p(1, 0, 'node.exe', `node scripts/train.mjs conduire`),
  p(2, 1, 'cargo.exe', 'cargo clippy --workspace'),
  p(3, 2, 'rustc.exe', `rustc --out-dir ${TRAIN}/target/debug/deps`),
  p(10, 0, 'bash.exe', 'bash'),
  p(11, 10, 'cargo.exe', 'cargo test -p memoire'),
  p(12, 11, 'rustc.exe', `rustc --out-dir ${AGENT}/target/debug/deps`),
  p(13, 11, 'tout-1f2e.exe', 'tout-1f2e.exe', `${AGENT}/target/debug/deps/tout-1f2e.exe`),
  p(20, 0, 'cargo.exe', 'cargo build'),
  p(30, 0, 'Code.exe', `code ${AGENT}`),
];

test('chaque compilation se rattache à son arbre, par sa ligne, ses enfants ou ses parents', () => {
  const k = classer(POSTE, TRAIN, AUTRES);
  assert.equal(k.get(2), 'train', 'cargo du train, par son rustc');
  assert.equal(k.get(3), 'train');
  assert.equal(k.get(11), 'autre', 'cargo de l’agent, par son rustc');
  assert.equal(k.get(12), 'autre');
  assert.equal(k.get(13), 'autre', 'un test lancé depuis le target d’un agent');
  assert.equal(k.get(20), '', 'inconnu : il ne bouge pas');
  assert.ok(!k.has(30) && !k.has(1) && !k.has(10), 'ce qui ne compile pas n’est pas classé');
});

test('le train monte, l’agent descend, l’inconnu reste ; le train fini, chacun retrouve sa priorité', () => {
  const priorites = new Map([[2, 0], [3, 0], [11, 0], [12, 0], [13, 0], [20, 0]]);
  const lire = (pid) => priorites.get(pid);
  const poser = (pid, v) => {
    if (!priorites.has(pid)) throw new Error('fini');
    priorites.set(pid, v);
  };
  const retenues = new Map();
  regler(POSTE, TRAIN, retenues, { lire, poser, autres: AUTRES });
  assert.equal(priorites.get(3), constants.priority.PRIORITY_ABOVE_NORMAL);
  assert.equal(priorites.get(12), constants.priority.PRIORITY_LOW);
  assert.equal(priorites.get(20), 0);
  regler(POSTE, TRAIN, retenues, { lire, poser, autres: AUTRES });
  assert.equal(retenues.get(12), 0, 'la priorité retenue est celle d’avant le premier réglage');
  priorites.delete(13);
  rendreLesPriorites(retenues, { poser });
  assert.deepEqual([...priorites.values()], [0, 0, 0, 0, 0], 'un processus fini entre-temps ne gêne pas');
  assert.equal(retenues.size, 0);
});
