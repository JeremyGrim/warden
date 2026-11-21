#!/usr/bin/env node
// The end-to-end trial of the kit on blank projects: the kit installed, commits refused, pushes verified and refused,
// the kit tests spared when the kit did not change, a train of branches with one culprit, its structured refusal and
// its return on a new commit, an incident of the workstation replayed, a red main branch that blames no branch and
// lifts with its repair, a check that could not run, a release, an interrupted train recovered, the history, the
// factory role and the status an agent reads when it joins. Nothing is simulated: real repositories, real hooks,
// Cargo and pnpm. The projects live in a temporary folder removed at the end;
// the report stays.
//
//   node tools/e2e.mjs [--output <folder>] [--keep]
//
// The report: <output>/report.md and <output>/verdicts.json, and the log of each step in <output>/logs/.
// A broken step is reported as a check, and the trial goes on.

import { spawnSync } from 'node:child_process';
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

function run(program, args, cwd) {
  const shell = process.platform === 'win32' && ['pnpm', 'npm'].includes(program);
  const line = shell ? [program, ...args].join(' ') : program;
  const r = spawnSync(line, shell ? [] : args, { cwd, encoding: 'utf8', env: ENV, shell, windowsHide: true, maxBuffer: 1 << 28 });
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
  const install = node(root, join(REPO, 'tools', 'install.mjs'), root);
  check('the install succeeds', install.status === 0, install.log);
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
    const r = node(root, 'scripts/warden/release.mjs', 'build', '--commit', head, '--label', 'v0.1.0');
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
