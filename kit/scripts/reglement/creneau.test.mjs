import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ABANDON_MS, dossierDuCreneau, prendre, rendre, rendreQuandArrive } from './creneau.mjs';

function bac(t) {
  const dossier = mkdtempSync(join(tmpdir(), 'creneau-'));
  t.after(() => rmSync(dossier, { recursive: true, force: true }));
  return dossier;
}

// Une horloge qu'on avance à la main : attendre ne prend pas de vrai temps.
function horloge(depart = Date.parse('2026-11-11T19:00:00Z')) {
  let t = depart;
  return { maintenant: () => t, dormir: async (ms) => { t += ms; }, avancer: (ms) => { t += ms; } };
}

test('le créneau vit dans le .travail de la racine, ou là où ce clone le dit', (t) => {
  const racine = bac(t);
  mkdirSync(join(racine, '.travail'));
  assert.equal(dossierDuCreneau({ dossierGitCommun: join(racine, '.git') }), join(racine, '.travail', 'creneau-poussee-main'));
  assert.equal(dossierDuCreneau({ configure: 'X:/ailleurs/creneau', dossierGitCommun: join(racine, '.git') }), 'X:/ailleurs/creneau');
  assert.equal(dossierDuCreneau({ dossierGitCommun: join(bac(t), '.git') }), null, 'un clone à part, sans .travail ni réglage');
});

test('un créneau libre se prend, dit qui le tient, et ne se rend que par son arbre', async (t) => {
  const dossier = join(bac(t), 'creneau-poussee-main');
  const h = horloge();
  assert.deepEqual(await prendre({ dossier, arbre: 'E:/e2', commit: 'abc1234', ...h }), { pris: true });
  const tenu = readFileSync(join(dossier, 'tenu-par.txt'), 'utf8');
  assert.match(tenu, /^arbre: E:\/e2$/m);
  assert.match(tenu, /^commit: abc1234$/m);
  rendre(dossier, 'E:/e1');
  assert.ok(existsSync(dossier), 'un autre arbre ne rend pas le créneau');
  rendre(dossier, 'E:/e2');
  assert.ok(!existsSync(dossier));
});

test('un créneau tenu par un autre arbre fait attendre, puis se prend quand il se libère', async (t) => {
  const dossier = join(bac(t), 'creneau-poussee-main');
  const h = horloge();
  await prendre({ dossier, arbre: 'E:/e1', commit: 'aaa', ...h });
  const dits = [];
  let tours = 0;
  const dormir = async (ms) => { h.avancer(ms); tours += 1; if (tours === 3) rendre(dossier, 'E:/e1'); };
  const prise = await prendre({ dossier, arbre: 'E:/e2', commit: 'bbb', maintenant: h.maintenant, dormir, dire: (x) => dits.push(x) });
  assert.deepEqual(prise, { pris: true });
  assert.equal(tours, 3);
  assert.equal(dits.length, 1, 'l’attente se dit une fois');
  assert.match(dits[0], /arbre: E:\/e1/);
});

test('une attente bornée refuse et dit qui tient le créneau', async (t) => {
  const dossier = join(bac(t), 'creneau-poussee-main');
  const h = horloge();
  await prendre({ dossier, arbre: 'E:/e1', commit: 'aaa', ...h });
  const prise = await prendre({ dossier, arbre: 'E:/e2', commit: 'bbb', ...h, attenteMax: 5 * 60 * 1000 });
  assert.equal(prise.pris, false);
  assert.match(prise.raison, /créneau tenu : .*arbre: E:\/e1/);
});

test('un créneau de cet arbre se reprend, un créneau abandonné aussi, et la reprise s’écrit au registre', async (t) => {
  const travail = bac(t);
  const dossier = join(travail, 'creneau-poussee-main');
  const registre = join(travail, 'registre.md');
  writeFileSync(registre, '# Registre\n');
  const h = horloge();
  await prendre({ dossier, arbre: 'E:/e2', commit: 'ancien', ...h });
  const reprise = await prendre({ dossier, arbre: 'E:/e2', commit: 'neuf', ...h });
  assert.equal(reprise.pris, true, 'un crochet interrompu de cet arbre ne s’attend pas lui-même');
  assert.match(readFileSync(join(dossier, 'tenu-par.txt'), 'utf8'), /^commit: neuf$/m);

  h.avancer(ABANDON_MS + 1000);
  const abandon = await prendre({ dossier, arbre: 'E:/e3', commit: 'ccc', ...h, registre });
  assert.equal(abandon.pris, true);
  assert.match(abandon.repris, /arbre: E:\/e2/);
  assert.match(readFileSync(registre, 'utf8'), /créneau de poussée abandonné, repris par le crochet de E:\/e3/);
});

test('un créneau posé à la main, sans tenu-par.txt, compte depuis la date du dossier', async (t) => {
  const dossier = join(bac(t), 'creneau-poussee-main');
  mkdirSync(dossier);
  const h = horloge(Date.now());
  const prise = await prendre({ dossier, arbre: 'E:/e2', commit: 'x', ...h, attenteMax: 60 * 1000 });
  assert.equal(prise.pris, false, 'tout neuf : il se respecte');
  assert.match(prise.raison, /sans tenu-par\.txt/);
});

test('le créneau se rend quand main porte le commit, ou au bout du délai', async (t) => {
  const dossier = join(bac(t), 'creneau-poussee-main');
  const h = horloge();
  await prendre({ dossier, arbre: 'E:/e2', commit: 'c1', ...h });
  const tetes = ['avant', 'avant', 'c1'];
  await rendreQuandArrive({ dossier, arbre: 'E:/e2', commit: 'c1', teteDistante: () => tetes.shift(), ...h });
  assert.ok(!existsSync(dossier), 'rendu dès que main porte le commit');

  await prendre({ dossier, arbre: 'E:/e2', commit: 'c2', ...h });
  const debut = h.maintenant();
  await rendreQuandArrive({ dossier, arbre: 'E:/e2', commit: 'c2', teteDistante: () => 'autre', ...h, delai: 60 * 1000 });
  assert.ok(!existsSync(dossier), 'une poussée échouée après le crochet ne garde pas le créneau');
  assert.ok(h.maintenant() - debut >= 60 * 1000);
});

test('le tenant rafraîchit son heure, un autre arbre ne le peut pas', async (t) => {
  const { rafraichir } = await import('./creneau.mjs');
  const dossier = join(bac(t), 'creneau-poussee-main');
  const h = horloge();
  await prendre({ dossier, arbre: 'E:/e2', commit: 'train', ...h });
  h.avancer(ABANDON_MS - 60 * 1000);
  assert.equal(rafraichir(dossier, 'E:/e1', h.maintenant()), false);
  assert.equal(rafraichir(dossier, 'E:/e2', h.maintenant()), true);
  h.avancer(2 * 60 * 1000);
  const autre = await prendre({ dossier, arbre: 'E:/e1', commit: 'x', ...h, attenteMax: 0 });
  assert.equal(autre.pris, false, 'rafraîchi, il ne passe pas pour abandonné');
});
