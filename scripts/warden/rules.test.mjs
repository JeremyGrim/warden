// First: no git of this test inherits the repository that launches it (git-env.mjs).
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkFiles, compile, countLines, nodeBoundaries, readVersion, rustBoundaries, staleLock } from './rules.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));

// These guards carry their own rules: the kit is installed in projects that each have their own configuration.
const DATA = {
  root: { dirs: ['apps', 'crates', 'packages', 'vendor', 'docs', 'config', 'scripts', '.githooks'], files: ['README.md', 'AGENTS.md', 'CLAUDE.md', 'Cargo.toml', 'Cargo.lock', 'package.json', 'pnpm-lock.yaml', '.gitignore'] },
  required: ['README.md', 'AGENTS.md', 'CLAUDE.md'],
  max_lines: 700,
  warn_lines: 650,
  lines_exempt: ['Cargo.lock', 'pnpm-lock.yaml'],
  max_size_kib: 512,
  size_exceptions: { 'Cargo.lock': 2048 },
  forbidden_segments: ['target', 'node_modules', 'dist', '.input', '.work', '.claude'],
  forbidden_extensions: ['.exe', '.zip', '.pdf', '.log', '.png'],
  forbidden_lockfiles: ['package-lock.json', 'yarn.lock'],
  secrets: [
    { name: 'private key', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    { name: 'GitHub token', pattern: '\\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\\b' },
    { name: 'Anthropic key', pattern: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b' },
    { name: 'machine path', pattern: "\\b[A-Za-z]:[\\\\/]+Users[\\\\/]+(?![\\\\/])(?!person(?![\\w.-]))[^\\s\"'`]+|/home/(?!person/)[a-z][a-z0-9_-]+/|/Users/(?!person/)[A-Za-z][A-Za-z0-9._-]+/" },
  ],
  single_source: { file: 'CLAUDE.md', points_to: 'AGENTS.md', max_lines: 3 },
  docs: { dir: 'docs/', max_files: 15, forbidden_names: ['^(CR|BRIEF|AUDIT|PLAN)[-_ .]', '\\d{8}', '\\d{4}-\\d{2}-\\d{2}'], forbidden_status: 'status\\s*:\\s*\\**\\s*(archiv|histor|informational)' },
  versions: [{ file: 'package.json', read: 'json:version' }, { file: 'Cargo.toml', read: 'toml:workspace.package.version' }],
};
const RULES = compile(DATA);

const BASE = {
  'README.md': 'x\n',
  'AGENTS.md': 'x\n',
  'CLAUDE.md': 'Read AGENTS.md\n',
  'package.json': JSON.stringify({ version: '1.0.0' }),
  'Cargo.toml': '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.0.0"\n',
};

function findingsOf(additions = {}, removals = [], rules = RULES) {
  const repo = { ...BASE, ...additions };
  for (const path of removals) delete repo[path];
  const read = (path) => (path in repo ? Buffer.from(repo[path]) : null);
  return checkFiles({ files: Object.keys(repo), rules, read });
}

const rulesOf = (findings) => findings.map((f) => f.rule);
const withRules = (sections) => compile({ ...DATA, ...sections });

test('a minimal repository respects the rules', () => {
  assert.deepEqual(findingsOf(), []);
});

test('a missing section is not checked', () => {
  assert.deepEqual(rulesOf(findingsOf({ 'notes.txt': 'x\n'.repeat(5000), 'a/b.exe': 'x' }, [], compile({}))), []);
});

test('the root is closed', () => {
  assert.deepEqual(rulesOf(findingsOf({ 'notes.txt': 'x' })), ['root']);
  assert.deepEqual(rulesOf(findingsOf({ 'some-plugin/a.md': 'x' })), ['root']);
  assert.deepEqual(rulesOf(findingsOf({}, ['AGENTS.md'])), ['root']);
});

test('artifacts are never committed', () => {
  assert.ok(rulesOf(findingsOf({ 'scripts/target/a.txt': 'x' })).includes('artifact'));
  assert.ok(rulesOf(findingsOf({ 'scripts/.input/a.txt': 'x' })).includes('artifact'));
  assert.ok(rulesOf(findingsOf({ 'docs/report.pdf': 'x' })).includes('artifact'));
  assert.ok(rulesOf(findingsOf({ 'scripts/app.exe': 'x' })).includes('artifact'));
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/build.rs': 'x' })), []);
});

test('size has a ceiling, with named exceptions', () => {
  const big = 'x'.repeat(513 * 1024);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/big.txt': big })), ['size']);
  assert.deepEqual(rulesOf(findingsOf({ 'Cargo.lock': big })), []);
});

test('a file has 700 lines at most, and nearing the ceiling warns without refusing', () => {
  assert.equal(countLines(Buffer.from('a\nb')), 2);
  assert.equal(countLines(Buffer.from('a\nb\n')), 2);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': 'x\n'.repeat(700) })), []);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': 'x\n'.repeat(701) })), ['lines']);
  assert.deepEqual(rulesOf(findingsOf({ 'Cargo.lock': 'x\n'.repeat(9000) })), []);
  const warned = [];
  const repo = { ...BASE, 'scripts/a.mjs': 'x\n'.repeat(651) };
  const findings = checkFiles({ files: Object.keys(repo), rules: RULES, warn: (w) => warned.push(w.path), read: (p) => Buffer.from(repo[p]) });
  assert.deepEqual([rulesOf(findings), warned], [[], ['scripts/a.mjs']]);
});

test('one package manager only', () => {
  assert.ok(rulesOf(findingsOf({ 'packages/a/package-lock.json': '{}' })).includes('lockfile'));
});

test('no secret nor machine path, except the fictitious person of the tests', () => {
  const token = ['ghp', 'a'.repeat(36)].join('_');
  const key = ['sk', 'ant', 'a'.repeat(30)].join('-');
  const path = ['C:', 'Users', 'someone', 'x'].join('\\');
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `const t = "${token}";` })), ['secret']);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `const t = "${key}";` })), ['secret']);
  assert.deepEqual(rulesOf(findingsOf({ 'docs/a.md': `see ${path}\n` })), ['secret']);
  const doubled = ['C:', 'Users', 'someone', 'x'].join('\\\\');
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `const c = '${doubled}';` })), ['secret'], 'doubled separators, in a code string');
  const fictitious = ['C:', 'Users', 'person', 'project'];
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `"${fictitious.join('\\')}"; "${fictitious.join('/')}"; "/${fictitious.slice(1).join('/')}/"` })), []);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `"${fictitious.join('\\\\')}"` })), [], 'the fictitious person, doubled separators');
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `"${fictitious.slice(0, 3).join('\\\\')}"` })), [], 'the fictitious person\'s own folder');
  for (const near of ['person2', 'person.x', 'person_x']) {
    assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `"${['C:', 'Users', near].join('\\\\')}"` })), ['secret'], near);
  }
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `"/${['Users', 'person2', 'x'].join('/')}"` })), ['secret']);
});

test('a secret exception holds for one file and one kind', () => {
  const fake = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
  const rules = withRules({ secret_exceptions: { 'scripts/a.mjs': { 'private key': 'fake secret of a test' } } });
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': fake }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/b.mjs': fake }, [], rules)), ['secret']);
  assert.deepEqual(rulesOf(findingsOf({ 'scripts/a.mjs': `sk-ant-${'a'.repeat(24)}` }, [], rules)), ['secret']);
});

test('foreign code escapes lines and size, not secrets', () => {
  const rules = withRules({ foreign_code: { 'vendor/lib/': 'named patch' } });
  assert.deepEqual(rulesOf(findingsOf({ 'vendor/lib/a.rs': 'x\n'.repeat(701) }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ 'vendor/lib/a.rs': 'y'.repeat(513 * 1024) }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ 'vendor/lib/a.rs': `sk-ant-${'a'.repeat(24)}` }, [], rules)), ['secret']);
});

test('docs/ speaks in the present tense', () => {
  assert.deepEqual(rulesOf(findingsOf({ 'docs/CR-lot3.md': 'x' })), ['docs']);
  assert.deepEqual(rulesOf(findingsOf({ 'docs/notes-20261105.md': 'x' })), ['docs']);
  assert.deepEqual(rulesOf(findingsOf({ 'docs/notes-2026-11-05.md': 'x' })), ['docs']);
  assert.deepEqual(rulesOf(findingsOf({ 'docs/old.md': '# Old\n\nStatus: historical\n' })), ['docs']);
  assert.deepEqual(rulesOf(findingsOf({ 'docs/planning.md': 'x' })), []);
  const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`docs/d${i}.md`, 'x']));
  assert.deepEqual(rulesOf(findingsOf(many)), ['docs']);
});

test('the agent file of a tool carries no rule', () => {
  assert.deepEqual(rulesOf(findingsOf({ 'CLAUDE.md': 'Always test.\n' })), ['single-source']);
  assert.deepEqual(rulesOf(findingsOf({ 'CLAUDE.md': 'AGENTS.md\na\nb\nc\n' })), ['single-source']);
});

test('the version is the same everywhere, read in JSON as in TOML', () => {
  assert.deepEqual(rulesOf(findingsOf({ 'package.json': JSON.stringify({ version: '2.0.0' }) })), ['version']);
  assert.equal(readVersion('[package]\nname = "a"\nversion = "0.3.1"\n[dependencies]\nversion = "9"\n', 'toml:package.version'), '0.3.1');
  assert.equal(readVersion('version = "1.2.3"\n[table]\nversion = "9"\n', 'toml:version'), '1.2.3');
  assert.equal(readVersion('[workspace.package]\r\nversion = "4.0.0"\r\n', 'toml:workspace.package.version'), '4.0.0');
  assert.equal(readVersion('{"tool":{"version":"5.0.0"}}', 'json:tool.version'), '5.0.0');
  assert.equal(readVersion('[other]\n', 'toml:package.version'), null);
});

test('every element of a zone declares its provenance', () => {
  const rules = withRules({ provenance: { file: 'config/provenance.json', zones: ['crates', 'vendor'] } });
  const card = (elements, sources = {}) => ({ 'config/provenance.json': JSON.stringify({ sources, elements }) });
  const crate = { 'crates/a/Cargo.toml': 'x', 'crates/a/src/lib.rs': 'x' };
  assert.deepEqual(rulesOf(findingsOf(crate, [], rules)), ['provenance']);
  assert.deepEqual(rulesOf(findingsOf({ ...crate, ...card({ 'crates/a': { origin: 'new' } }) }, [], rules)), []);
  const source = { upstream: 'https://example.test/upstream.git' };
  assert.deepEqual(rulesOf(findingsOf({ ...crate, ...card({ 'crates/a': { origin: 'upstream', revision: 'abc', path: 'crates/a' } }, source) }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ ...crate, ...card({ 'crates/a': { origin: 'upstream' } }, source) }, [], rules)), ['provenance']);
  assert.deepEqual(rulesOf(findingsOf(card({ 'crates/absent': { origin: 'new' } }), [], rules)), ['provenance']);
});

test('every component has its place in the registry, and the registry names only what exists', () => {
  const rules = withRules({ registry: { file: 'config/registry.json', zones: ['crates', 'packages'] } });
  const registry = (categories) => ({ 'config/registry.json': JSON.stringify({ categories }) });
  const repo = { 'crates/a/Cargo.toml': 'x', 'packages/b/package.json': '{}' };
  assert.deepEqual(rulesOf(findingsOf({ ...repo, ...registry({ core: ['crates/a'], bench: ['packages/b'] }) }, [], rules)), []);
  const missing = findingsOf({ ...repo, ...registry({ core: ['crates/a'] }) }, [], rules);
  assert.deepEqual([rulesOf(missing), missing[0].path], [['registry'], 'packages/b']);
  const absent = findingsOf({ ...repo, ...registry({ core: ['crates/a', 'packages/b', 'crates/gone'] }) }, [], rules);
  assert.deepEqual([rulesOf(absent), absent[0].path], [['registry'], 'crates/gone']);
});

test('a debt lives only in its file, and its file never grows', () => {
  const rules = withRules({ debts: [{ name: 'mocks', root: 'apps/front/', pattern: '(mock|fixture)', file: 'apps/front/src/mocks.ts', must_not_grow: true }] });
  assert.deepEqual(rulesOf(findingsOf({ 'apps/front/src/mocks.ts': 'x\n' }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ 'apps/front/src/screen/fixtures.ts': 'x\n' }, [], rules)), ['debt']);
  const repo = { ...BASE, 'apps/front/src/mocks.ts': 'a\nb\nc\n' };
  const judge = (before) => rulesOf(checkFiles({ files: Object.keys(repo), rules, read: (p) => Buffer.from(repo[p]), readBefore: (p) => (p === 'apps/front/src/mocks.ts' ? Buffer.from(before) : null) }));
  assert.deepEqual(judge('a\nb\n'), ['debt'], 'it grew');
  assert.deepEqual(judge('a\nb\nc\nd\n'), [], 'it shrank');
});

test('a chokepoint refuses what is written inline in its zone, except a named exception', () => {
  const rules = withRules({ chokepoints: [{ name: 'colour', zones: ['apps/front/src/'], extensions: ['.tsx'], pattern: '#[0-9a-fA-F]{6}\\b', message: 'a colour is read from the tokens', exceptions: { 'apps/front/src/tokens.tsx': 'the token source' } }] });
  const findings = findingsOf({ 'apps/front/src/Button.tsx': 'color: "#ff0000"' }, [], rules);
  assert.deepEqual(rulesOf(findings), ['chokepoint']);
  assert.match(findings[0].message, /tokens/);
  assert.deepEqual(rulesOf(findingsOf({ 'apps/front/src/tokens.tsx': '#ff0000' }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ 'apps/front/src/style.css': '#ff0000' }, [], rules)), [], 'another extension');
  assert.deepEqual(rulesOf(findingsOf({ 'apps/other/a.tsx': '#ff0000' }, [], rules)), [], 'outside the zone');
});

test('one test binary per crate', () => {
  const rules = withRules({ single_test_binary: { zones: ['crates'] } });
  assert.deepEqual(rulesOf(findingsOf({ 'crates/a/tests/all/main.rs': 'x', 'crates/a/tests/all/contracts.rs': 'x' }, [], rules)), []);
  assert.deepEqual(rulesOf(findingsOf({ 'crates/a/tests/one.rs': 'x', 'crates/a/tests/two.rs': 'x' }, [], rules)), ['test-binary']);
  assert.deepEqual(rulesOf(findingsOf({ 'crates/a/src/x/tests/one.rs': 'x', 'crates/a/src/x/tests/two.rs': 'x' }, [], rules)), [], 'a tests/ folder inside src/ makes no binary');
});

function metadata({ resolved }) {
  const pkg = (id, name, manifest_path, source = null, dependencies = []) => ({ id, name, manifest_path, source, dependencies });
  return {
    workspace_root: 'C:\\r',
    workspace_members: ['core', 'mod', 'app'],
    packages: [
      pkg('core', 'core', 'C:\\r\\crates\\core\\Cargo.toml', null, [{ name: 'mod', path: 'C:\\r\\modules\\mod' }]),
      pkg('mod', 'mod', 'C:\\r\\modules\\mod\\Cargo.toml'),
      pkg('app', 'app', 'C:\\r\\apps\\app\\Cargo.toml'),
      pkg('third', 'third', 'C:\\cache\\third\\Cargo.toml', 'registry'),
      pkg('tauri', 'tauri-runtime', 'C:\\cache\\tauri\\Cargo.toml', 'registry'),
    ],
    resolve: resolved ? { nodes: [{ id: 'core', dependencies: ['third'] }, { id: 'third', dependencies: ['tauri'] }, { id: 'mod', dependencies: [] }, { id: 'app', dependencies: ['core', 'mod', 'tauri'] }] } : null,
  };
}
const RUST_ZONES = { crates: { forbidden_zones: ['modules', 'apps'], forbidden_packages: ['tauri*'] } };

test('Rust: the core depends on no host, even transitively, nor on a module', () => {
  const transitive = rustBoundaries(metadata({ resolved: true }), RUST_ZONES);
  assert.deepEqual(transitive.map((f) => f.path), ['core']);
  assert.match(transitive[0].message, /tauri-runtime/);
  const direct = rustBoundaries(metadata({ resolved: false }), RUST_ZONES);
  assert.match(direct[0].message, /modules\//);
  const linux = JSON.parse(JSON.stringify(metadata({ resolved: true })).replaceAll('C:\\\\', '/').replaceAll('\\\\', '/'));
  assert.deepEqual(rustBoundaries(linux, RUST_ZONES).map((f) => f.path), ['core'], 'Linux paths as Windows ones');
});

test('a boundary exception only ever shrinks', () => {
  const zones = { modules: { forbidden_direct: [{ package: 'platform', reason: 'why', except: ['old', 'freed'] }] } };
  const mod = (name, dependencies) => ({ id: name, name, manifest_path: `/r/modules/${name}/Cargo.toml`, source: null, dependencies });
  const platform = { name: 'platform', path: '/r/crates/platform' };
  const meta = { workspace_root: '/r', workspace_members: ['clean', 'back', 'old', 'freed'], resolve: null, packages: [mod('clean', []), mod('back', [platform]), mod('old', [platform]), mod('freed', [])] };
  const findings = rustBoundaries(meta, zones);
  assert.deepEqual(findings.map((f) => f.path), ['back', 'freed']);
  assert.match(findings[1].message, /remove its exception/);
});

test('Node: a zone does not reach a forbidden zone, even through another workspace package', () => {
  const manifests = {
    'package.json': JSON.stringify({ name: 'root', devDependencies: { tools: '*' } }),
    'packages/core/package.json': JSON.stringify({ name: 'core', dependencies: { util: 'workspace:*', 'electron-third': '1' } }),
    'packages/util/package.json': JSON.stringify({ name: 'util', dependencies: { screen: 'workspace:*' } }),
    'apps/screen/package.json': JSON.stringify({ name: 'screen' }),
  };
  const findings = nodeBoundaries(manifests, { packages: { forbidden_zones: ['apps'], forbidden_packages: ['electron*'] } });
  assert.deepEqual(findings.map((f) => `${f.path} ${f.message}`).sort(), [
    'core depends on electron-third, forbidden from packages/',
    'core depends on screen (apps/), forbidden from packages/',
    'util depends on screen (apps/), forbidden from packages/',
  ]);
});

test('the commit hook blocks a finding and lets the rest through', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rules-'));
  try {
    mkdirSync(join(repo, 'scripts', 'warden'), { recursive: true });
    mkdirSync(join(repo, 'config'));
    for (const f of ['rules.mjs', 'checks.mjs', 'boundaries.mjs', 'config.mjs', 'messages.mjs', 'messages.en.mjs', 'messages.fr.mjs', 'messages-ui.en.mjs', 'messages-ui.fr.mjs', 'messages-ui-config.en.mjs', 'messages-ui-config.fr.mjs']) cpSync(join(KIT, f), join(repo, 'scripts', 'warden', f));
    writeFileSync(join(repo, 'config', 'rules.json'), JSON.stringify(DATA));
    for (const [path, content] of Object.entries(BASE)) writeFileSync(join(repo, path), content);

    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const check = () => spawnSync(process.execPath, ['scripts/warden/rules.mjs', '--staged'], { cwd: repo, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('add', '-A');
    assert.equal(check().status, 0, check().stderr);

    writeFileSync(join(repo, 'capture.png'), 'x');
    git('add', 'capture.png');
    const refused = check();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /capture\.png/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a lockfile behind the manifests is named, never rewritten', () => {
  assert.ok(staleLock('error: the lock file /p/Cargo.lock needs to be updated but --locked was passed to prevent this\nIf you want to try to generate the lock file without accessing the network, remove the --locked flag and use --offline instead.'));
  assert.ok(!staleLock('error: failed to get `serde` as a dependency of package `engine`'), 'a missing dependency offline is another failure');
});
