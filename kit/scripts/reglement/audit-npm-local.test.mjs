// Les règles de l'évaluation OSV et leurs tests ; la lecture du verrou pnpm et la précédence SemVer, écrites sans
// dépendance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, lockPackages, matchNpmAdvisory, npmVersionAffected, npmVersionInRange, valid } from './audit-npm-local.mjs';

const range = (events) => ({ type: 'ECOSYSTEM', events });

test('la précédence suit SemVer 2.0.0, préversions et métadonnée de construction comprises', () => {
  const ordre = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
    '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 1; i < ordre.length; i++) assert.equal(compare(ordre[i - 1], ordre[i]), -1, `${ordre[i - 1]} < ${ordre[i]}`);
  assert.equal(compare('1.0.0+build.7', '1.0.0'), 0);
  assert.equal(compare('18446744073709551616.0.0', '18446744073709551615.0.0'), 1, 'au-delà des entiers de JavaScript');
  for (const faux of ['1.0', '01.0.0', '1.0.0-', '1.0.0-01', 'v1.0.0', '', '1.0.0 ']) assert.equal(valid(faux), false, faux);
});

test('les intervalles OSV : introduction incluse, correction exclue, même dans le désordre', () => {
  const r = range([{ fixed: '2.0.1' }, { introduced: '2.0.0' }, { fixed: '1.0.2' }, { introduced: '0' }]);
  for (const [v, expected] of [['0.0.0', true], ['1.0.2', false], ['1.9.9', false], ['2.0.0', true], ['2.0.1', false]]) {
    assert.equal(npmVersionInRange(v, r), expected, v);
  }
});

test('last_affected est inclus, et limit restreint un intervalle ouvert', () => {
  assert.equal(npmVersionInRange('1.0.2', range([{ introduced: '0' }, { last_affected: '1.0.2' }])), true);
  assert.equal(npmVersionInRange('1.0.3', range([{ introduced: '0' }, { last_affected: '1.0.2' }])), false);
  assert.equal(npmVersionInRange('2.0.0', range([{ introduced: '0' }, { limit: '2.0.0' }])), false);
  assert.equal(npmVersionInRange('2.0.0', range([{ introduced: '0' }, { limit: '*' }])), true);
  assert.equal(npmVersionInRange('2.0.0', range([{ introduced: '0' }, { limit: '1.0.0' }, { limit: '3.0.0' }])), true);
});

test('les préversions et la métadonnée de construction suivent SemVer', () => {
  const r = range([{ introduced: '8.0.0-alpha.0' }, { fixed: '8.0.0-alpha.17' }]);
  assert.equal(npmVersionInRange('8.0.0-alpha.16', r), true);
  assert.equal(npmVersionInRange('8.0.0-alpha.17+build', r), false);
  assert.equal(npmVersionInRange('7.29.7', r), false);
});

test('un intervalle descriptif n’élargit pas celui d’une autre version majeure', () => {
  const affected = { ranges: [range([{ introduced: '8.0.0' }, { fixed: '8.0.5' }])],
    database_specific: { last_known_affected_version_range: '<=8.0.4' } };
  assert.equal(npmVersionAffected('7.3.6', affected), false);
  assert.equal(npmVersionAffected('8.0.4', affected), true);
  assert.equal(npmVersionAffected('8.0.5', affected), false);
  assert.equal(npmVersionAffected('9.0.0', { ...affected, versions: ['9.0.0'] }), true);
});

test('une donnée illisible n’est pas qualifiée, jamais tenue pour saine', () => {
  for (const r of [{ type: 'GIT', events: [] }, range([{ introduced: 'not-a-version' }]),
    range([{ fixed: '1.0.0' }]), range([{ introduced: '0', fixed: '1.0.0' }])]) {
    assert.throws(() => npmVersionInRange('1.0.0', r));
  }
  const result = matchNpmAdvisory({ id: 'test', affected: [{ package: { ecosystem: 'npm', name: 'pkg' },
    ranges: [{ type: 'GIT', events: [] }] }] }, [{ name: 'pkg', version: '1.0.0', path: 'pkg@1.0.0' }]);
  assert.equal(result.unqualified.length, 1);
});

test('le verrou pnpm donne chaque paquet, portées comprises, et refuse ce qui n’a pas de version', () => {
  const verrou = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '  .:',
    '    devDependencies:',
    "      '@scope/pkg':",
    '        specifier: ^1.0.0',
    '',
    'packages:',
    '',
    "  '@scope/pkg@1.0.0':",
    "    resolution: {integrity: sha512-a}",
    '',
    '  vite@5.4.11:',
    "    resolution: {integrity: sha512-b}",
    '    engines: {node: ^18.0.0}',
    '',
    "  '@scope/pkg@2.0.0-beta.1':",
    "    resolution: {integrity: sha512-c}",
    '',
    'snapshots:',
    '',
    "  '@scope/pkg@1.0.0(react@18.3.1)': {}",
  ].join('\r\n');
  assert.deepEqual(lockPackages(verrou).map((p) => [p.name, p.version]),
    [['@scope/pkg', '1.0.0'], ['vite', '5.4.11'], ['@scope/pkg', '2.0.0-beta.1']]);
  assert.throws(() => lockPackages(verrou.replace('vite@5.4.11:', "'local@file:../local':")), /non qualifié/);
  assert.throws(() => lockPackages("lockfileVersion: '5.4'\npackages:\n  a@1.0.0:\n"), /format 6/);
  assert.throws(() => lockPackages("lockfileVersion: '9.0'\npackages:\n\nsnapshots:\n"), /vide/);
});

test('un avis retiré ou d’un autre écosystème ne lève pas d’alerte npm', () => {
  const affected = [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [range([{ introduced: '0' }])] }];
  const packages = [{ name: 'pkg', version: '1.0.0', path: 'pkg@1.0.0' }];
  assert.equal(matchNpmAdvisory({ id: 'test', affected, withdrawn: '2026-01-01' }, packages).findings.length, 0);
  assert.equal(matchNpmAdvisory({ id: 'test', affected: [{ ...affected[0], package: { name: 'pkg', ecosystem: 'PyPI' } }] }, packages).findings.length, 0);
  assert.equal(matchNpmAdvisory({ id: 'test', affected, database_specific: { severity: 'HIGH' } }, packages).findings.length, 1);
});
