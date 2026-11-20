import assert from 'node:assert/strict';
import { test } from 'node:test';

import { avis, comparer } from './crochets.mjs';

test('sans kit dans le projet, le crochet ne dit rien', () => {
  assert.deepEqual(avis({ kit: null, plugin: { version: '0.1.0' }, crochets: '' }), []);
});

test('tout va : rien à dire, aucun coût de contexte', () => {
  assert.deepEqual(avis({ kit: { version: '0.1.0' }, plugin: { version: '0.1.0' }, crochets: '.githooks' }), []);
});

test('des crochets inactifs, un kit en retard : une ligne chacun', () => {
  const lignes = avis({ kit: { version: '0.1.0' }, plugin: { version: '0.2.0' }, crochets: '' });
  assert.equal(lignes.length, 2);
  assert.match(lignes[0], /core\.hooksPath \.githooks/);
  assert.match(lignes[1], /0\.1\.0.*0\.2\.0/);
});

test('les versions se comparent nombre par nombre', () => {
  assert.equal(comparer('0.10.0', '0.9.0'), 1);
  assert.equal(comparer('1.0.0', '1.0.0'), 0);
  assert.equal(comparer('1.0', '1.0.1'), -1);
});
