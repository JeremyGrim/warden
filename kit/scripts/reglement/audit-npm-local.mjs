// Les avis de sécurité des dépendances npm, comparés sur le poste au verrou pnpm. `pnpm audit` envoie la liste des
// dépendances à un service en ligne, ce script n'envoie rien. Il lit un clone public de la base GitHub Advisory Database (format OSV), téléchargé à part, et l'évalue selon
// https://ossf.github.io/osv-schema/#evaluation. Le verrou est celui de pnpm, et la comparaison de versions (SemVer
// 2.0.0) est écrite ici, sans dépendance.
//
//   node scripts/reglement/audit-npm-local.mjs [--base <clone>] [--verrou pnpm-lock.yaml] [--sortie rapport.json]
//
// La base vient de `--base`, de `REGLEMENT_GHSA_DATABASE`, ou du poste (`git config reglement.ghsa <clone>`). Le contrôle échoue sur un avis HIGH ou CRITICAL, sur une
// donnée qu'il ne sait pas lire (jamais tenue pour saine) et sur une base de plus de 48 heures. Il compte les
// dépendances de développement. `verifier.mjs` le joue quand le verrou change et dans `tout`, et dit l'étape sautée
// sans clone.
//
// Le clone vit hors du dépôt. Seuls les avis relus par GitHub servent, et il se limite à eux :
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/github/advisory-database.git <dossier>
//   git -C <dossier> sparse-checkout set advisories/github-reviewed
// On le rafraîchit avant de vérifier : `git -C <dossier> pull --depth 1`.
//
// Ce qu'il ne dit pas : si la fonction vulnérable est atteinte ; au-delà de la révision de la base qu'on a sur le poste.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RACINE, reglageDuPoste } from './config.mjs';

// SemVer 2.0.0 : la version, ses identifiants de préversion, une métadonnée de construction qui ne compte pas.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function lireVersion(texte) {
  const m = SEMVER.exec(String(texte));
  if (!m) return null;
  return { noyau: [m[1], m[2], m[3]].map(BigInt), pre: m[4] ? m[4].split('.') : [] };
}

export const valid = (texte) => lireVersion(texte) !== null;

/** -1, 0 ou 1, selon la précédence de SemVer 2.0.0 (§11). */
export function compare(a, b) {
  const x = lireVersion(a), y = lireVersion(b);
  if (!x || !y) throw new Error(`Version illisible : ${x ? b : a}`);
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
  if (!valid(version)) throw new Error(`Version npm illisible : ${version}`);
  if (!['SEMVER', 'ECOSYSTEM'].includes(range.type)) throw new Error(`Intervalle non pris en charge : ${range.type}`);
  const events = (range.events ?? []).map((event) => {
    const entries = Object.entries(event);
    if (entries.length !== 1) throw new Error('Un événement OSV porte une seule borne');
    const [kind, boundary] = entries[0];
    if (!['introduced', 'fixed', 'last_affected', 'limit'].includes(kind)) throw new Error(`Borne inconnue : ${kind}`);
    if (!(kind === 'introduced' && boundary === '0') && !(kind === 'limit' && boundary === '*') && !valid(boundary)) {
      throw new Error(`Borne illisible : ${boundary}`);
    }
    return { kind, boundary };
  });
  if (!events.some((e) => e.kind === 'introduced')) throw new Error('Borne introduced absente');
  if (events.some((e) => e.kind === 'fixed') && events.some((e) => e.kind === 'last_affected')) {
    throw new Error('Un intervalle OSV mêle fixed et last_affected');
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
  // database_specific.last_known_affected_version_range est descriptif : il n'élargit pas l'intervalle formel d'une
  // autre version majeure (Vite 8 <= 8.0.4 ne rend pas de nouveau vulnérable un Vite 7.3.6 déjà corrigé).
  const ranges = affected.ranges ?? [];
  const versions = affected.versions ?? [];
  if (!ranges.length && !versions.length) throw new Error('Ni versions ni intervalles');
  const matches = ranges.map((range) => npmVersionInRange(version, range));
  return versions.includes(version) || matches.some(Boolean);
}

/** Les paquets du verrou pnpm (format 6 et plus) : sa section `packages`, une entrée `nom@version` par paquet. Une
 *  entrée sans version SemVer (un lien, une archive, un dépôt git) n'est pas qualifiée : le contrôle s'arrête. */
export function lockPackages(texte) {
  const format = /^lockfileVersion:\s*['"]?(\d+)(?:\.\d+)?['"]?\s*$/m.exec(texte)?.[1];
  if (!format || Number(format) < 6) throw new Error('Il faut un verrou pnpm au format 6 ou plus');
  const lignes = texte.split(/\r?\n/);
  const debut = lignes.indexOf('packages:');
  if (debut < 0) throw new Error('Le verrou n’a pas de section packages');
  const packages = [];
  for (const ligne of lignes.slice(debut + 1)) {
    if (/^\S/.test(ligne)) break;
    const cle = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'"][^:]*)):\s*$/.exec(ligne);
    if (!cle) continue;
    const entree = cle[1] ?? cle[2] ?? cle[3];
    const at = entree.lastIndexOf('@');
    const name = entree.slice(0, at), version = entree.slice(at + 1);
    if (at <= 0 || !valid(version)) throw new Error(`Paquet non qualifié : ${entree}`);
    packages.push({ name, version, path: entree });
  }
  if (!packages.length) throw new Error('Inventaire de paquets vide');
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
          if (!['LOW', 'MODERATE', 'HIGH', 'CRITICAL'].includes(severity)) throw new Error('Gravité non qualifiée');
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
  if (!(maxAgeHours > 0) || !Number.isFinite(maxAgeHours)) throw new Error('Âge maximal de la base invalide');
  const git = (args) => execFileSync('git', ['-C', database, ...args], { encoding: 'utf8' }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const committedAt = git(['show', '-s', '--format=%cI', 'HEAD']);
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('La base des avis porte des modifications locales');
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
  if (!npmAdvisories || !examined.length) throw new Error('Aucun avis npm applicable dans la base');
  if (!Number.isFinite(ageHours) || ageHours < -1 || ageHours > maxAgeHours) {
    unqualified.push({ reason: 'Base des avis périmée ou mal datée', committedAt, ageHours });
  }
  const matches = [...findings.values()];
  return { schemaVersion: 1, checkedAt: now.toISOString(),
    source: { url: 'https://github.com/github/advisory-database', revision, committedAt, ageHours,
      maxAgeHours, license: 'CC-BY-4.0', networkDuringMatch: false },
    lockfileSha256: sha256(bytes), matcherSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    packageInstances: packages.length, uniquePackages: names.size, files, npmAdvisories, withdrawn,
    findings: matches, unqualified, examined,
    status: unqualified.length || matches.some((f) => ['HIGH', 'CRITICAL'].includes(f.severity)) ? 'failed' : 'passed',
    limits: ['Compare les versions déclarées, pas l’atteignabilité des fonctions vulnérables.',
      'Compte les dépendances de développement et optionnelles ; ne certifie ni node_modules ni le code assemblé.',
      'Couvre la révision publique de la base téléchargée, rien de plus.'] };
}

// Le clone de la base des avis sur ce poste : la variable d'abord, puis le réglage du poste. Null sans clone.
export function baseDesAvis() {
  return process.env.REGLEMENT_GHSA_DATABASE || reglageDuPoste('ghsa');
}

function option(args, nom) {
  const i = args.indexOf(nom);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const database = option(args, '--base') ?? baseDesAvis();
    const lockfile = option(args, '--verrou') ?? path.join(RACINE, 'pnpm-lock.yaml');
    const sortie = option(args, '--sortie');
    if (!database) throw new Error('La base des avis manque : --base <clone de github/advisory-database>, REGLEMENT_GHSA_DATABASE ou git config reglement.ghsa.');
    const result = auditNpmLockLocally({ lockfile, database });
    if (sortie) writeFileSync(sortie, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Avis npm : ${result.status === 'passed' ? 'rien de bloquant' : 'ÉCHEC'} — ${result.packageInstances} paquets, `
      + `${result.examined.length} avis examinés sur ${result.npmAdvisories}, base ${result.source.revision.slice(0, 12)} `
      + `(${Math.round(result.source.ageHours)} h).`);
    for (const f of result.findings) console.log(`  ${f.severity.padEnd(8)} ${f.id}  ${f.package.name}@${f.package.version}  ${f.summary ?? ''}`);
    for (const u of result.unqualified) console.log(`  NON QUALIFIÉ ${u.id ?? ''} ${u.package ? `${u.package.name}@${u.package.version}` : ''} ${u.reason}`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
