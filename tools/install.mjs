#!/usr/bin/env node
// Installs the kit in a project, or updates it.
//
//   node tools/install.mjs [<project>] [--dry-run] [--locale en|fr] [--no-adopt]
//
// At adoption (the configuration not yet on the remote main branch), what the repository already holds is named as
// debts, and each project step is tried once (tools/adopt.mjs). `--no-adopt` copies the kit and its models only.
// The project is put once on the workstation list the interface covers (`warden.projects`), by its main root.
//
// The kit scripts (scripts/warden/) are copied as is, with their fingerprint manifest. A kit script edited in the
// project, or a file unknown to the kit in that folder, stops the install without writing anything: the gap becomes a
// configuration option or a kit fix. The models (AGENTS.md, CLAUDE.md, .githooks/, config/) are installed only when
// missing, adapted to what the project holds; a model already there is kept as is. AGENTS.md and CLAUDE.md follow the
// locale (English or French); everything else is canonical English.

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adoptDebts } from './adopt.mjs';
import { folderFingerprints, listOnWorkstation, MANIFEST } from '../kit/scripts/warden/kit.mjs';
import { resolveLocale } from '../kit/scripts/warden/messages.mjs';
import { KIT, kitManifest, KIT_SCRIPTS } from './fingerprints.mjs';

const LOCKFILES = { 'pnpm-lock.yaml': 'pnpm', 'package-lock.json': 'npm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
// What triggers the project steps: everything except the kit, the configuration, the docs, the root .md files and the
// two Git files the install touches: the install's own commit runs no product step.
const OUTSIDE_KIT = '^(?!(scripts/warden|\\.githooks|config|docs)/|[^/]+\\.md$|\\.git(ignore|attributes)$)';
const RUST_FULL = ['^Cargo\\.(toml|lock)$', '^rust-toolchain(\\.toml)?$', '^\\.cargo/'];
// The pre-push hook as kits up to 0.3.0 wrote it: it ran every script test, the kit's own included, on each push.
const PREVIOUS_PUSH_HOOKS = [
  [
    '#!/bin/sh',
    '# Git gives on standard input what it pushes: the push verification reads it.',
    '# The rules on the whole tree, the script guards, the disk (warning only), then the scope of the push.',
    'refs=$(cat)',
    'node scripts/warden/rules.mjs || exit 1',
    'node --test "scripts/**/*.test.mjs" || exit 1',
    'node scripts/warden/disk.mjs guard --warn',
    'printf \'%s\\n\' "$refs" | node scripts/warden/verify.mjs push',
    '',
  ].join('\n'),
];

const MESSAGES = {
  en: {
    not_git: '{path} is not in a Git repository: git init first.',
    refused: 'Install refused, nothing is written: scripts/warden/ differs from the kit.',
    edited: '  edited: scripts/warden/{name}',
    unknown: '  unknown to the kit: scripts/warden/{name}',
    refused_advice: 'A project setting goes into config/; a kit fix is made in the Warden repository. Put these files back as the kit installed them, or move them out of the folder, then install again.',
    header: '{dry}Kit {name} {version} in {root}',
    dry: 'Dry run, nothing is written. ',
    scripts: '  scripts/warden/: {count} files{removed}',
    removed: ', {count} removed: {list}',
    installed: '  installed: {list}',
    kept: '  kept as is: {list}',
    allowed: '  allowed at the root because present, to review in config/rules.json: {list}',
    hook_foreign: '.githooks/{hook} exists and does not run the kit: add the lines of kit/.githooks/{hook}.',
    agents_exists: 'AGENTS.md exists: merge the sections of the model (kit/AGENTS.md) into it, without losing the project rules.',
    claude_rules: 'CLAUDE.md carries rules: move them to AGENTS.md, then reduce it to the pointer to AGENTS.md.',
    hooks_path: 'core.hooksPath is already "{path}": it is not changed. Call the kit hooks from there, or move to .githooks.',
    next: '\nNext: review config/rules.json and config/factory.json, run node scripts/warden/rules.mjs, then commit these files.',
    debts: '  {count} advisory(ies) present before Warden, named as debts in {file}: {list}. A new advisory still blocks.',
    debts_unread: 'the {check} advisories could not be read ({error}): the first push may be refused for advisories older than Warden. Run the install again once the check runs.',
    deny_others: 'the dependency check also refuses what is not an advisory: {list}. Fix it, or name an exception in config/deny.toml, before the first push.',
    rules_debts: '  {count} finding(s) of the rules present before Warden, named in config/rules.json (_adopted): {lines} file(s) over the lines, {size} over the size, {secrets} secret pattern(s). What is new still refuses.',
    rules_versions: 'the manifests do not state one version ({detail}): the single-version rule is left out until they agree. The install edits no manifest.',
    rules_keys: 'possible keys already committed, named as exceptions to review: {list}. A real key is revoked, whatever Warden says.',
    rules_left: 'the rules still refuse: {list}. Fix them before the first commit.',
    rules_unread: 'the rules could not be read ({error}).',
    steps_failing: '{count} step(s) fail on the repository as it stands, left out of config/factory.json (_adopted.failing) until repaired: {list}.',
    steps_unread: 'the project steps could not be tried ({error}): they stay declared, try them before the first push.',
    listed: '  listed on this workstation, the interface shows it (git config --global warden.projects): {root}',
    list_failed: 'the project could not be listed on this workstation: git config --global --add warden.projects "{root}" puts it on the interface.',
  },
  fr: {
    not_git: '{path} n’est pas dans un dépôt Git : git init d’abord.',
    refused: 'Pose refusée, rien n’est écrit : scripts/warden/ s’écarte du kit.',
    edited: '  retouché : scripts/warden/{name}',
    unknown: '  inconnu du kit : scripts/warden/{name}',
    refused_advice: 'Un réglage propre au projet va dans config/ ; un correctif du kit se fait dans le dépôt Warden. Remettre ces fichiers comme le kit les a posés, ou les sortir du dossier, puis reposer.',
    header: '{dry}Kit {name} {version} dans {root}',
    dry: 'Simulation, rien n’est écrit. ',
    scripts: '  scripts/warden/ : {count} fichiers{removed}',
    removed: ', {count} retiré(s) : {list}',
    installed: '  posés : {list}',
    kept: '  gardés tels quels : {list}',
    allowed: '  admis à la racine parce que présents, à relire dans config/rules.json : {list}',
    hook_foreign: '.githooks/{hook} existe et ne joue pas le kit : y reporter les lignes de kit/.githooks/{hook}.',
    agents_exists: 'AGENTS.md existe : y reporter les sections du modèle (kit/AGENTS.fr.md), sans perdre les règles du projet.',
    claude_rules: 'CLAUDE.md porte des règles : les reporter dans AGENTS.md, puis le réduire au renvoi vers AGENTS.md.',
    hooks_path: 'core.hooksPath vaut déjà « {path} » : il n’est pas changé. Y appeler les crochets du kit, ou passer à .githooks.',
    next: '\nEnsuite : relire config/rules.json et config/factory.json, lancer node scripts/warden/rules.mjs, puis commiter ces fichiers.',
    debts: '  {count} avis présent(s) avant Warden, nommé(s) comme dettes dans {file} : {list}. Un avis nouveau bloque toujours.',
    debts_unread: 'les avis {check} n’ont pas pu être lus ({error}) : la première poussée peut être refusée pour des avis antérieurs à Warden. Relancer la pose une fois ce contrôle en état de tourner.',
    deny_others: 'le contrôle des dépendances refuse aussi ce qui n’est pas un avis : {list}. Le corriger, ou nommer une exception dans config/deny.toml, avant la première poussée.',
    rules_debts: '  {count} écart(s) au règlement présent(s) avant Warden, nommé(s) dans config/rules.json (_adopted) : {lines} fichier(s) au-delà des lignes, {size} au-delà de la taille, {secrets} motif(s) de secret. Ce qui est nouveau refuse toujours.',
    rules_versions: 'les manifestes ne disent pas une seule version ({detail}) : la règle de version unique est laissée de côté jusqu’à leur accord. La pose ne modifie aucun manifeste.',
    rules_keys: 'clés possibles déjà commitées, nommées en exceptions à relire : {list}. Une vraie clé se révoque, quoi que dise Warden.',
    rules_left: 'le règlement refuse encore : {list}. À corriger avant le premier commit.',
    rules_unread: 'le règlement n’a pas pu être lu ({error}).',
    steps_failing: '{count} étape(s) échouent sur le dépôt tel qu’il est, sorties de config/factory.json (_adopted.failing) jusqu’à leur réparation : {list}.',
    steps_unread: 'les étapes du projet n’ont pas pu être essayées ({error}) : elles restent déclarées, les essayer avant la première poussée.',
    listed: '  inscrit sur la liste du poste, l’interface le montre (git config --global warden.projects) : {root}',
    list_failed: 'le projet n’a pas pu être inscrit sur la liste du poste : git config --global --add warden.projects "{root}" le montre dans l’interface.',
  },
};

function git(root, args) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim() };
}

const union = (a, b) => [...new Set([...a, ...b])];
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

// What sits at the project root: tracked, or untracked and not ignored.
export function rootContent(root) {
  const list = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).out.split('\0').filter(Boolean);
  const dirs = new Set();
  const files = new Set();
  for (const path of list) {
    const [first, ...rest] = path.split('/');
    (rest.length ? dirs : files).add(first);
  }
  return { dirs: [...dirs].sort(), files: [...files].sort() };
}

// The scripts already installed: what was edited (a fingerprint no version knows), what is unknown to the kit, and
// what a previous version installed that this one no longer does.
export function judgeScripts(folder, next) {
  if (!existsSync(folder)) return { edited: [], unknown: [], toRemove: [], previous: null };
  const text = readText(join(folder, MANIFEST));
  const previous = text ? JSON.parse(text) : { files: {} };
  const edited = [];
  const unknown = [];
  const toRemove = [];
  for (const [name, value] of Object.entries(folderFingerprints(folder))) {
    const known = name in previous.files || name in next.files;
    if (!known) unknown.push(name);
    else if (previous.files[name] !== value && next.files[name] !== value) edited.push(name);
    else if (!(name in next.files)) toRemove.push(name);
  }
  return { edited, unknown, toRemove, previous: previous.version ?? null };
}

// The version a project manifest declares, and how to read it (see the `versions` section of the rules).
function versionReadings(root) {
  const readings = [];
  const pkg = readText(join(root, 'package.json'));
  if (pkg && JSON.parse(pkg).version) readings.push({ file: 'package.json', read: 'json:version' });
  const cargo = readText(join(root, 'Cargo.toml'));
  if (cargo && /^\[workspace\.package\][^[]*^version\s*=/ms.test(cargo)) readings.push({ file: 'Cargo.toml', read: 'toml:workspace.package.version' });
  else if (cargo && /^\[package\][^[]*^version\s*=\s*"/ms.test(cargo)) readings.push({ file: 'Cargo.toml', read: 'toml:package.version' });
  return readings;
}

// The model rules, opened to what the project already holds. What is allowed because present is returned apart: the
// person reviews it.
export function adaptRules(model, root, content) {
  const rules = structuredClone(model);
  const forbidden = new Set(rules.forbidden_segments);
  const locks = content.files.filter((f) => f in LOCKFILES);
  // The lockfile present names the project's package manager: it is no longer forbidden, and it escapes the ceilings.
  if (locks.length === 1) {
    rules.forbidden_lockfiles = rules.forbidden_lockfiles.filter((f) => LOCKFILES[f] !== LOCKFILES[locks[0]]);
    rules.lines_exempt = union(rules.lines_exempt, locks);
    rules.size_exceptions[locks[0]] ??= 2048;
  }
  if (content.files.includes('Cargo.lock')) {
    rules.lines_exempt = union(rules.lines_exempt, ['Cargo.lock']);
    rules.size_exceptions['Cargo.lock'] ??= 2048;
  }
  const dirs = content.dirs.filter((d) => !forbidden.has(d) && !rules.root.dirs.includes(d));
  const files = content.files.filter((f) => !rules.root.files.includes(f) && !rules.forbidden_lockfiles.includes(f));
  rules.root.dirs = union(rules.root.dirs, dirs);
  rules.root.files = union(rules.root.files, files);
  if (!content.files.includes('README.md')) rules.required = rules.required.filter((f) => f !== 'README.md');
  const versions = versionReadings(root);
  if (versions.length > 1) rules.versions = versions;
  return { rules, allowed: [...dirs.map((d) => `${d}/`), ...files] };
}

function mainBranch(root) {
  const tracked = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (tracked.ok && tracked.out) return tracked.out.split('/').slice(1).join('/');
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  return ['main', 'master', 'trunk'].includes(current) ? current : 'main';
}

// The model factory, set to what the project uses: Rust, its npm manager, its test and build scripts. `cargoDeny` says
// whether cargo-deny is on the workstation.
export function adaptFactory(model, root, content, { cargoDeny = false } = {}) {
  const factory = structuredClone(model);
  factory.main_branch = mainBranch(root);
  const remotes = git(root, ['remote']).out.split('\n').filter(Boolean);
  factory.remote = remotes.includes('origin') || !remotes.length ? 'origin' : remotes[0];
  if (content.files.includes('Cargo.toml')) {
    factory.verify.rust = { full_on: RUST_FULL, clippy: true, tests: true, separate: [], deny: cargoDeny ? 'config/deny.toml' : null };
  }
  const pkg = readText(join(root, 'package.json'));
  if (pkg) {
    const json = JSON.parse(pkg);
    const lock = content.files.find((f) => f in LOCKFILES);
    const manager = lock ? LOCKFILES[lock] : (json.packageManager ?? 'npm').split('@')[0];
    if (lock === 'pnpm-lock.yaml') factory.verify.npm_advisories = { lockfile: lock };
    if (lock) {
      const frozen = { pnpm: ['pnpm', 'install', '--frozen-lockfile'], npm: ['npm', 'ci'], yarn: ['yarn', 'install', '--immutable'], bun: ['bun', 'install', '--frozen-lockfile'] }[manager];
      factory.train.install = { lockfile: lock, command: frozen };
    }
    const scripts = json.scripts ?? {};
    if (scripts.test && !/no test specified/.test(scripts.test)) factory.verify.steps.push({ title: 'Project tests', when: [OUTSIDE_KIT], command: [manager, 'test'] });
    if (scripts.build) factory.verify.steps.push({ title: 'Build', when: [OUTSIDE_KIT], command: [manager, 'run', 'build'] });
  }
  return factory;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Everything the install would do, writing nothing: files to write, files to remove, and what is said.
export function installPlan(root, { cargoDeny = false, locale = 'en' } = {}) {
  const say = (key, vars = {}) => MESSAGES[locale][key].replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w));
  const manifest = kitManifest();
  const kitFolder = join(root, 'scripts', 'warden');
  const judgement = judgeScripts(kitFolder, manifest);
  if (judgement.edited.length || judgement.unknown.length) return { refused: judgement, manifest, say };

  const write = [];
  for (const name of readdirSync(KIT_SCRIPTS)) write.push({ path: `scripts/warden/${name}`, from: join(KIT_SCRIPTS, name) });
  const remove = judgement.toRemove.map((name) => `scripts/warden/${name}`);
  const content = rootContent(root);
  const kept = [];
  const allowed = [];
  const model = (path, make) => {
    if (existsSync(join(root, path))) kept.push(path);
    else write.push({ path, text: make() });
  };
  const localized = (name) => (locale === 'fr' && existsSync(join(KIT, name.replace('.md', '.fr.md'))) ? name.replace('.md', '.fr.md') : name);
  model('config/rules.json', () => {
    const adapted = adaptRules(JSON.parse(readFileSync(join(KIT, 'config', 'rules.json'), 'utf8')), root, content);
    allowed.push(...adapted.allowed);
    return json(adapted.rules);
  });
  model('config/factory.json', () => json(adaptFactory(JSON.parse(readFileSync(join(KIT, 'config', 'factory.json'), 'utf8')), root, content, { cargoDeny })));
  model('config/disk.json', () => readFileSync(join(KIT, 'config', 'disk.json'), 'utf8'));
  if (content.files.includes('Cargo.toml') && cargoDeny) model('config/deny.toml', () => readFileSync(join(KIT, 'config', 'deny.toml'), 'utf8'));
  model('.githooks/pre-commit', () => readFileSync(join(KIT, '.githooks', 'pre-commit'), 'utf8'));
  // A hook left exactly as an earlier kit wrote it is the kit's, not the project's: it follows the kit.
  const pushHook = readText(join(root, '.githooks', 'pre-push'));
  if (pushHook !== null && PREVIOUS_PUSH_HOOKS.includes(pushHook.replaceAll('\r\n', '\n'))) {
    write.push({ path: '.githooks/pre-push', text: readFileSync(join(KIT, '.githooks', 'pre-push'), 'utf8') });
  } else {
    model('.githooks/pre-push', () => readFileSync(join(KIT, '.githooks', 'pre-push'), 'utf8'));
  }
  model('AGENTS.md', () => readFileSync(join(KIT, localized('AGENTS.md')), 'utf8').replaceAll('{{project}}', basename(root)));
  model('CLAUDE.md', () => readFileSync(join(KIT, localized('CLAUDE.md')), 'utf8'));

  const warnings = [];
  for (const hook of ['pre-commit', 'pre-push']) {
    const text = kept.includes(`.githooks/${hook}`) ? readText(join(root, '.githooks', hook)) : null;
    if (text !== null && !text.includes('scripts/warden/')) warnings.push(say('hook_foreign', { hook }));
  }
  if (kept.includes('AGENTS.md')) warnings.push(say('agents_exists'));
  const claude = kept.includes('CLAUDE.md') ? readText(join(root, 'CLAUDE.md')) : null;
  if (claude !== null && (claude.split('\n').filter((l) => l.trim()).length > 3 || !claude.includes('AGENTS.md'))) warnings.push(say('claude_rules'));
  const hooksPath = git(root, ['config', '--get', 'core.hooksPath']).out;
  if (hooksPath && hooksPath !== '.githooks') warnings.push(say('hooks_path', { path: hooksPath }));
  return { write, remove, kept, allowed, warnings, manifest, previous: judgement.previous, hooks: !hooksPath || hooksPath === '.githooks', say };
}

function apply(root, plan) {
  for (const { path, from, text } of plan.write) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if (from) copyFileSync(from, target);
    else writeFileSync(target, text);
    if (path.startsWith('.githooks/')) chmodSync(target, 0o755);
  }
  for (const path of plan.remove) rmSync(join(root, path), { force: true });
  const ignore = readText(join(root, '.gitignore')) ?? '';
  // config/disk.local.json names one workstation: never committed.
  const missing = ['.work/', '.input/', 'config/disk.local.json'].filter((l) => !ignore.split(/\r?\n/).includes(l));
  if (missing.length) appendFileSync(join(root, '.gitignore'), `${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  // A sh hook with Windows line endings no longer runs: the kit hooks stay LF, whatever workstation clones.
  const attributes = readText(join(root, '.gitattributes')) ?? '';
  if (!attributes.split(/\r?\n/).includes('.githooks/* text eol=lf')) {
    appendFileSync(join(root, '.gitattributes'), `${attributes && !attributes.endsWith('\n') ? '\n' : ''}.githooks/* text eol=lf\n`);
  }
  mkdirSync(join(root, '.work'), { recursive: true });
  if (plan.hooks) git(root, ['config', 'core.hooksPath', '.githooks']);
}

// What the project carried before Warden, said once: the debts named, and what still refuses.
function sayDebts(report, say) {
  const rules = report.rules;
  if (rules?.error) console.log(`  ! ${say('rules_unread', { error: rules.error })}`);
  else if (rules) {
    const { named } = rules;
    if (rules.count) console.log(say('rules_debts', { count: rules.count, lines: named.lines.length, size: named.size.length, secrets: named.secret.length }));
    if (named.versions) console.log(`  ! ${say('rules_versions', { detail: named.versions })}`);
    const keys = named.secret.filter((s) => s.kind !== 'machine path').map((s) => `${s.path} (${s.kind})`);
    if (keys.length) console.log(`  ! ${say('rules_keys', { list: keys.join(', ') })}`);
    if (rules.left.length) console.log(`  ! ${say('rules_left', { list: rules.left.map((f) => `[${f.rule}] ${f.path}`).join(', ') })}`);
  }
  const steps = report.steps;
  if (steps?.error) console.log(`  ! ${say('steps_unread', { error: steps.error })}`);
  else if (steps?.failing?.length) console.log(`  ! ${say('steps_failing', { count: steps.failing.length, list: steps.failing.map((s) => `${s.title}: ${s.first_error.replace(/[.\s]+$/, '')}`).join('; ') })}`);
  for (const [kind, file, check] of [['rust', 'config/deny.toml', 'Rust (cargo deny)'], ['npm', 'config/factory.json', 'npm']]) {
    const found = report[kind];
    if (!found) continue;
    if (found.error) {
      console.log(`  ! ${say('debts_unread', { check, error: found.error })}`);
      continue;
    }
    if (found.debts.length) console.log(say('debts', { count: found.debts.length, file, list: found.debts.map((d) => d.id).join(', ') }));
    if (found.others.length) console.log(`  ! ${say('deny_others', { list: found.others.join('; ') })}`);
  }
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const locale = argv.includes('--locale') ? argv[argv.indexOf('--locale') + 1] : resolveLocale();
  const asked = resolve(argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--locale') ?? process.cwd());
  const top = git(asked, ['rev-parse', '--show-toplevel']);
  const fallback = MESSAGES[locale] ? locale : 'en';
  if (!top.ok) {
    console.error(MESSAGES[fallback].not_git.replace('{path}', asked));
    return false;
  }
  const root = resolve(top.out);
  const cargoDeny = spawnSync('cargo', ['deny', '--version'], { windowsHide: true }).status === 0;
  const plan = installPlan(root, { cargoDeny, locale: fallback });
  const { say } = plan;
  if (plan.refused) {
    console.error(say('refused'));
    for (const name of plan.refused.edited) console.error(say('edited', { name }));
    for (const name of plan.refused.unknown) console.error(say('unknown', { name }));
    console.error(say('refused_advice'));
    return false;
  }
  const version = plan.previous && plan.previous !== plan.manifest.version ? `${plan.previous} → ${plan.manifest.version}` : plan.manifest.version;
  console.log(say('header', { dry: dryRun ? say('dry') : '', name: plan.manifest.name, version, root }));
  console.log(say('scripts', { count: Object.keys(plan.manifest.files).length + 1, removed: plan.remove.length ? say('removed', { count: plan.remove.length, list: plan.remove.join(', ') }) : '' }));
  const installed = plan.write.filter((w) => !w.path.startsWith('scripts/warden/')).map((w) => w.path);
  if (installed.length) console.log(say('installed', { list: installed.join(', ') }));
  if (plan.kept.length) console.log(say('kept', { list: plan.kept.join(', ') }));
  if (plan.allowed.length) console.log(say('allowed', { list: plan.allowed.join(', ') }));
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);
  if (!dryRun) {
    apply(root, plan);
    if (!argv.includes('--no-adopt')) sayDebts(adoptDebts(root), say);
    const listed = listOnWorkstation(root);
    if (listed.state === 'listed') console.log(say('listed', { root: listed.root }));
    if (listed.state === 'failed') console.log(`  ! ${say('list_failed', { root: listed.root })}`);
  }
  console.log(say('next'));
  return true;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) process.exitCode = main(process.argv.slice(2)) ? 0 : 1;
