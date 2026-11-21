#!/usr/bin/env node
// The end-to-end trial of the kit on blank projects: the kit installed, commits refused, pushes verified and refused,
// the kit tests spared when the kit did not change, a train of branches with one culprit, its structured refusal and
// its return on a new commit, an incident of the workstation replayed, a red main branch that blames no branch and
// lifts with its repair, a check that could not run and is said once when it persists, a patch version bump, a release, an interrupted train recovered, the history, the
// factory role and the status an agent reads when it joins, and the interface: its reading, a decision answered, one tree
// cleaned, a configuration change deposited and taken up, the plugin version. Nothing is simulated: real repositories, real hooks,
// Cargo and pnpm. The projects live in a temporary folder removed at the end;
// the report stays.
//
//   node tools/e2e.mjs [--output <folder>] [--keep]
//
// The report: <output>/report.md and <output>/verdicts.json, and the log of each step in <output>/logs/.
// A broken step is reported as a check, and the trial goes on.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
const argv = process.argv.slice(2);
const OUTPUT = resolve(argv.includes('--output') ? argv[argv.indexOf('--output') + 1] : mkdtempSync(join(tmpdir(), 'warden-e2e-')));
const TRAY = mkdtempSync(join(tmpdir(), 'warden-e2e-projects-'));
const { NODE_TEST_CONTEXT, ...BASE_ENV } = process.env;
void NODE_TEST_CONTEXT;
const ENV = { ...BASE_ENV, WARDEN_LOCALE: 'en' };
mkdirSync(join(OUTPUT, 'logs'), { recursive: true });

const checks = [];
let count = 0;
let currentStep = '';

// `timeout`, in milliseconds, for a command that waits by design (`watch`): a trial never hangs on it.
function run(program, args, cwd, timeout = undefined) {
  const shell = process.platform === 'win32' && ['pnpm', 'npm'].includes(program);
  const line = shell ? [program, ...args].join(' ') : program;
  const r = spawnSync(line, shell ? [] : args, { cwd, encoding: 'utf8', env: ENV, shell, windowsHide: true, maxBuffer: 1 << 28, timeout });
  count += 1;
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const log = `logs/${String(count).padStart(3, '0')}.txt`;
  writeFileSync(join(OUTPUT, log), `$ ${program} ${args.join(' ')}\n(in ${cwd})\n\n${text}\nexit: ${r.status}\n`);
  return { status: r.status, text, log };
}

const git = (cwd, ...args) => run('git', args, cwd);
const node = (cwd, ...args) => run(process.execPath, args, cwd);

function check(name, ok, detail = '') {
  checks.push({ step: currentStep, check: name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✖'} [${currentStep}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, body) {
  currentStep = name;
  try {
    await body();
  } catch (error) {
    check('the step runs to the end', false, error.message);
  }
}

// `null` removes the file.
function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(root, path), { force: true });
      continue;
    }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const history = (root) => JSON.parse(node(root, 'scripts/warden/status.mjs', '--history', '--json').text);

// The main branch as the remote holds it, in the tree, before a change pushed from there.
function upToDate(root) {
  git(root, 'fetch', '--quiet', 'origin');
  git(root, 'reset', '--quiet', '--hard', 'origin/main');
}

// The slot is given back when the remote carries the commit: wait for it before the next push.
async function slotReleased(root) {
  const slot = join(root, '.work', 'push-slot');
  for (let n = 0; n < 60 && existsSync(slot); n += 1) await new Promise((done) => setTimeout(done, 500));
  return !existsSync(slot);
}

function newRepo(name, files) {
  const root = join(TRAY, name);
  const remote = join(TRAY, `${name}.git`);
  mkdirSync(root);
  run('git', ['init', '--quiet', '--bare', '-b', 'main', remote], TRAY);
  git(root, 'init', '--quiet', '-b', 'main');
  for (const [key, value] of [['user.name', 'e2e'], ['user.email', 'e2e@example.test'], ['commit.gpgsign', 'false']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', remote);
  write(root, files);
  return { root, remote, head: () => run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], TRAY).text.trim() };
}

// The project as it was before the kit: committed and pushed without hooks, then the kit installed and committed.
async function installKit(project, adapt) {
  const { root } = project;
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'The project, before the rules');
  git(root, 'push', '--quiet', 'origin', 'main');
  // Through the command npx runs (tools/cli.mjs), as whoever installs without the plugin.
  const install = node(root, join(REPO, 'tools', 'cli.mjs'), 'setup', root);
  check('warden setup installs the kit', install.status === 0, install.log);
  check('the kit and its models are installed', ['scripts/warden/kit.json', 'config/rules.json', 'config/factory.json', '.githooks/pre-push', 'AGENTS.md'].every((c) => existsSync(join(root, c))));
  adapt?.(root);
  const rules = node(root, 'scripts/warden/rules.mjs');
  check('the installed project respects its rules', rules.status === 0, rules.log);
  git(root, 'add', 'scripts/warden', '.githooks', 'config', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.gitattributes');
  const commit = git(root, 'commit', '--quiet', '-m', 'The repository rules');
  check('the kit commit passes the hook', commit.status === 0, commit.log);
  const push = git(root, 'push', 'origin', 'main');
  check('the kit push passes the hook and arrives', push.status === 0 && project.head() === git(root, 'rev-parse', 'HEAD').text.trim(), push.log);
  check('the slot is given back', await slotReleased(root));
}

function refusedCommit(root, path, content, rule) {
  write(root, { [path]: content });
  git(root, 'add', path);
  const r = git(root, 'commit', '--quiet', '-m', 'refused');
  check(`a commit is refused: ${rule}`, r.status !== 0 && r.text.includes(`[${rule}] ${path}`), r.log);
  git(root, 'reset', '--quiet', 'HEAD', '--', path);
  rmSync(join(root, path), { force: true });
}

async function push(project, message, expected) {
  const { root } = project;
  git(root, 'commit', '--quiet', '-am', message);
  const r = git(root, 'push', 'origin', 'main');
  const arrived = project.head() === git(root, 'rev-parse', 'HEAD').text.trim();
  return { ...r, arrived, released: await slotReleased(root), expected: expected.every((m) => r.text.includes(m)) };
}

// The train: agent trees, each with a branch and its deposit at the dock; the factory runs from the root.
async function train(project, branches) {
  const { root } = project;
  git(root, 'fetch', '--quiet', 'origin');
  const dock = join(root, '.work', 'train-ready');
  mkdirSync(dock, { recursive: true });
  const trees = {};
  for (const { name, files, message } of branches) {
    const tree = join(TRAY, `${root.split(/[\\/]/).pop()}-${name}`);
    trees[name] = tree;
    git(root, 'worktree', 'add', '--quiet', '-b', name, tree, 'origin/main');
    write(tree, files);
    git(tree, 'add', '-A');
    const c = git(tree, 'commit', '--quiet', '-m', message);
    check(`branch ${name} commits in its tree`, c.status === 0, c.log);
    const d = new Date();
    const commit = git(tree, 'rev-parse', 'HEAD').text.trim();
    writeFileSync(join(dock, `${name}.txt`), `tree = ${tree}\nbranch = ${name}\ncommit = ${commit}\ntasks = ${name.toUpperCase()}\ndocked = ${d.getDate()}/${d.getMonth() + 1} ${d.toTimeString().slice(0, 5)}\n`);
  }
  const before = project.head();
  const r = node(root, 'scripts/warden/train.mjs', 'run', '--agent', 'factory');
  const after = project.head();
  const up = run('git', ['--git-dir', project.remote, 'log', '--format=%s', `${before}..${after}`], TRAY).text.split('\n').filter(Boolean);
  return { ...r, up, dock, trees, released: await slotReleased(root) };
}

const RUST_LIB = (extra = '') => `pub fn double(x: i64) -> i64 {\n    x * 2\n}\n${extra}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn double() {\n        assert_eq!(super::double(2), 4);\n    }\n}\n`;

async function rustAndNode() {
  const project = newRepo('rust-node', {
    'Cargo.toml': '[workspace]\nmembers = ["crates/*", "apps/*"]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    'crates/engine/Cargo.toml': '[package]\nname = "engine"\nversion.workspace = true\nedition.workspace = true\npublish = false\n',
    'crates/engine/src/lib.rs': RUST_LIB(),
    'crates/log/Cargo.toml': '[package]\nname = "log-lines"\nversion.workspace = true\nedition.workspace = true\npublish = false\n',
    'crates/log/src/lib.rs': 'pub fn line(text: &str) -> String {\n    format!("- {text}")\n}\n',
    'apps/tool/Cargo.toml': '[package]\nname = "tool"\nversion.workspace = true\nedition.workspace = true\npublish = false\n\n[dependencies]\nengine = { path = "../../crates/engine" }\n',
    'apps/tool/src/main.rs': 'fn main() {\n    println!("{}", engine::double(21));\n}\n',
    'package.json': `${JSON.stringify({ name: 'e2e-rust-node', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test "web/**/*.test.mjs"' } }, null, 2)}\n`,
    'web/sum.mjs': 'export const sum = (a, b) => a + b;\n',
    'web/sum.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 2), 4));\n",
    'README.md': '# Rust and Node trial\n',
    '.gitignore': 'target/\nnode_modules/\n',
  });
  const { root } = project;
  let trees = {};
  await step('A. Rust and Node project: install', async () => {
    check('Cargo writes its lockfile', run('cargo', ['generate-lockfile', '--offline'], root).status === 0);
    check('pnpm writes its lockfile', run('pnpm', ['install'], root).status === 0 && existsSync(join(root, 'pnpm-lock.yaml')));
    await installKit(project, (r) => {
      const rules = JSON.parse(readFileSync(join(r, 'config/rules.json'), 'utf8'));
      check('the install reads one version in both manifests', rules.versions?.length === 2);
      rules.boundaries = { rust: { crates: { forbidden_zones: ['apps'] } } };
      rules.single_test_binary = { zones: ['crates', 'apps'] };
      writeFileSync(join(r, 'config/rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
      const factory = JSON.parse(readFileSync(join(r, 'config/factory.json'), 'utf8'));
      check('the install sets Rust, npm advisories and pnpm install', Boolean(factory.verify.rust && factory.verify.npm_advisories && factory.train.install));
      factory.train.build = { title: 'Application', command: ['cargo', 'build', '-p', 'tool'] };
      writeFileSync(join(r, 'config/factory.json'), `${JSON.stringify(factory, null, 2)}\n`);
    });
  });
  await step('A. Refused commits', async () => {
    refusedCommit(root, 'crates/engine/src/big.rs', '// line\n'.repeat(701), 'lines');
    refusedCommit(root, 'web/path.mjs', `export const c = '${['C:', 'Users', 'someone', 'project'].join('\\\\')}';\n`, 'secret');
  });
  await step('A. A crossed boundary, refused at push', async () => {
    write(root, {
      'apps/screen/Cargo.toml': '[package]\nname = "screen"\nversion.workspace = true\nedition.workspace = true\npublish = false\n',
      'apps/screen/src/lib.rs': 'pub fn title() -> &\'static str {\n    "screen"\n}\n',
      'crates/engine/Cargo.toml': '[package]\nname = "engine"\nversion.workspace = true\nedition.workspace = true\npublish = false\n\n[dependencies]\nscreen = { path = "../../apps/screen" }\n',
    });
    run('cargo', ['generate-lockfile', '--offline'], root);
    git(root, 'add', '-A');
    const r = await push(project, 'the engine depends on a screen', []);
    check('the push is refused by the boundary', r.status !== 0 && /\[boundary\] engine: depends on screen \(apps\/\)/.test(r.text) && !r.arrived, r.log);
    git(root, 'reset', '--quiet', '--hard', 'origin/main');
    git(root, 'clean', '--quiet', '-fd', 'apps/screen');
  });
  await step('A. A push verified on its Rust scope', async () => {
    write(root, { 'crates/engine/src/lib.rs': RUST_LIB('\npub fn triple(x: i64) -> i64 {\n    x * 3\n}\n\n#[cfg(test)]\nmod triple_tests {\n    #[test]\n    fn triple() {\n        assert_eq!(super::triple(2), 6);\n    }\n}\n') });
    const r = await push(project, 'triple', ['Clippy, no warnings', 'Tests of engine', '2 Rust package(s)']);
    check('clippy on the touched package and its dependent, then its tests, and the push arrives', r.status === 0 && r.expected && r.arrived, r.log);
    check('the kit tests passed at the kit push do not run again', r.text.includes('Kit guards: already passed'), r.log);
    check('the slot is given back', r.released);
  });
  await step('A. A kit file edited: its tests run, and the fingerprint refuses the push', async () => {
    write(root, { 'scripts/warden/status.mjs': `${readFileSync(join(root, 'scripts/warden/status.mjs'), 'utf8')}// edited in the project\n` });
    const r = await push(project, 'an edited kit', []);
    check('the kit tests run again, and the push is refused by the fingerprint', r.status !== 0 && !r.text.includes('Kit guards: already passed') && r.text.includes('edited since version') && !r.arrived, r.log);
    git(root, 'reset', '--quiet', '--hard', 'origin/main');
  });
  await step('A. A push refused by a Rust test, replayed once', async () => {
    write(root, { 'crates/engine/src/lib.rs': readFileSync(join(root, 'crates/engine/src/lib.rs'), 'utf8').replace('x * 3', 'x * 4') });
    const r = await push(project, 'broken triple', ['on the second try too']);
    check('the push is refused, the test replayed once, nothing arrives', r.status !== 0 && r.expected && !r.arrived, r.log);
    check('the slot is given back at once', r.released);
    git(root, 'reset', '--quiet', '--hard', 'origin/main');
  });
  await step('A. A train of three branches, one of them a culprit', async () => {
    git(root, 'config', 'warden.factory', root);
    const r = await train(project, [
      { name: 'agent-a', message: 'product', files: { 'web/product.mjs': 'export const product = (a, b) => a * b;\n', 'web/product.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { product } from './product.mjs';\ntest('product', () => assert.equal(product(2, 3), 6));\n" } },
      { name: 'agent-b', message: 'half', files: { 'crates/engine/src/half.rs': 'pub fn half(x: i64) -> i64 {\n    x / 2\n}\n', 'crates/engine/src/lib.rs': `pub mod half;\n\n${readFileSync(join(root, 'crates/engine/src/lib.rs'), 'utf8')}` } },
      { name: 'agent-c', message: 'gap', files: { 'web/gap.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('gap', () => assert.equal(1, 2));\n" } },
    ]);
    check('the train runs to the end', r.status === 0, r.log);
    check('the two sound branches go up, in order', r.up.join(',') === 'half,product', r.up.join(', '));
    check('the culprit is set aside, with its cause', r.text.includes('Set aside: agent-c') && /refused = /.test(readFileSync(join(r.dock, 'agent-c.txt'), 'utf8')));
    check('the deposits that went up leave the dock', !existsSync(join(r.dock, 'agent-a.txt')) && !existsSync(join(r.dock, 'agent-b.txt')));
    const taken = existsSync(join(r.dock, 'taken')) ? readdirSync(join(r.dock, 'taken')) : [];
    check('they are kept in taken/, with what was taken', ['agent-a.txt', 'agent-b.txt'].every((n) => taken.some((f) => f.endsWith(n))) && taken.every((f) => /^taken = \w+ in \w+ at /m.test(readFileSync(join(r.dock, 'taken', f), 'utf8'))), taken.join(', '));
    check('the train writes its log', /Train log: .+train-logs/.test(r.text));
    check('the build runs once per trial', r.text.includes('✔ Application'));
    check('the hook does not verify again what the train verified', r.text.includes('Already verified by the train'));
    check('the slot is given back', r.released);
    const refusal = readJson(join(r.dock, 'agent-c.refusal.json'));
    const culprit = git(r.trees['agent-c'], 'rev-parse', 'HEAD').text.trim();
    check('the refusal is structured: class, step, first error, refused commit, next', refusal?.class === 'defect' && refusal.step === 'Verification of the changed files' && /gap/.test(refusal.first_error) && refusal.commit === culprit && refusal.next === 'fix_and_redock', JSON.stringify(refusal));
    const status = node(r.trees['agent-c'], 'scripts/warden/status.mjs', '--agent', 'agent-c', '--json');
    const s = JSON.parse(status.text);
    check('an agent reads its role and its refused deposit in the status', s.role === 'agent' && / fails: .+\(log: /.test(s.mine[0]?.refused ?? '') && s.mine[0]?.refusal?.class === 'defect', status.log);
    const elsewhere = node(r.trees['agent-c'], 'scripts/warden/train.mjs', 'run', '--agent', 'agent-c');
    check('the train refuses to run outside the factory tree', elsewhere.status !== 0 && elsewhere.text.includes('is not the factory'), elsewhere.log);
    trees = r.trees;
  });
  await step('A. A refused branch, fixed and docked again with a new commit, goes up', async () => {
    const tree = trees['agent-c'];
    write(tree, { 'web/gap.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('gap', () => assert.equal(2, 2));\n" });
    git(tree, 'commit', '--quiet', '-am', 'gap fixed');
    const fixed = git(tree, 'rev-parse', 'HEAD').text.trim();
    const deposit = join(root, '.work', 'train-ready', 'agent-c.txt');
    // Only the commit changes: the refused line stays where it is.
    writeFileSync(deposit, readFileSync(deposit, 'utf8').replace(/^commit = \w+$/m, `commit = ${fixed}`));
    const r = await train(project, []);
    check('the deposit leaves again on its new commit alone, and goes up', r.status === 0 && r.up.join(',') === 'gap fixed,gap', `${r.up.join(', ')} — ${r.log}`);
    check('its refusal leaves with it', !existsSync(join(r.dock, 'agent-c.refusal.json')) && !existsSync(deposit));
    check('the slot is given back', r.released);
    const h = history(root);
    check('the history counts the integrations and the refusal by class', h.integrations === 3 && h.refusals.defect === 1 && h.trains === 2, JSON.stringify(h));
  });
  await step('A. The factory bumps the patch version, and the train takes it up', async () => {
    const shown = JSON.parse(node(root, 'scripts/warden/version.mjs', 'show', '--json').text);
    check('the version, its line and the next one are read from both manifests', shown.current === '0.1.0' && shown.line === '0.1' && shown.next === '0.1.1' && shown.files.length === 2, JSON.stringify(shown));
    const off = node(root, 'scripts/warden/version.mjs', 'bump', '--to', '0.2.0');
    check('leaving the line is refused: it is the person\'s decision', off.status !== 0 && off.text.includes('leaves the 0.1 line'), off.log);
    const bumped = node(root, 'scripts/warden/version.mjs', 'bump');
    check('the bump is committed on the factory\'s own branch, the factory tree untouched', bumped.status === 0 && bumped.text.includes('warden/version-0.1.1') && git(root, 'status', '--porcelain', '--untracked-files=no').text.trim() === '', bumped.log);
    const r = node(root, 'scripts/warden/train.mjs', 'run', '--agent', 'factory', '--with', 'warden/version-0.1.1');
    const onMain = (path) => run('git', ['--git-dir', project.remote, 'show', `main:${path}`], TRAY).text;
    check('the train takes it up: both manifests and the lockfile say 0.1.1', r.status === 0 && /^version = "0\.1\.1"$/m.test(onMain('Cargo.toml')) && /"version": "0\.1\.1"/.test(onMain('package.json')) && /name = "engine"\r?\nversion = "0\.1\.1"/.test(onMain('Cargo.lock')), r.log);
    check('the slot is given back', await slotReleased(root));
  });
}

async function nodeOnly() {
  const project = newRepo('node-only', {
    'package.json': `${JSON.stringify({ name: 'e2e-node', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test "src/**/*.test.mjs"' } }, null, 2)}\n`,
    'src/sum.mjs': 'export const sum = (a, b) => a + b;\n',
    'src/sum.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 2), 4));\n",
    'README.md': '# Node trial\n',
    '.gitignore': 'node_modules/\n',
  });
  const { root } = project;
  await step('B. Node-only project: install', async () => {
    check('pnpm writes its lockfile', run('pnpm', ['install'], root).status === 0 && existsSync(join(root, 'pnpm-lock.yaml')));
    await installKit(project, (r) => {
      const factory = JSON.parse(readFileSync(join(r, 'config/factory.json'), 'utf8'));
      check('the install sets no Rust, and sets the project tests', factory.verify.rust === null && factory.verify.steps.some((s) => s.title === 'Project tests'));
    });
  });
  await step('B. Refused commits', async () => {
    refusedCommit(root, 'package-lock.json', '{}\n', 'lockfile');
    refusedCommit(root, 'notes.txt', 'at the root\n', 'root');
  });
  await step('B. A push verified, then one refused', async () => {
    write(root, { 'src/sum.mjs': 'export const sum = (a, b) => a + b;\nexport const rest = (a, b) => a - b;\n' });
    const ok = await push(project, 'rest', ['Project tests']);
    check('the project tests run and the push arrives', ok.status === 0 && ok.expected && ok.arrived && ok.released, ok.log);
    write(root, { 'src/sum.mjs': 'export const sum = (a, b) => a - b;\n' });
    const ko = await push(project, 'broken sum', ['✖ Project tests']);
    check('a failing step refuses the push, and nothing arrives', ko.status !== 0 && ko.expected && !ko.arrived && ko.released, ko.log);
    git(root, 'reset', '--quiet', '--hard', 'origin/main');
  });
  await step('B. A train of two branches', async () => {
    // No advisory database on this workstation for this project: the npm advisories cannot run.
    git(root, 'config', 'warden.ghsa', '');
    const r = await train(project, [
      { name: 'agent-d', message: 'square', files: { 'src/square.mjs': 'export const square = (a) => a * a;\n' } },
      { name: 'agent-e', message: 'cube', files: { 'src/cube.mjs': 'export const cube = (a) => a * a * a;\n' } },
    ]);
    check('the train takes both branches up', r.status === 0 && r.up.join(',') === 'cube,square', `${r.up.join(', ')} — ${r.log}`);
    check('a check that could not run is said "not run", never "verified"', r.text.includes('not run, no clone of the advisory database') && r.text.includes('Not run on this train, so not verified: npm advisories'), r.log);
    check('the slot is given back', r.released);
  });
  await step('B. An incident of the workstation is replayed once, and the branch goes up', async () => {
    upToDate(root);
    // A build that fails once as a workstation out of memory does (os error 1455, 19 November), then passes.
    write(root, {
      'scripts/flaky-build.mjs': "import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync('.work/flaky-once')) {\n  writeFileSync('.work/flaky-once', '');\n  console.error('error: The paging file is too small for this operation to complete. (os error 1455)');\n  process.exit(1);\n}\nconsole.log('built');\n",
      'scripts/package.mjs': "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('out', { recursive: true });\nwriteFileSync('out/app-0.1.0.txt', 'the application\\n');\n",
    });
    const factory = JSON.parse(readFileSync(join(root, 'config/factory.json'), 'utf8'));
    factory.train.build = { title: 'Flaky build', command: ['node', 'scripts/flaky-build.mjs'] };
    factory.release = { build: ['node', 'scripts/package.mjs'], artifacts: ['out/app-*.txt'] };
    writeFileSync(join(root, 'config/factory.json'), `${JSON.stringify(factory, null, 2)}\n`);
    git(root, 'add', 'scripts/flaky-build.mjs', 'scripts/package.mjs', 'config/factory.json');
    const setup = await push(project, 'a factory build and a release', []);
    check('the factory build and the release are set', setup.status === 0 && setup.arrived, setup.log);
    const r = await train(project, [{ name: 'agent-h', message: 'half', files: { 'src/half.mjs': 'export const half = (a) => a / 2;\n' } }]);
    check('the incident is replayed once, and the branch goes up', r.status === 0 && r.up.join(',') === 'half' && r.text.includes('an incident of the workstation (error: The paging file') && r.text.includes('passed on the second try'), r.log);
    check('nobody is refused for it', !existsSync(join(r.dock, 'agent-h.refusal.json')));
  });
  await step('B. A red main branch blames no branch', async () => {
    // A fixture: the main branch turns red outside the kit, from a clone with no hooks.
    const outside = join(TRAY, 'node-only-outside');
    run('git', ['clone', '--quiet', project.remote, outside], TRAY);
    for (const [key, value] of [['user.name', 'e2e'], ['user.email', 'e2e@example.test'], ['commit.gpgsign', 'false']]) git(outside, 'config', key, value);
    write(outside, { 'src/red.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red', () => assert.equal(1, 2));\n" });
    git(outside, 'add', '-A');
    git(outside, 'commit', '--quiet', '-m', 'red');
    git(outside, 'push', '--quiet', 'origin', 'main');
    const r = await train(project, [{ name: 'agent-f', message: 'twice', files: { 'src/twice.mjs': 'export const twice = (a) => 2 * a;\n' } }]);
    check('the train halts on a red main branch (exit 75)', r.status === 75 && r.text.includes('is red on its own') && r.up.length === 0, r.log);
    check('the sound branch is not refused, it waits', !/refused = /.test(readFileSync(join(r.dock, 'agent-f.txt'), 'utf8')) && !existsSync(join(r.dock, 'agent-f.refusal.json')));
    const status = JSON.parse(node(r.trees['agent-f'], 'scripts/warden/status.mjs', '--agent', 'agent-f', '--json').text);
    check('every agent sees the halt in its status', status.dock?.halt?.class === 'baseline' && /red/.test(status.dock.halt.first_error ?? ''), JSON.stringify(status.dock?.halt));
    check('the slot is given back', r.released);
    const begin = Date.now();
    const again = node(root, 'scripts/warden/train.mjs', 'run', '--agent', 'factory');
    check('the next train does not leave for nothing while nothing changed', again.status === 75 && again.text.includes('is still red') && !again.text.includes('▶'), `${Date.now() - begin} ms — ${again.log}`);
    await slotReleased(root);
  });
  await step('B. The repair is a deposit like any other: it goes up, and the waiting branch with it', async () => {
    const r = await train(project, [{ name: 'agent-g', message: 'repair', files: { 'src/red.test.mjs': null } }]);
    check('the repair and the waiting branch go up together', r.status === 0 && r.up.join(',') === 'repair,twice', `${r.up.join(', ')} — ${r.log}`);
    check('the halt is lifted', !existsSync(join(r.dock, '_halt.json')));
    check('the slot is given back', r.released);
  });
  await step('B. A release of a commit of the main branch', async () => {
    upToDate(root);
    const head = git(root, 'rev-parse', 'HEAD').text.trim();
    // No label: the release takes the version the commit carries.
    const r = node(root, 'scripts/warden/release.mjs', 'build', '--commit', head);
    const folder = join(root, '.work', 'releases', 'v0.1.0');
    const sums = existsSync(join(folder, 'SHA256SUMS')) ? readFileSync(join(folder, 'SHA256SUMS'), 'utf8') : '';
    const digest = existsSync(join(folder, 'app-0.1.0.txt')) ? createHash('sha256').update(readFileSync(join(folder, 'app-0.1.0.txt'))).digest('hex') : 'none';
    check('the release is built, its fingerprint right', r.status === 0 && sums === `${digest}  app-0.1.0.txt\n` && readJson(join(folder, 'release.json'))?.commit === head, r.log);
    check('the train tree is left as it was', git(root, 'rev-parse', 'HEAD').text.trim() === head && git(root, 'status', '--porcelain', '--untracked-files=no').text.trim() === '' && !existsSync(join(root, 'out')));
    const stray = git(root, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'not on main').text.trim();
    const refused = node(root, 'scripts/warden/release.mjs', 'build', '--commit', stray);
    check('a commit that is not on the main branch is refused', refused.status !== 0 && refused.text.includes('only what went up through the train'), refused.log);
  });
  await step('B. An interrupted train is recovered', async () => {
    // What a killed train leaves: the tree on the train branch, a tracked file modified, its start record.
    const killed = () => {
      git(root, 'fetch', '--quiet', 'origin');
      git(root, 'checkout', '--quiet', '-B', 'warden-train', 'origin/main');
      write(root, { 'src/sum.mjs': '// half written\n' });
      writeFileSync(join(root, '.git', 'warden-train-start'), 'main\n0\n');
    };
    const clean = () => git(root, 'rev-parse', '--abbrev-ref', 'HEAD').text.trim() === 'main' && git(root, 'status', '--porcelain', '--untracked-files=no').text.trim() === '';
    killed();
    const recovered = node(root, 'scripts/warden/train.mjs', 'recover');
    check('recover puts the tree back where the train left from', recovered.status === 0 && clean(), recovered.log);
    killed();
    const again = node(root, 'scripts/warden/train.mjs', 'run', '--dry-run');
    check('the next train recovers the tree by itself when the interrupted one is dead, and leaves', again.status === 0 && again.text.includes('its tree is recovered') && clean(), again.log);
  });
  await step('B. A check that cannot run makes the train wait when the project blocks it', async () => {
    upToDate(root);
    const factory = JSON.parse(readFileSync(join(root, 'config/factory.json'), 'utf8'));
    factory.verify.when_missing = 'block';
    writeFileSync(join(root, 'config/factory.json'), `${JSON.stringify(factory, null, 2)}\n`);
    const setup = await push(project, 'block what was not verified', []);
    check('the project blocks what was not verified', setup.status === 0 && setup.arrived, setup.log);
    const r = await train(project, [{ name: 'agent-i', message: 'third', files: { 'src/third.mjs': 'export const third = (a) => a / 3;\n' } }]);
    check('the train halts, nothing goes up unverified, nobody is refused', r.status === 75 && r.up.length === 0 && r.text.includes('could not run') && readJson(join(r.dock, '_halt.json'))?.class === 'incomplete' && !existsSync(join(r.dock, 'agent-i.refusal.json')), r.log);
    check('the slot is given back', r.released);
    const h = history(root);
    check('the history counts the trains, the halts, the guards spared and what was not run', h.integrations === 5 && h.halts.baseline === 1 && h.halts.incomplete === 1 && h.guards.kit_cached > 0 && h.not_run['npm advisories, on the workstation'] > 0 && h.releases === 1, JSON.stringify(h));
  });
  await step('B. A check that keeps failing to run is said once, from the moment it began', async () => {
    const haltFile = join(root, '.work', 'train-ready', '_halt.json');
    const first = readJson(haltFile);
    const again = node(root, 'scripts/warden/train.mjs', 'run', '--agent', 'factory');
    const second = readJson(haltFile);
    check('the train halts again on the same check', again.status === 75 && second?.class === 'incomplete' && second.step === first?.step, again.log);
    check('the halt keeps the moment it began, and the latest train moves', second?.at === first?.at && Date.parse(second?.last) > Date.parse(first?.last ?? first?.at), JSON.stringify({ first, second }));
    // Thirty minutes cannot pass in a trial: the halt is moved back 40 minutes, its latest train left as it is.
    const moved = new Date(Date.parse(second.at) - 40 * 60000).toISOString();
    writeFileSync(haltFile, `${JSON.stringify({ ...second, at: moved }, null, 2)}\n`);
    const watched = run(process.execPath, ['scripts/warden/train.mjs', 'watch'], root, 120000);
    check('watch says it once, past the threshold since it began (exit 75)', watched.status === 75 && /Halted for 4\d min \(incomplete\)/.test(watched.text) && readJson(haltFile)?.noticed === true, watched.log);
    const third = node(root, 'scripts/warden/train.mjs', 'run', '--agent', 'factory');
    const kept = readJson(haltFile);
    check('a train that halts again keeps it said, and its beginning', third.status === 75 && kept?.noticed === true && kept.at === moved, third.log);
  });
  await step('B. The interface reads every project and runs only what bypasses nothing', async () => {
    // The workstation list of projects lives in the global Git configuration: the trial gives it its own.
    const globalConfig = join(TRAY, 'gitconfig-interface');
    writeFileSync(globalConfig, `[warden]\n\tprojects = ${join(TRAY, 'rust-node').replaceAll('\\', '/')}\n`);
    const child = spawn(process.execPath, ['scripts/warden/ui.mjs', '--no-open'], { cwd: root, env: { ...ENV, GIT_CONFIG_GLOBAL: globalConfig }, windowsHide: true });
    try {
      const address = await new Promise((done, fail) => {
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
          const m = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([0-9a-f]+)/.exec(out);
          if (m) done(m);
        });
        child.on('exit', () => fail(new Error(out)));
        setTimeout(() => fail(new Error(`no address: ${out}`)), 30000);
      });
      const [, port, token] = address;
      const api = async (path, { method = 'GET', body = null, auth = true } = {}) => {
        const headers = { ...(auth ? { 'x-warden-token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, text: await r.text() };
      };
      const json = async (...args) => JSON.parse((await api(...args)).text);
      const here = encodeURIComponent(root);
      check('the interface is served on 127.0.0.1, and refuses a call without its token', (await api('/api/projects', { auth: false })).status === 403);
      const page = await api('/', { auth: false });
      check('the page comes from the kit, with nothing to load from outside', page.status === 200 && page.text.includes('ui-app.mjs') && !/(src|href)=["']?https?:/i.test(page.text), page.text.slice(0, 200));
      const list = await json('/api/projects');
      const names = list.projects.map((p) => `${p.name}:${p.ok}:${p.kit?.version}`).sort().join(', ');
      check('both projects of the workstation are read, each by its own kit', names === `node-only:true:${PLUGIN.version}, rust-node:true:${PLUGIN.version}`, names);
      const kinds = list.cases.filter((c) => c.project === list.projects.find((p) => p.here).path).map((c) => c.kind);
      check('what waits for the person: the halt said once, the release not published', kinds.includes('halt_incomplete') && kinds.includes('release'), JSON.stringify(kinds));
      const detail = await json(`/api/project?path=${here}&days=7`);
      const last = detail.history.filter((e) => e.kind === 'train').at(-1);
      check('the history says how the last train ended, and where its log is', last?.outcome === 'halted' && typeof last.log === 'string', JSON.stringify(last));
      const log = await json(`/api/file?path=${here}&file=${encodeURIComponent(last.log)}`);
      check('the log of a train opens, read only, inside the work folder', log.content?.includes('could not run') && (await api(`/api/file?path=${here}&file=..%2Fpackage.json`)).status === 404);
      const shown = await json(`/api/run?path=${here}`, { method: 'POST', body: { gesture: 'version.show' } });
      check('a gesture runs the kit command and gives its output and code', shown.code === 0 && shown.command === 'node scripts/warden/version.mjs show' && /0\.1\.\d/.test(shown.output), JSON.stringify(shown));
      const refused = await api(`/api/run?path=${here}`, { method: 'POST', body: { gesture: 'train.recover' } });
      check('a gesture outside the list is refused before anything runs', refused.status === 400, refused.text);
      const release = list.cases.find((c) => c.kind === 'release' && c.project === list.projects.find((p) => p.here).path);
      await api(`/api/mark?path=${here}`, { method: 'POST', body: { label: release.vars.label, published: true } });
      const after = await json('/api/projects');
      check('a release marked published on the person\'s word no longer waits', !after.cases.some((c) => c.id === release.id));
      const run_ = (path, gesture, args = {}) => json(`/api/run?path=${encodeURIComponent(path)}`, { method: 'POST', body: { gesture, args } });

      currentStep = 'B. The person answers a decision of the factory from the interface';
      const raised = node(root, 'scripts/warden/decision.mjs', 'raise', '--title', 'Keep the third function?', '--question', 'It waits behind a check that cannot run.', '--option', 'Keep it', '--option', 'Drop it', '--context', last.log);
      const id = /Decision (\S+) raised/.exec(raised.text)?.[1];
      const asked = (await json('/api/projects')).cases.find((c) => c.kind === 'decision' && c.vars.id === id);
      check('a decision the factory raises waits for the person, with its options and its context', raised.status === 0 && asked?.vars.options.length === 2 && asked.vars.context === last.log, raised.log);
      const answer = await run_(root, 'decision.answer', { id, choice: 2, note: 'too small to wait for' });
      const counted = JSON.parse(node(root, 'scripts/warden/status.mjs', '--json').text).decisions;
      check('the answer is the person\'s, written by the kit; the decision then waits for the factory', answer.code === 0 && !(await json('/api/projects')).cases.some((c) => c.kind === 'decision') && counted?.open === 0 && counted.answered === 1, `${JSON.stringify(answer)} ${JSON.stringify(counted)}`);
      const closed = node(root, 'scripts/warden/decision.mjs', 'close', id, '--note', 'agent-i dropped');
      const late = await run_(root, 'decision.answer', { id, choice: 1 });
      check('once the factory acted and closed it, the answer stays as it was', closed.status === 0 && late.code !== 0 && /closed/.test(late.output), `${closed.log} ${JSON.stringify(late)}`);

      currentStep = 'B. The person cleans one tree alone from the interface';
      const agentTree = join(TRAY, 'node-only-agent-d');
      write(agentTree, { 'node_modules/.cache/old.bin': 'x'.repeat(1024) });
      write(root, { 'node_modules/.cache/mine.bin': 'mine' });
      const listed = await run_(root, 'disk.clean_tree', { tree: agentTree });
      const cleaned = await run_(root, 'disk.clean_tree', { tree: agentTree, apply: true });
      check('one tree is listed, then cleaned, and only it', listed.code === 0 && listed.output.includes('.cache') && cleaned.code === 0 && !existsSync(join(agentTree, 'node_modules', '.cache')) && existsSync(join(root, 'node_modules', '.cache', 'mine.bin')), `${JSON.stringify(listed)} ${JSON.stringify(cleaned)}`);
      const notTree = await run_(root, 'disk.clean_tree', { tree: TRAY, apply: true });
      git(root, 'config', 'warden.factory', root);
      const factoryTree = await run_(root, 'disk.clean_tree', { tree: root, apply: true });
      git(root, 'config', '--unset', 'warden.factory');
      check('a folder that is no tree of the clone, and the factory tree, are refused', notTree.code !== 0 && /not a tree of this clone/.test(notTree.output) && factoryTree.code !== 0 && /factory tree/.test(factoryTree.output), `${notTree.output} ${factoryTree.output}`);

      currentStep = 'B. The person changes the configuration from the interface, and the train takes it up';
      const rust = join(TRAY, 'rust-node');
      const disk = JSON.parse(readFileSync(join(rust, 'config', 'disk.json'), 'utf8'));
      const wrong = await json(`/api/check?path=${encodeURIComponent(rust)}`, { method: 'POST', body: { file: 'config/disk.json', content: JSON.stringify({ ...disk, max_worktrees: -1, max_trees: 3 }) } });
      check('a wrong value is an error, an unknown key a remark, before anything is written', wrong.errors === 1 && wrong.problems[0].path === 'max_worktrees' && wrong.problems.some((p) => p.level === 'warning' && p.path === 'max_trees'), JSON.stringify(wrong));
      const text = `${JSON.stringify({ ...disk, max_worktrees: 3 }, null, 2)}\n`;
      const deposited = await run_(rust, 'config.deposit', { file: 'config/disk.json', content: text, message: 'Disk: three agent trees' });
      const dockFile = join(rust, '.work', 'train-ready', 'config-disk.txt');
      const branch = /branch = (\S+)/.exec(existsSync(dockFile) ? readFileSync(dockFile, 'utf8') : '')?.[1];
      check('the change is committed on a branch of its own and docked, no tree changes branch, nothing is pushed', deposited.code === 0 && Boolean(branch) && git(rust, 'rev-parse', '--abbrev-ref', 'HEAD').text.trim() === 'main' && !existsSync(join(rust, '.work', 'change-tree')) && run('git', ['--git-dir', join(TRAY, 'rust-node.git'), 'branch', '--list', branch], TRAY).text.trim() === '', `${JSON.stringify(deposited)}`);
      const twice = await run_(rust, 'config.deposit', { file: 'config/disk.json', content: text.replace('"max_worktrees": 3', '"max_worktrees": 4') });
      check('a second change of the same file waits for the first one to go up', twice.code !== 0 && /waits for the train/.test(twice.output), twice.output);
      const taken = node(rust, 'scripts/warden/train.mjs', 'run', '--agent', 'factory');
      const onMain = JSON.parse(run('git', ['--git-dir', join(TRAY, 'rust-node.git'), 'show', 'main:config/disk.json'], TRAY).text || '{}');
      check('the train takes it up through its checks, like any change', taken.status === 0 && onMain.max_worktrees === 3 && !existsSync(dockFile), taken.log);
      await slotReleased(rust);

      currentStep = 'B. The plugin version is seen by the interface';
      const hook = spawnSync(process.execPath, [join(REPO, 'hooks', 'session-start.mjs')], { input: JSON.stringify({ cwd: root, source: 'resume' }), encoding: 'utf8', env: ENV, windowsHide: true });
      const record = readJson(join(root, '.git', 'warden-plugin.json'));
      const seen = (await json('/api/projects')).projects.find((p) => p.here);
      check('the session hook of the plugin leaves its version in the clone, and the page reads it', hook.status === 0 && record?.version === PLUGIN.version && seen.plugin?.version === PLUGIN.version, JSON.stringify(record));
      // A plugin newer than the kit: the record a later plugin would leave.
      writeFileSync(join(root, '.git', 'warden-plugin.json'), `${JSON.stringify({ version: '9.9.9', since: record?.since })}\n`);
      const behind = (await json('/api/projects')).cases.find((c) => c.kind === 'kit_behind' && c.project === seen.path);
      check('a kit behind the plugin waits for the person, said as such', behind?.vars.from === 'plugin' && behind.vars.newest === '9.9.9', JSON.stringify(behind));
    } finally {
      child.kill();
    }
  });
}

function report() {
  const failures = checks.filter((c) => !c.ok);
  const lines = [
    `# Warden kit trial ${PLUGIN.version}`,
    '',
    `${checks.length} checks, ${failures.length} failed. Node ${process.version}, ${process.platform}.`,
    '',
    '| Step | Check | Verdict | Detail |',
    '|---|---|---|---|',
    ...checks.map((c) => `| ${c.step} | ${c.check} | ${c.ok ? 'ok' : '**FAILED**'} | ${c.detail} |`),
    '',
  ];
  writeFileSync(join(OUTPUT, 'report.md'), lines.join('\n'));
  writeFileSync(join(OUTPUT, 'verdicts.json'), `${JSON.stringify(checks, null, 2)}\n`);
  console.log(`\n${checks.length} checks, ${failures.length} failed. Report: ${join(OUTPUT, 'report.md')}`);
  return failures.length === 0;
}

try {
  await rustAndNode();
  await nodeOnly();
} finally {
  const ok = report();
  if (!argv.includes('--keep')) rmSync(TRAY, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  else appendFileSync(join(OUTPUT, 'report.md'), `\nProjects kept in ${TRAY}.\n`);
  process.exitCode = ok ? 0 : 1;
}
