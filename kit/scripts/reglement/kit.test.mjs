import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ecartsAuManifeste, empreinte, MANIFESTE } from './kit.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));

test('le kit est tel que sa version l’a livré', () => {
  const manifeste = JSON.parse(readFileSync(join(KIT, MANIFESTE), 'utf8'));
  const { changes, enTrop, manquants } = ecartsAuManifeste(KIT, manifeste);
  const conseil = 'Le kit se copie tel quel : ce qui est propre au projet va dans config/, un correctif du kit se fait dans le dépôt du plugin puis se pose.';
  assert.deepEqual(changes, [], `retouchés depuis la version ${manifeste.version} : ${changes.join(', ')}. ${conseil}`);
  assert.deepEqual(enTrop, [], `fichiers ajoutés dans scripts/reglement/ : ${enTrop.join(', ')}. ${conseil}`);
  assert.deepEqual(manquants, [], `fichiers du kit absents : ${manquants.join(', ')}. Reposer le kit.`);
});

test('une fin de ligne Windows ne change pas l’empreinte', () => {
  assert.equal(empreinte(Buffer.from('a\r\nb\r\n')), empreinte(Buffer.from('a\nb\n')));
  assert.notEqual(empreinte(Buffer.from('a\nb\n')), empreinte(Buffer.from('a\nc\n')));
});
