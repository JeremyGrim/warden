// The security advisories of npm dependencies, compared on the workstation to the pnpm lockfile. `pnpm audit` sends the
// dependency list to an online service; this script sends nothing. It reads a public clone of the GitHub Advisory
// Database (OSV format), downloaded separately, and evaluates it per https://ossf.github.io/osv-schema/#evaluation. The
// lockfile is pnpm's, and the version comparison (SemVer 2.0.0) is written here, with no dependency.
//
//   node scripts/warden/npm-audit.mjs [--database <clone>] [--lockfile pnpm-lock.yaml] [--output report.json]
//
// The database comes from `--database`, from `WARDEN_GHSA_DATABASE`, or from the workstation (`git config warden.ghsa
// <clone>`). The check fails on a HIGH or CRITICAL advisory, on data it cannot read (never taken as healthy) and on a
// database older than 48 hours. It counts dev dependencies. `verify.mjs` runs it when the lockfile changes and in
// `all`, and says the step is skipped without a clone.
//
// The clone lives outside the repository. Only advisories reviewed by GitHub are used, and it keeps only them:
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/github/advisory-database.git <folder>
//   git -C <folder> sparse-checkout set advisories/github-reviewed
// Refresh it before verifying: `git -C <folder> pull --depth 1`.
//
// What it does not tell: whether the vulnerable function is reached; anything beyond the database revision on the
// workstation.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, stationSetting } from './config.mjs';
import { t } from './messages.mjs';

// SemVer 2.0.0: the version, its pre-release identifiers, a build metadata that does not count.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function lireVersion(texte) {
  const m = SEMVER.exec(String(texte));
  if (!m) return null;
  return { noyau: [m[1], m[2], m[3]].map(BigInt), pre: m[4] ? m[4].split('.') : [] };
}

export const valid = (texte) => lireVersion(texte) !== null;

/** -1, 0 or 1, by SemVer 2.0.0 precedence (§11). */
export function compare(a, b) {
  const x = lireVersion(a), y = lireVersion(b);
  if (!x || !y) throw new Error(`Unreadable version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x.noyau[i] !== y.noyau[i]) return x.noyau[i] < y.noyau[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) < BigInt(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const lt = (a, b) => compare(a, b) < 0;
const gte = (a, b) => compare(a, b) >= 0;
const gt = (a, b) => compare(a, b) > 0;

export function npmVersionInRange(version, range) {
  if (!valid(version)) throw new Error(`Unreadable npm version: ${version}`);
  if (!['SEMVER', 'ECOSYSTEM'].includes(range.type)) throw new Error(`Unsupported range: ${range.type}`);
  const events = (range.events ?? []).map((event) => {
    const entries = Object.entries(event);
    if (entries.length !== 1) throw new Error('An OSV event carries one boundary');
    const [kind, boundary] = entries[0];
    if (!['introduced', 'fixed', 'last_affected', 'limit'].includes(kind)) throw new Error(`Unknown boundary: ${kind}`);
    if (!(kind === 'introduced' && boundary === '0') && !(kind === 'limit' && boundary === '*') && !valid(boundary)) {
      throw new Error(`Unreadable boundary: ${boundary}`);
    }
    return { kind, boundary };
  });
  if (!events.some((e) => e.kind === 'introduced')) throw new Error('Missing introduced boundary');
  if (events.some((e) => e.kind === 'fixed') && events.some((e) => e.kind === 'last_affected')) {
    throw new Error('An OSV range mixes fixed and last_affected');
  }
  const limits = events.filter((e) => e.kind === 'limit');
  if (limits.length && !limits.some((e) => e.boundary === '*' || lt(version, e.boundary))) return false;
  const changes = events.filter((e) => e.kind !== 'limit').sort((a, b) => {
    if (a.boundary === b.boundary) return 0;
    if (a.boundary === '0') return -1;
    if (b.boundary === '0') return 1;
    return compare(a.boundary, b.boundary);
  });
  let vulnerable = false;
  for (const e of changes) {
    if (e.kind === 'introduced' && (e.boundary === '0' || gte(version, e.boundary))) vulnerable = true;
    else if (e.kind === 'fixed' && gte(version, e.boundary)) vulnerable = false;
    else if (e.kind === 'last_affected' && gt(version, e.boundary)) vulnerable = false;
  }
  return vulnerable;
}

export function npmVersionAffected(version, affected) {
  // database_specific.last_known_affected_version_range is descriptive: it does not widen the formal range of another
  // major version (Vite 8 <= 8.0.4 does not make an already fixed Vite 7.3.6 vulnerable again).
  const ranges = affected.ranges ?? [];
  const versions = affected.versions ?? [];
  if (!ranges.length && !versions.length) throw new Error('Neither versions nor ranges');
  const matches = ranges.map((range) => npmVersionInRange(version, range));
  return versions.includes(version) || matches.some(Boolean);
}

/** The packages of the pnpm lockfile (format 6 and up): its `packages` section, one `name@version` entry per package.
 *  An entry with no SemVer version (a link, a tarball, a git repository) is unqualified: the check stops. */
export function lockPackages(texte) {
  const format = /^lockfileVersion:\s*['"]?(\d+)(?:\.\d+)?['"]?\s*$/m.exec(texte)?.[1];
  if (!format || Number(format) < 6) throw new Error('A pnpm lockfile in format 6 or later is required');
  const lignes = texte.split(/\r?\n/);
  const debut = lignes.indexOf('packages:');
  if (debut < 0) throw new Error('The lockfile has no packages section');
  const packages = [];
  for (const ligne of lignes.slice(debut + 1)) {
    if (/^\S/.test(ligne)) break;
    const cle = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'"][^:]*)):\s*$/.exec(ligne);
    if (!cle) continue;
    const entree = cle[1] ?? cle[2] ?? cle[3];
    const at = entree.lastIndexOf('@');
    const name = entree.slice(0, at), version = entree.slice(at + 1);
    if (at <= 0 || !valid(version)) throw new Error(`Unqualified package: ${entree}`);
    packages.push({ name, version, path: entree });
  }
  if (!packages.length) throw new Error('Empty package inventory');
  return packages;
}

export function matchNpmAdvisory(advisory, packages) {
  const findings = [], unqualified = [];
  if (advisory.withdrawn) return { findings, unqualified };
  for (const entry of advisory.affected ?? []) {
    if (entry.package?.ecosystem !== 'npm') continue;
    for (const pkg of packages.filter((p) => p.name === entry.package.name)) {
      try {
        if (npmVersionAffected(pkg.version, entry)) {
          const severity = advisory.database_specific?.severity ?? 'UNKNOWN';
          findings.push({ id: advisory.id, severity, package: pkg, summary: advisory.summary,
            reviewed: !!advisory.database_specific?.github_reviewed,
            ranges: entry.ranges ?? [], versions: entry.versions ?? [],
            url: `https://github.com/advisories/${advisory.id}` });
          if (!['LOW', 'MODERATE', 'HIGH', 'CRITICAL'].includes(severity)) throw new Error('Unqualified severity');
        }
      } catch (error) {
        unqualified.push({ id: advisory.id, package: pkg, reason: error.message });
      }
    }
  }
  return { findings, unqualified };
}

function* advisoryFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* advisoryFiles(file);
    else if (entry.isFile() && entry.name.endsWith('.json')) yield file;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function auditNpmLockLocally({ lockfile, database, now = new Date(), maxAgeHours = 48 }) {
  if (!(maxAgeHours > 0) || !Number.isFinite(maxAgeHours)) throw new Error('Invalid maximum database age');
  const git = (args) => execFileSync('git', ['-C', database, ...args], { encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const committedAt = git(['show', '-s', '--format=%cI', 'HEAD']);
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('The advisory database has local changes');
  const ageHours = (now - new Date(committedAt)) / 3_600_000;
  const bytes = readFileSync(lockfile);
  const packages = lockPackages(bytes.toString('utf8'));
  const names = new Set(packages.map((p) => p.name));
  const findings = new Map(), unqualified = [], examined = [];
  let files = 0, npmAdvisories = 0, withdrawn = 0;
  for (const file of advisoryFiles(path.join(database, 'advisories'))) {
    files++;
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes('"npm"')) continue;
    const advisory = JSON.parse(raw);
    const entries = (advisory.affected ?? []).filter((a) => a.package?.ecosystem === 'npm');
    if (!entries.length) continue;
    npmAdvisories++;
    if (advisory.withdrawn) { withdrawn++; continue; }
    if (!entries.some((a) => names.has(a.package.name))) continue;
    examined.push({ id: advisory.id, sha256: sha256(raw), source: path.relative(database, file) });
    const result = matchNpmAdvisory(advisory, packages);
    unqualified.push(...result.unqualified);
    for (const finding of result.findings) findings.set(`${finding.id}:${finding.package.path}`, finding);
  }
  if (!npmAdvisories || !examined.length) throw new Error('No applicable npm advisory in the database');
  if (!Number.isFinite(ageHours) || ageHours < -1 || ageHours > maxAgeHours) {
    unqualified.push({ reason: 'Advisory database stale or wrongly dated', committedAt, ageHours });
  }
  const matches = [...findings.values()];
  return { schemaVersion: 1, checkedAt: now.toISOString(),
    source: { url: 'https://github.com/github/advisory-database', revision, committedAt, ageHours,
      maxAgeHours, license: 'CC-BY-4.0', networkDuringMatch: false },
    lockfileSha256: sha256(bytes), matcherSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    packageInstances: packages.length, uniquePackages: names.size, files, npmAdvisories, withdrawn,
    findings: matches, unqualified, examined,
    status: unqualified.length || matches.some((f) => ['HIGH', 'CRITICAL'].includes(f.severity)) ? 'failed' : 'passed',
    limits: ['Compares declared versions, not whether vulnerable functions are reachable.',
      'Counts dev and optional dependencies; certifies neither node_modules nor the bundled code.',
      'Covers the public revision of the downloaded database, nothing more.'] };
}

// The advisory database clone on this workstation: the variable first, then the workstation setting. Null without one.
export function advisoryDatabase() {
  return process.env.WARDEN_GHSA_DATABASE || stationSetting('ghsa');
}

function option(args, nom) {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const database = option(args, '--database') ?? advisoryDatabase();
    const lockfile = option(args, '--lockfile') ?? path.join(ROOT, 'pnpm-lock.yaml');
    const output = option(args, '--output');
    if (!database) throw new Error(t('npm.no_database'));
    const result = auditNpmLockLocally({ lockfile, database });
    if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(t(result.status === 'passed' ? 'npm.passed' : 'npm.failed', { packages: result.packageInstances, examined: result.examined.length,
      advisories: result.npmAdvisories, revision: result.source.revision.slice(0, 12), hours: Math.round(result.source.ageHours) }));
    for (const f of result.findings) console.log(`  ${f.severity.padEnd(8)} ${f.id}  ${f.package.name}@${f.package.version}  ${f.summary ?? ''}`);
    for (const u of result.unqualified) console.log(`  ${t('npm.unqualified')} ${u.id ?? ''} ${u.package ? `${u.package.name}@${u.package.version}` : ''} ${u.reason}`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
