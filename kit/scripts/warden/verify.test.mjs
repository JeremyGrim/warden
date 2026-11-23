import './git-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failedTests, mainPushRefusal, pushedRefs, pushPlan, withDependents, workspacePackages } from './verify.mjs';

// A small workspace: the model, the store depending on it, the core depending on the store, the shell of the core, and
// a separate tool. The store depends on the model only for its tests.
const ROOT = process.platform === 'win32' ? 'E:\\repo' : '/repo';
const sep = process.platform === 'win32' ? '\\' : '/';
const pkg = (name, dir, dependencies = []) => ({
  id: `${name} 1.0.0`,
  name,
  manifest_path: [ROOT, ...dir.split('/').filter(Boolean), 'Cargo.toml'].join(sep),
  dependencies: dependencies.map(([d, kind]) => ({ name: d, kind: kind ?? null, path: [ROOT, 'x', d].join(sep) })),
});
const METADATA = {
  workspace_root: ROOT,
  workspace_members: ['model 1.0.0', 'store 1.0.0', 'core 1.0.0', 'shell 1.0.0', 'tool 1.0.0'],
  packages: [
    pkg('model', 'crates/model'),
    pkg('store', 'crates/store', [['model', 'dev'], ['serde']]),
    pkg('core', 'crates/core', [['store']]),
    pkg('shell', 'apps/shell', [['core']]),
    pkg('tool', 'crates/tool'),
  ],
};
const PACKAGES = workspacePackages(METADATA);
const VERIFY = {
  rust: { full_on: ['^Cargo\\.(toml|lock)$', '^rust-toolchain\\.toml$', '^\\.cargo/', '^vendor/'], deny: 'config/deny.toml' },
  npm_advisories: { lockfile: 'pnpm-lock.yaml' },
  steps: [
    { title: 'Front build', when: ['^apps/front/', '^pnpm-lock\\.yaml$'], command: ['pnpm', '--filter', 'front', 'build'] },
    { title: 'Gateway tests', when: ['^apps/gateway/'], command: ['pnpm', '--filter', 'gateway', 'test'] },
  ],
};
const plan = (files, verify = VERIFY) => pushPlan(files, PACKAGES, verify);
const titles = (p) => p.steps.map((s) => s.title);

test('workspace packages keep their workspace dependencies, dev ones included', () => {
  const store = PACKAGES.find((p) => p.name === 'store');
  assert.equal(store.dir, 'crates/store');
  assert.deepEqual(store.dependencies, ['model'], 'serde is not in the workspace');
});

test('a change verifies its package and everything that depends on it, even transitively', () => {
  assert.deepEqual(withDependents(['store'], PACKAGES), ['core', 'shell', 'store']);
  const p = plan(['crates/store/src/lib.rs', 'docs/disk.md']);
  assert.deepEqual(p.rust, { all: false, clippy: ['core', 'shell', 'store'], tests: ['store'] });
  assert.deepEqual(p.steps, []);
});

test('a file outside any Rust package compiles nothing', () => {
  assert.deepEqual(plan(['docs/disk.md', 'scripts/warden/disk.mjs', '.githooks/pre-push']).rust, { all: false, clippy: [], tests: [] });
});

test('files at the Rust root verify the whole workspace', () => {
  for (const file of ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', '.cargo/config.toml', 'vendor/surrealdb/src/lib.rs']) {
    assert.equal(plan([file]).rust.all, true, file);
  }
  assert.equal(plan(['crates/model/src/lib.rs']).rust.all, false, 'the model does not reach the tool');
  assert.equal(plan(['crates/model/src/lib.rs', 'crates/tool/src/lib.rs']).rust.all, true, 'every package reached');
});

test('a folder with a neighbouring name is not the package', () => {
  assert.deepEqual(plan(['crates/model-bis/src/lib.rs']).rust.clippy, []);
});

test('a package at the root takes what no other takes', () => {
  const alone = workspacePackages({ workspace_root: ROOT, workspace_members: ['root 1.0.0'], packages: [pkg('root', '')] });
  assert.equal(alone[0].dir, '');
  assert.deepEqual(pushPlan(['src/main.rs'], alone, VERIFY).rust, { all: true, clippy: [], tests: [] }, 'a single package, the whole workspace');
});

test('project steps run when their paths change', () => {
  assert.deepEqual(titles(plan(['apps/front/src/App.tsx'])), ['Front build']);
  assert.deepEqual(titles(plan(['pnpm-lock.yaml'])), ['Front build']);
  assert.equal(plan(['pnpm-lock.yaml']).npmAdvisories, true, 'a changed npm lockfile goes through the advisories');
  assert.equal(plan(['apps/front/src/App.tsx']).npmAdvisories, false);
  assert.deepEqual(titles(plan(['apps/gateway/proxy.mjs'])), ['Gateway tests']);
  assert.deepEqual(titles(plan(['docs/a.md'])), []);
});

test('with no Rust section and no npm advisories, nothing of either', () => {
  const nodeOnly = { steps: [{ title: 'Tests', when: ['^src/'], command: ['node', '--test'] }] };
  const p = pushPlan(['Cargo.lock', 'pnpm-lock.yaml', 'src/a.mjs'], null, nodeOnly);
  assert.deepEqual(p.rust, { all: false, clippy: [], tests: [] });
  assert.equal(p.dependencies, false);
  assert.equal(p.npmAdvisories, false);
  assert.deepEqual(titles(p), ['Tests']);
});

test('the hook reads what Git pushes, and skips deletions', () => {
  const zero = '0'.repeat(40);
  const input = `refs/heads/a ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\nrefs/heads/x ${zero} refs/heads/x ${'c'.repeat(40)}\n`;
  assert.deepEqual(pushedRefs(input), [{ localRef: 'refs/heads/a', local: 'a'.repeat(40), remoteRef: 'refs/heads/main', remote: 'b'.repeat(40) }]);
  assert.deepEqual(pushedRefs(''), []);
});

test('an added or bumped dependency goes through the dependency check, when set', () => {
  for (const file of ['Cargo.lock', 'Cargo.toml', 'crates/store/Cargo.toml', 'config/deny.toml']) {
    assert.equal(plan([file]).dependencies, true, file);
  }
  assert.equal(plan(['crates/store/src/lib.rs']).dependencies, false);
  assert.equal(plan(['Cargo.lock'], { ...VERIFY, rust: { ...VERIFY.rust, deny: null } }).dependencies, false, 'without cargo deny, nothing');
});

test('failed tests are read from the cargo test output, once each', () => {
  const output = 'running 3 tests\ntest a::ok ... ok\ntest cognition::c45 ... FAILED\r\ntest b::slow has been running for over 60 seconds\ntest b::slow ... FAILED\n\nfailures:\n    cognition::c45\ntest cognition::c45 ... FAILED\n';
  assert.deepEqual(failedTests(output), ['cognition::c45', 'b::slow']);
  assert.deepEqual(failedTests('test result: ok. 3 passed'), []);
});

test('only the declared factory pushes to the main branch', () => {
  const factory = process.platform === 'win32' ? 'C:\\repos\\project-factory' : '/repos/project-factory';
  const agent = process.platform === 'win32' ? 'C:\\repos\\project-agent' : '/repos/project-agent';
  const toMain = { local: 'a'.repeat(40), remoteRef: 'refs/heads/main' };
  assert.match(mainPushRefusal({ toMain, factoryTree: factory, root: agent, branch: 'main' }) ?? '', /factory.*main.*project-factory/);
  const written = process.platform === 'win32' ? factory.toUpperCase().replaceAll('\\', '/') : factory;
  assert.equal(mainPushRefusal({ toMain, factoryTree: written, root: factory, branch: 'main' }), null, 'the factory itself, however its path is written');
  assert.equal(mainPushRefusal({ toMain: null, factoryTree: factory, root: agent, branch: 'main' }), null, 'a push to another branch');
  assert.equal(mainPushRefusal({ toMain, factoryTree: null, root: agent, branch: 'main' }), null, 'no factory declared yet');
});
