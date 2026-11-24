// The OSV evaluation rules and their tests; the pnpm lockfile reading and SemVer precedence, written with no
// dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, databaseChanges, lockPackages, matchNpmAdvisory, npmVersionAffected, npmVersionInRange, valid } from './npm-audit.mjs';

const range = (events) => ({ type: 'ECOSYSTEM', events });

test('precedence follows SemVer 2.0.0, pre-releases and build metadata included', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
    '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 1; i < order.length; i++) assert.equal(compare(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
  assert.equal(compare('1.0.0+build.7', '1.0.0'), 0);
  assert.equal(compare('18446744073709551616.0.0', '18446744073709551615.0.0'), 1, 'beyond JavaScript integers');
  for (const wrong of ['1.0', '01.0.0', '1.0.0-', '1.0.0-01', 'v1.0.0', '', '1.0.0 ']) assert.equal(valid(wrong), false, wrong);
});

test('OSV ranges: introduced included, fixed excluded, even out of order', () => {
  const r = range([{ fixed: '2.0.1' }, { introduced: '2.0.0' }, { fixed: '1.0.2' }, { introduced: '0' }]);
  for (const [v, expected] of [['0.0.0', true], ['1.0.2', false], ['1.9.9', false], ['2.0.0', true], ['2.0.1', false]]) {
    assert.equal(npmVersionInRange(v, r), expected, v);
  }
});

test('last_affected is included, and limit narrows an open range', () => {
  assert.equal(npmVersionInRange('1.0.2', range([{ introduced: '0' }, { last_affected: '1.0.2' }])), true);
  assert.equal(npmVersionInRange('1.0.3', range([{ introduced: '0' }, { last_affected: '1.0.2' }])), false);
  assert.equal(npmVersionInRange('2.0.0', range([{ introduced: '0' }, { limit: '2.0.0' }])), false);
  assert.equal(npmVersionInRange('2.0.0', range([{ introduced: '0' }, { limit: '*' }])), true);
  assert.equal(npmVersionInRange('2.0.0', range([{ introduced: '0' }, { limit: '1.0.0' }, { limit: '3.0.0' }])), true);
});

test('pre-releases and build metadata follow SemVer', () => {
  const r = range([{ introduced: '8.0.0-alpha.0' }, { fixed: '8.0.0-alpha.17' }]);
  assert.equal(npmVersionInRange('8.0.0-alpha.16', r), true);
  assert.equal(npmVersionInRange('8.0.0-alpha.17+build', r), false);
  assert.equal(npmVersionInRange('7.29.7', r), false);
});

test('a descriptive range does not widen the range of another major version', () => {
  const affected = { ranges: [range([{ introduced: '8.0.0' }, { fixed: '8.0.5' }])],
    database_specific: { last_known_affected_version_range: '<=8.0.4' } };
  assert.equal(npmVersionAffected('7.3.6', affected), false);
  assert.equal(npmVersionAffected('8.0.4', affected), true);
  assert.equal(npmVersionAffected('8.0.5', affected), false);
  assert.equal(npmVersionAffected('9.0.0', { ...affected, versions: ['9.0.0'] }), true);
});

test('unreadable data is unqualified, never taken as healthy', () => {
  for (const r of [{ type: 'GIT', events: [] }, range([{ introduced: 'not-a-version' }]),
    range([{ fixed: '1.0.0' }]), range([{ introduced: '0', fixed: '1.0.0' }])]) {
    assert.throws(() => npmVersionInRange('1.0.0', r));
  }
  const result = matchNpmAdvisory({ id: 'test', affected: [{ package: { ecosystem: 'npm', name: 'pkg' },
    ranges: [{ type: 'GIT', events: [] }] }] }, [{ name: 'pkg', version: '1.0.0', path: 'pkg@1.0.0' }]);
  assert.equal(result.unqualified.length, 1);
});

test('the pnpm lockfile gives each package, scopes included, and refuses what has no version', () => {
  const lockfile = [
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
  assert.deepEqual(lockPackages(lockfile).map((p) => [p.name, p.version]),
    [['@scope/pkg', '1.0.0'], ['vite', '5.4.11'], ['@scope/pkg', '2.0.0-beta.1']]);
  assert.throws(() => lockPackages(lockfile.replace('vite@5.4.11:', "'local@file:../local':")), /Unqualified package/);
  assert.throws(() => lockPackages("lockfileVersion: '5.4'\npackages:\n  a@1.0.0:\n"), /format 6/);
  assert.throws(() => lockPackages("lockfileVersion: '9.0'\npackages:\n\nsnapshots:\n"), /Empty package inventory/);
});

test('a database read clean is read once; a misread is read again without the folder cache; a change stays', () => {
  const reads = (...answers) => {
    const asked = [];
    const read = (extra) => { asked.push(extra); return answers[asked.length - 1]; };
    return { asked, read };
  };
  let paused = 0;
  const pause = () => { paused += 1; };
  const clean = reads('');
  assert.deepEqual(databaseChanges(clean.read, pause), { changes: '', misread: '' });
  assert.deepEqual([clean.asked, paused], [[[]], 0], 'one read, no pause');
  const misread = reads(' D advisories/github-reviewed/2026/07/GHSA-x/GHSA-x.json', '');
  assert.deepEqual(databaseChanges(misread.read, pause), { changes: '', misread: ' D advisories/github-reviewed/2026/07/GHSA-x/GHSA-x.json' });
  assert.deepEqual([misread.asked, paused], [[[], ['-c', 'core.fscache=false']], 1], 'read again, after a pause, without the cache');
  const changed = reads(' M advisories/a.json', ' M advisories/a.json');
  assert.deepEqual(databaseChanges(changed.read, pause), { changes: ' M advisories/a.json', misread: '' }, 'a real change fails');
});

test('a withdrawn advisory, or one of another ecosystem, raises no npm alert', () => {
  const affected = [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [range([{ introduced: '0' }])] }];
  const packages = [{ name: 'pkg', version: '1.0.0', path: 'pkg@1.0.0' }];
  assert.equal(matchNpmAdvisory({ id: 'test', affected, withdrawn: '2026-01-01' }, packages).findings.length, 0);
  assert.equal(matchNpmAdvisory({ id: 'test', affected: [{ ...affected[0], package: { name: 'pkg', ecosystem: 'PyPI' } }] }, packages).findings.length, 0);
  assert.equal(matchNpmAdvisory({ id: 'test', affected, database_specific: { severity: 'HIGH' } }, packages).findings.length, 1);
});
