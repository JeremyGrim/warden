import '../kit/scripts/warden/git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { adoptDebts, adoptSteps, denyDebts, firstError, npmDebts, rulesDebts, withIgnored } from './adopt.mjs';

// Lines as cargo-deny 0.20 writes them with --format json (trimmed): a warning, two advisories, a license refusal.
const diagnostic = (fields) => JSON.stringify({ fields, type: 'diagnostic' });
const DENY = [
  diagnostic({ code: 'license-not-encountered', graphs: [], message: 'license was not encountered', severity: 'warning' }),
  diagnostic({ advisory: { id: 'RUSTSEC-2026-0543', package: 'chrono' }, code: 'unmaintained', graphs: [{ Krate: { name: 'chrono', version: '0.4.45' } }], message: 'chrono is unmaintained', severity: 'error' }),
  diagnostic({ advisory: { id: 'RUSTSEC-2026-0459', package: 'libsqlite3-sys' }, code: 'vulnerability', graphs: [{ Krate: { name: 'libsqlite3-sys', version: '0.30.1' } }], message: 'C SQLite "CVE"', severity: 'error' }),
  diagnostic({ advisory: { id: 'RUSTSEC-2026-0459', package: 'libsqlite3-sys' }, code: 'vulnerability', graphs: [{ Krate: { name: 'libsqlite3-sys', version: '0.30.1' } }], message: 'twice', severity: 'error' }),
  diagnostic({ code: 'rejected', graphs: [{ Krate: { name: 'odd', version: '1.0.0' } }], message: 'failed to satisfy license requirements', severity: 'error' }),
  JSON.stringify({ fields: { advisories: { errors: 2 } }, type: 'summary' }),
  'not json',
];
const MODEL = '[graph]\nall-features = false\n\n[advisories]\nunmaintained = "workspace"\n# { id = "RUSTSEC-…", reason = "…" }\nignore = []\n\n[licenses]\nallow = ["MIT"]\n';

test('each advisory present at adoption becomes one named debt; what else refuses is said, never accepted', () => {
  const { debts, others } = denyDebts(DENY, '2026-11-23');
  assert.deepEqual(debts.map((d) => d.id), ['RUSTSEC-2026-0543', 'RUSTSEC-2026-0459']);
  assert.equal(debts[0].reason, 'present when Warden was adopted, 2026-11-23: chrono 0.4.45, unmaintained');
  assert.deepEqual(others, ['rejected: failed to satisfy license requirements (odd 1.0.0)']);
});

test('the debts go into [advisories] ignore, the ones already named kept, the rest of the file untouched', () => {
  const debts = denyDebts(DENY, '2026-11-23').debts;
  const once = withIgnored(MODEL, debts);
  assert.match(once, /\[advisories\]\nunmaintained = "workspace"\n# \{ id = "RUSTSEC-…", reason = "…" \}\nignore = \[\n {2}\{ id = "RUSTSEC-2026-0543", reason = "present when Warden was adopted, 2026-11-23: chrono 0\.4\.45, unmaintained" \},\n {2}\{ id = "RUSTSEC-2026-0459", .* \},\n\]\n\n\[licenses\]\nallow = \["MIT"\]\n$/);
  assert.equal(withIgnored(once, debts), once, 'a debt already named is not named twice');
  const named = MODEL.replace('ignore = []', 'ignore = [\n  { id = "RUSTSEC-2020-0001", reason = "kept by hand" }\n]');
  const both = withIgnored(named, [debts[0]]);
  assert.match(both, /ignore = \[\n {2}\{ id = "RUSTSEC-2020-0001", reason = "kept by hand" \},\n {2}\{ id = "RUSTSEC-2026-0543"/);
  assert.equal(withIgnored('[licenses]\n', debts), null);
  assert.match(withIgnored('[advisories]\nyanked = "deny"\n', debts), /yanked = "deny"\nignore = \[\n {2}\{ id = "RUSTSEC-2026-0543"/, 'no ignore list yet: one is added');
});

test('the npm advisories that would refuse become debts, the others do not', () => {
  const finding = (id, severity, name) => ({ id, severity, package: { name, version: '1.0.0' } });
  const debts = npmDebts({ findings: [finding('GHSA-a', 'HIGH', 'left'), finding('GHSA-b', 'MODERATE', 'right'), finding('GHSA-a', 'HIGH', 'left')] }, '2026-11-23');
  assert.deepEqual(debts, [{ id: 'GHSA-a', reason: 'present when Warden was adopted, 2026-11-23: left@1.0.0, HIGH' }]);
});

// A project adopting Warden: its configuration written, not yet on the remote main branch.
function project(t, { onMain = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'warden-adopt-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(base, 'project');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  git('init', '--quiet', '-b', 'main');
  for (const [key, value] of [['user.name', 'guard'], ['user.email', 'guard@example.test'], ['commit.gpgsign', 'false'], ['warden.ghsa', join(base, 'ghsa')]]) git('config', key, value);
  writeFileSync(join(root, 'config', 'deny.toml'), MODEL);
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(root, 'config', 'factory.json'), `${JSON.stringify({ main_branch: 'main', remote: 'origin', verify: { rust: { deny: 'config/deny.toml' }, npm_advisories: { lockfile: 'pnpm-lock.yaml' } } }, null, 2)}\n`);
  if (onMain) {
    git('add', '-A');
    git('commit', '--quiet', '-m', 'adopted');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  return root;
}

const fakeDeny = () => ({ status: 1, stdout: '', stderr: DENY.join('\n') });
const fakeAudit = () => ({ findings: [{ id: 'GHSA-a', severity: 'CRITICAL', package: { name: 'left', version: '1.0.0' } }] });

test('at adoption, the debts are written where each check reads them', (t) => {
  const root = project(t);
  const report = adoptDebts(root, { run: fakeDeny, audit: fakeAudit, now: new Date('2026-11-23T10:00:00Z') });
  assert.deepEqual(report.rust.debts.map((d) => d.id), ['RUSTSEC-2026-0543', 'RUSTSEC-2026-0459']);
  assert.match(readFileSync(join(root, 'config', 'deny.toml'), 'utf8'), /id = "RUSTSEC-2026-0459"/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config', 'factory.json'), 'utf8')).verify.npm_advisories.ignore.map((d) => d.id), ['GHSA-a']);
});

test('once the configuration is on the main branch, nothing is accepted for the person', (t) => {
  const root = project(t, { onMain: true });
  let ran = 0;
  const report = adoptDebts(root, { run: () => { ran += 1; return fakeDeny(); }, audit: () => { ran += 1; return fakeAudit(); } });
  assert.deepEqual([report, ran], [{ rust: null, npm: null, rules: null, steps: null }, 0]);
  assert.equal(readFileSync(join(root, 'config', 'deny.toml'), 'utf8'), MODEL);
});

test('a check that cannot run says why, and writes nothing', (t) => {
  const root = project(t);
  const report = adoptDebts(root, { run: () => ({ status: 101, stdout: '', stderr: 'error: the lock file needs to be updated but --locked was passed' }), audit: () => { throw new Error('No applicable npm advisory in the database'); } });
  assert.match(report.rust.error, /--locked/);
  assert.match(report.npm.error, /No applicable/);
  assert.equal(readFileSync(join(root, 'config', 'deny.toml'), 'utf8'), MODEL);
});

test('what the rules find in the repository at adoption is named where the rules read it; the rest still refuses', () => {
  const rules = { max_lines: 700, lines_exempt: ['Cargo.lock'], size_exceptions: {}, secret_exceptions: { 'a.rs': { 'machine path': 'by hand' } }, versions: [{ file: 'package.json', read: 'json:version' }] };
  const findings = [
    { rule: 'lines', path: 'src/big.rs', message: 'x', detail: { lines: 704 } },
    { rule: 'size', path: 'assets/map.json', message: 'x', detail: { kib: 900 } },
    { rule: 'secret', path: 'a.rs', message: 'x', detail: { kind: 'Anthropic key' } },
    { rule: 'secret', path: 'b.rs', message: 'x', detail: { kind: 'machine path' } },
    { rule: 'version', path: 'Cargo.toml', message: 'package.json 0.1.0, Cargo.toml 1.0.12' },
    { rule: 'artifact', path: 'app.exe', message: 'x' },
  ];
  const { rules: next, named, count, left } = rulesDebts(rules, findings, '2026-11-23');
  assert.deepEqual(next.lines_exempt, ['Cargo.lock', 'src/big.rs']);
  assert.deepEqual(next.size_exceptions, { 'assets/map.json': 900 });
  assert.deepEqual(next.secret_exceptions, { 'a.rs': { 'machine path': 'by hand', 'Anthropic key': 'present when Warden was adopted, 2026-11-23' }, 'b.rs': { 'machine path': 'present when Warden was adopted, 2026-11-23' } });
  assert.equal(next.versions, undefined, 'manifests that disagree: the rule is left out, no manifest is edited');
  assert.equal(named.versions, 'package.json 0.1.0, Cargo.toml 1.0.12');
  assert.deepEqual([count, left.map((f) => f.path)], [5, ['app.exe']], 'a committed artifact still refuses');
  assert.deepEqual(next._adopted.lines, ['src/big.rs (704)']);
  assert.equal(rules.versions.length, 1, 'the given rules are not changed in place');
  assert.deepEqual(rulesDebts(rules, [], '2026-11-23'), { rules, named: { lines: [], size: [], secret: [], versions: null }, count: 0, left: [] });
});

test('a step that fails on the repository as it stands is left out, with its first error; the others stay', () => {
  const ran = [];
  const exec = (command) => {
    ran.push(command.join(' '));
    if (command.includes('build')) return { status: 2, stdout: '$ tsc --noEmit\nsrc/a.tsx(16,22): error TS2307: Cannot find module \'../langue\'\nmore', stderr: '' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const factory = { train: { install: { lockfile: 'pnpm-lock.yaml', command: ['pnpm', 'install'] } }, verify: { steps: [{ title: 'Project tests', command: ['pnpm', 'test'] }, { title: 'Build', command: ['pnpm', 'run', 'build'] }] } };
  const tried = adoptSteps(factory, exec);
  assert.deepEqual(ran, ['pnpm install', 'pnpm test', 'pnpm run build'], 'the dependencies first, then each step once');
  assert.deepEqual(tried.kept.map((s) => s.title), ['Project tests']);
  assert.deepEqual(tried.failing, [{ title: 'Build', command: ['pnpm', 'run', 'build'], first_error: "src/a.tsx(16,22): error TS2307: Cannot find module '../langue'" }]);
  assert.match(adoptSteps(factory, () => ({ status: 1, stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE failed' })).error, /^pnpm install: ERR_PNPM_OUTDATED_LOCKFILE failed$/, 'dependencies that do not install: nothing is judged');
  assert.equal(adoptSteps({ verify: { steps: [] } }, exec), null);
  assert.equal(firstError('a\nb\n'), 'b');
});
