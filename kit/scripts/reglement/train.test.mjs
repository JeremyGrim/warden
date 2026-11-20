import assert from 'node:assert/strict';
import { test } from 'node:test';

import { choisirLot, commandeDeNote, depotsPrets, LOT_MAX, lireDepot, sansDejaPris, trier } from './train.mjs';

test('un dépôt se lit tel que la règle l’écrit, alignement et note compris', () => {
  const texte = 'arbre   = E:\\arbres\\projet-e5\nbranche = module-suivi\ntaches  = T36, T37\ncargo   = oui\ndepose  = 11/11 20:57\nnote    = 8 commits rebasés\n';
  const d = lireDepot('agent-11.txt', texte, 0, 2026);
  assert.equal(d.arbre, 'E:\\arbres\\projet-e5');
  assert.equal(d.branche, 'module-suivi');
  assert.deepEqual(d.taches, ['T36', 'T37']);
  assert.equal(d.refuse, null);
  assert.equal(d.moment, new Date(2026, 10, 11, 20, 57).getTime());
  assert.equal(lireDepot('x.txt', 'arbre = a\nbranche = b\n', 1234).moment, 1234, 'sans heure, la date du fichier');
  assert.deepEqual(d.parcours, [], 'sans parcours, rien à jouer');
  assert.deepEqual(lireDepot('y.txt', 'parcours = liens-ecran, journal-filtres\n').parcours, ['liens-ecran', 'journal-filtres']);
});

test('un train emmène un lot de quatre au plus, dans l’ordre, et le complète quand une branche est en conflit', () => {
  const empilees = [];
  const empiler = (d) => (d === 'b' ? 'conflit' : (empilees.push(d), null));
  const { lot, conflits } = choisirLot(['a', 'b', 'c', 'd', 'e', 'f', 'g'], empiler);
  assert.equal(LOT_MAX, 4);
  assert.deepEqual(lot, ['a', 'c', 'd', 'e']);
  assert.deepEqual(conflits, [{ depot: 'b', cause: 'conflit' }]);
  assert.deepEqual(empilees, ['a', 'c', 'd', 'e'], 'f et g ne sont pas touchées : elles attendent le train suivant');
  assert.deepEqual(choisirLot(['a', 'b', 'c'], () => null, 2).lot, ['a', 'b']);
});

test('une branche empilée sur un autre dépôt n’emmène que ses propres commits', () => {
  const cherry = '- aaa111\n- bbb222\n+ ccc333\n+ ddd444\n';
  assert.deepEqual(sansDejaPris(['aaa111', 'bbb222', 'ccc333', 'ddd444'], cherry), ['ccc333', 'ddd444'], 'les commits du dépôt du dessous sont déjà dans le train');
  assert.deepEqual(sansDejaPris(['ccc333'], ''), ['ccc333'], 'rien de commun : tout s’empile');
  assert.deepEqual(sansDejaPris(['aaa111'], '- aaa111'), [], 'tout est déjà pris : rien à empiler');
});

test('le train part dans l’ordre des dépôts, sans les refusés ni les incomplets', () => {
  const d = (nom, depose, extra = '') => lireDepot(nom, `arbre = a\nbranche = ${nom}\ndepose = ${depose}\n${extra}`, 0, 2026);
  const prets = depotsPrets([d('c', '11/11 20:58'), d('a', '11/11 20:38'), d('b', '11/11 20:44', 'refuse = conflit'), lireDepot('vide', 'branche = z\n')]);
  assert.deepEqual(prets.map((x) => x.nom), ['a', 'c']);
});

test('tout passe : une seule vérification', async () => {
  const essais = [];
  const r = await trier(['a', 'b', 'c', 'd'], async (liste) => { essais.push(liste.join('')); return true; });
  assert.deepEqual(r, { montees: ['a', 'b', 'c', 'd'], sorties: [] });
  assert.deepEqual(essais, ['abcd']);
});

test('une branche fautive se trouve par moitiés, sort, et le reste monte dans l’ordre', async () => {
  const essais = [];
  const r = await trier(['a', 'b', 'c', 'd'], async (liste) => { essais.push(liste.join('')); return !liste.includes('c'); });
  assert.deepEqual(r, { montees: ['a', 'b', 'd'], sorties: ['c'] });
  assert.deepEqual(essais, ['abcd', 'ab', 'abc', 'abd'], 'chaque essai porte ce qui est déjà gardé, et rien ne se revérifie');
});

test('deux fautives, et une branche qui ne casse qu’avec une autre', async () => {
  const r = await trier(['a', 'b', 'c', 'd', 'e'], async (liste) => !liste.includes('b') && !liste.includes('e'));
  assert.deepEqual(r, { montees: ['a', 'c', 'd'], sorties: ['b', 'e'] });
  const ensemble = await trier(['a', 'b'], async (liste) => !(liste.includes('a') && liste.includes('b')));
  assert.deepEqual(ensemble, { montees: ['a'], sorties: ['b'] }, 'la première arrivée garde sa place');
});

test('un seul dépôt qui échoue sort sans autre essai', async () => {
  let n = 0;
  const r = await trier(['a'], async () => { n += 1; return false; });
  assert.deepEqual(r, { montees: [], sorties: ['a'] });
  assert.equal(n, 1);
});

test('une note suit le contrat de suivi, par Node pour un script, telle quelle sinon', () => {
  assert.deepEqual(commandeDeNote('/outils/tache.mjs', 'fabrique', 'T1', 'monté'), ['node', '/outils/tache.mjs', 'note', 'T1', 'monté', '--agent', 'fabrique']);
  assert.deepEqual(commandeDeNote('tache', 'fabrique', 'T1', 'monté'), ['tache', 'note', 'T1', 'monté', '--agent', 'fabrique']);
});
