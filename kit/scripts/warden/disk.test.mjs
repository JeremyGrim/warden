// First: no git of this test inherits the repository that launches it (git-env.mjs).
import './git-env.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  GIB, buildInTree, cargoLocks, clean, cleanBuild, cloneTree, disposables, evaluate, heldLocks, measure, readable, refusalReason,
  sharedCaches, sharedTarget, treeBusy, worktrees,
} from './disk.mjs';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const BUDGETS = { min_free_gib: 0, max_build_gib: 1000, max_incremental_gib: 1000, max_worktrees: 1, max_worktree_age_days: 7 };

function tray(t) {
  const folder = mkdtempSync(join(tmpdir(), 'disk-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function write(path, bytes = 10) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, LINK_TYPE);
}

function buildTree(root) {
  write(join(root, 'target/debug/deps/a.rlib'), 100);
  write(join(root, 'target/debug/incremental/a/b.bin'), 200);
  write(join(root, 'target/x86_64-pc/debug/incremental/c.bin'), 50);
  write(join(root, 'target/tmp/t.bin'), 5);
  write(join(root, 'node_modules/.cache/n.bin'), 7);
  write(join(root, 'node_modules/pkg/index.js'), 30);
}

test('readable speaks binary units', () => {
  assert.equal(readable(512), '512 B');
  assert.equal(readable(2048), '2.0 KiB');
  assert.equal(readable(3 * GIB), '3.0 GiB');
});

test('measure never crosses a link', async (t) => {
  const root = tray(t);
  write(join(root, 'outside/big.bin'), 1000);
  write(join(root, 'inside/a.bin'), 10);
  link(join(root, 'outside'), join(root, 'inside/link'));
  const m = await measure(join(root, 'inside'));
  assert.equal(m.bytes, 10);
  assert.equal(m.files, 1);
  assert.equal(m.links.length, 1);
});

test('measuring an absent folder gives zero', async (t) => {
  assert.equal((await measure(join(tray(t), 'absent'))).bytes, 0);
});

test('disposables names what regenerates quickly, and nothing else', async (t) => {
  const root = tray(t);
  buildTree(root);
  const names = (await disposables(root)).map((c) => c.slice(root.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(names, ['node_modules/.cache', 'target/debug/incremental', 'target/tmp', 'target/x86_64-pc/debug/incremental']);
});

test('clean is a dry run by default', async (t) => {
  const root = tray(t);
  buildTree(root);
  const seen = await clean({ root });
  assert.equal(seen.reduce((sum, r) => sum + r.bytes, 0), 262);
  assert.ok(seen.every((r) => !r.removed && !r.refused));
  assert.ok(existsSync(join(root, 'target/debug/incremental/a/b.bin')));
});

test('clean applies to disposables and keeps dependencies', async (t) => {
  const root = tray(t);
  buildTree(root);
  await clean({ root, apply: true });
  assert.ok(!existsSync(join(root, 'target/debug/incremental')));
  assert.ok(!existsSync(join(root, 'target/x86_64-pc/debug/incremental')));
  assert.ok(!existsSync(join(root, 'node_modules/.cache')));
  assert.ok(existsSync(join(root, 'target/debug/deps/a.rlib')));
  assert.ok(existsSync(join(root, 'node_modules/pkg/index.js')));
});

test('deep removes the whole build, only when applied', async (t) => {
  const root = tray(t);
  buildTree(root);
  await clean({ root, deep: true });
  assert.ok(existsSync(join(root, 'target/debug/deps/a.rlib')));
  await clean({ root, deep: true, apply: true });
  assert.ok(!existsSync(join(root, 'target')));
  assert.ok(!existsSync(join(root, 'node_modules')));
});

test('a build holds back only its tree, not the other trees of the workstation', () => {
  const root = process.platform === 'win32' ? 'E:\\trees\\project-e2' : '/trees/project-e2';
  const other = root.replace('e2', 'e1');
  const rustc = (tree) => ({ name: 'rustc.exe', line: `rustc --crate-name a --out-dir ${join(tree, 'target', 'debug', 'deps')}`, dir: '' });
  assert.equal(buildInTree(root, [rustc(other), { name: 'cargo.exe', line: 'cargo check', dir: '' }]), null);
  assert.equal(buildInTree(root, [rustc(`${root}-bis`)]), null, 'a tree with a neighbouring name is not this one');
  assert.equal(buildInTree(root, [rustc(root)])?.name, 'rustc.exe');
  assert.equal(buildInTree(root, [{ name: 'cargo', line: 'cargo test', dir: `${root}/crates/a` }])?.name, 'cargo');
  assert.equal(buildInTree(root, [{ name: 'Code.exe', line: `code ${root}`, dir: '' }]), null, 'an editor is not a build');
  const testBinary = { name: 'all-1f2e.exe', line: 'all-1f2e.exe b03', executable: join(root, 'target', 'debug', 'deps', 'all-1f2e.exe') };
  assert.equal(buildInTree(root, [testBinary])?.name, 'all-1f2e.exe', 'a test launched from the tree holds it');
  assert.equal(buildInTree(other, [testBinary]), null);
});

// Another process takes the lock the way Cargo does, and holds it until released.
function holdLock(t, file) {
  const script = process.platform === 'win32'
    ? `$s = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'ReadWrite, Delete'); $s.Lock(0, 1); 'ready'; [Console]::In.ReadLine() | Out-Null`
    : null;
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    : spawn('flock', [file, 'sh', '-c', 'echo ready; read line']);
  t.after(() => {
    child.stdin.end('\n');
    child.kill();
  });
  return new Promise((ready, fail) => {
    child.on('error', fail);
    child.stdout.on('data', (chunk) => String(chunk).includes('ready') && ready());
  });
}

test('a held Cargo lock holds its tree back, and only it', { skip: process.platform === 'darwin' && 'no flock' }, async (t) => {
  const trays = tray(t);
  const held = join(trays, 'e2');
  const free = join(trays, 'e1');
  for (const tree of [held, free]) {
    buildTree(tree);
    write(join(tree, 'target/debug/.cargo-lock'), 0);
    write(join(tree, 'target/x86_64-pc/release/.cargo-build-lock'), 0);
  }
  assert.equal((await cargoLocks(join(held, 'target'))).length, 2);
  assert.deepEqual(heldLocks(await cargoLocks(join(held, 'target'))), [], 'a lock set but released holds nothing');
  await holdLock(t, join(held, 'target/x86_64-pc/release/.cargo-build-lock'));
  assert.match(await treeBusy(held, []), /Cargo holds target[\\/]x86_64-pc[\\/]release[\\/]\.cargo-build-lock/);
  assert.equal(await treeBusy(free, []), null, 'the build of another tree does not hold this one');
});

test('deep removes nothing from a build that a launched program holds open', { skip: process.platform !== 'win32' && 'only Windows refuses to rename a held folder' }, async (t) => {
  const root = tray(t);
  buildTree(root);
  write(join(root, 'target/debug/app.exe'), 0);
  const handle = openSync(join(root, 'target/debug/app.exe'), 'r');
  t.after(() => closeSync(handle));
  const seen = await clean({ root, deep: true, apply: true });
  const build = seen.find((r) => r.target.endsWith('target'));
  assert.match(build.refused, /held by a process/);
  assert.equal(build.removed, false);
  assert.ok(existsSync(join(root, 'target/debug/deps/a.rlib')), 'the held build stays whole');
  assert.ok(!existsSync(join(root, 'node_modules')), 'what is not held goes anyway');
  assert.deepEqual(readdirSync(root).filter((name) => name.includes('to-remove')), [], 'nothing is left half done');
});

test('a target that is a link elsewhere is never emptied', async (t) => {
  const trays = tray(t);
  const root = join(trays, 'tree');
  const elsewhere = join(trays, 'shared-target');
  buildTree(elsewhere);
  mkdirSync(root);
  link(join(elsewhere, 'target'), join(root, 'target'));

  for (const deep of [false, true]) {
    const seen = await clean({ root, deep, apply: true });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((r) => !r.removed && r.refused));
  }
  assert.ok(existsSync(join(elsewhere, 'target/debug/incremental/a/b.bin')));
  assert.ok(existsSync(join(elsewhere, 'target/debug/deps/a.rlib')));
});

test('a target that contains a link is not removed', async (t) => {
  const root = tray(t);
  write(join(root, 'precious/keep.bin'), 10);
  write(join(root, 'target/debug/incremental/a.bin'), 10);
  link(join(root, 'precious'), join(root, 'target/debug/incremental/link'));
  const [result] = await clean({ root, apply: true });
  assert.equal(result.removed, false);
  assert.match(result.refused, /link/);
  assert.ok(existsSync(join(root, 'precious/keep.bin')));
  assert.ok(existsSync(join(root, 'target/debug/incremental/a.bin')));
});

test('a build outside any repository is handled the same way', async (t) => {
  const trays = tray(t);
  const build = join(trays, 'targets/project-main');
  write(join(build, 'debug/deps/a.rlib'), 100);
  write(join(build, 'debug/incremental/a.bin'), 200);

  const dry = await cleanBuild({ build });
  assert.equal(dry.reduce((s, r) => s + r.bytes, 0), 200);
  assert.ok(existsSync(join(build, 'debug/incremental/a.bin')));

  await cleanBuild({ build, apply: true });
  assert.ok(!existsSync(join(build, 'debug/incremental')));
  assert.ok(existsSync(join(build, 'debug/deps/a.rlib')));

  await cleanBuild({ build, deep: true, apply: true });
  assert.ok(!existsSync(build));
});

test('a build outside any repository that is a link is not emptied', async (t) => {
  const trays = tray(t);
  write(join(trays, 'real/debug/incremental/a.bin'), 10);
  link(join(trays, 'real'), join(trays, 'targets/link'));
  const [result] = await cleanBuild({ build: join(trays, 'targets/link'), deep: true, apply: true });
  assert.equal(result.removed, false);
  assert.ok(result.refused);
  assert.ok(existsSync(join(trays, 'real/debug/incremental/a.bin')));
});

test('refusalReason refuses what leaves the root', async (t) => {
  const root = tray(t);
  write(join(root, 'a/b.bin'));
  assert.equal(await refusalReason(root, join(root, 'a')), null);
  assert.equal(await refusalReason(root, root), 'outside the root');
  assert.equal(await refusalReason(join(root, 'a'), root), 'outside the root');
  assert.equal(await refusalReason(root, join(root, 'absent')), 'absent');
});

function repoWithTree(t) {
  const trays = tray(t);
  const root = join(trays, 'repo');
  const remote = join(trays, 'remote.git');
  const tree = join(trays, 'tree');
  mkdirSync(root);
  const git = (cwd, ...args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
  };
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'a');
  git(trays, 'init', '--bare', '-b', 'main', 'remote.git');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'worktree', 'add', '-b', 'trial', tree);
  return { root, tree, git };
}

test('a clean, pushed worktree is removable, the others are not', async (t) => {
  const { root, tree, git } = repoWithTree(t);

  let [state] = worktrees(root);
  assert.equal(state.branch, 'trial');
  assert.equal(state.removable, false, 'nothing is pushed');
  assert.equal(state.unpushed, 1);

  git(tree, 'push', 'origin', 'trial');
  [state] = worktrees(root);
  assert.equal(state.removable, true);

  writeFileSync(join(tree, 'b.txt'), 'b');
  [state] = worktrees(root);
  assert.equal(state.removable, false, 'an uncommitted file');
  assert.equal(state.modified, 1);
});

test('evaluate alerts on exceeded budgets', async (t) => {
  const root = tray(t);
  write(join(root, 'target/debug/deps/a.rlib'), 2048);
  write(join(root, 'target/debug/incremental/a.bin'), 1024);

  assert.deepEqual((await evaluate({ root, config: BUDGETS, env: {} })).alerts, []);

  const tight = { ...BUDGETS, min_free_gib: 1e9, max_build_gib: 1 / GIB, max_incremental_gib: 1 / GIB };
  const { alerts } = await evaluate({ root, config: tight, env: {} });
  assert.equal(alerts.length, 3);
  assert.equal((await evaluate({ root, config: tight, quick: true, env: {} })).alerts.length, 1);
});

test('evaluate counts worktrees in excess', async (t) => {
  const { root } = repoWithTree(t);
  assert.deepEqual((await evaluate({ root, config: BUDGETS, quick: true, env: {} })).alerts, []);
  const { alerts } = await evaluate({ root, config: { ...BUDGETS, max_worktrees: 0 }, quick: true, env: {} });
  assert.equal(alerts.length, 1);
});

test('evaluate reports a build in a frozen copy', async (t) => {
  const root = tray(t);
  const config = { ...BUDGETS, frozen_copies: ['frozen_source'] };
  mkdirSync(join(root, 'frozen_source/crates'), { recursive: true });
  assert.deepEqual((await evaluate({ root, config, quick: true, env: {} })).alerts, []);
  mkdirSync(join(root, 'frozen_source/target'));
  assert.deepEqual((await evaluate({ root, config: BUDGETS, quick: true, env: {} })).alerts, [], 'no frozen copy declared, nothing');
  const { alerts } = await evaluate({ root, config, quick: true, env: {} });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /frozen copy/);
});

test('evaluate refuses a build shared with another tree', async (t) => {
  const trays = tray(t);
  const root = join(trays, 'tree');
  mkdirSync(join(trays, 'elsewhere/target'), { recursive: true });
  mkdirSync(root);

  assert.deepEqual(await sharedTarget(root, {}), null);
  assert.deepEqual(await sharedTarget(root, { CARGO_TARGET_DIR: join(root, 'target') }), null);
  assert.match(await sharedTarget(root, { CARGO_TARGET_DIR: join(trays, 'elsewhere/target') }), /outside this tree/);

  link(join(trays, 'elsewhere/target'), join(root, 'target'));
  assert.match(await sharedTarget(root, {}), /link/);
  const { alerts } = await evaluate({ root, config: BUDGETS, quick: true, env: {} });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /without compiling/);
});

test('the shared cache is read from the workstation Cargo configuration, or declared', () => {
  const cargo = "[build]\nrustc-wrapper = 'sccache'\n[env]\nSCCACHE_DIR = 'D:/cache/sccache'\nSCCACHE_CACHE_SIZE = '20G'\n";
  assert.deepEqual(sharedCaches({}, cargo), [{ path: 'D:/cache/sccache', max_gib: 20 }]);
  assert.deepEqual(sharedCaches({}, "SCCACHE_DIR = \"/var/cache/s\"\nSCCACHE_CACHE_SIZE = \"512M\"\n"), [{ path: '/var/cache/s', max_gib: 0.5 }]);
  assert.deepEqual(sharedCaches({}, "SCCACHE_DIR = '/c'\n"), [{ path: '/c', max_gib: null }], 'no size, no invented ceiling');
  assert.deepEqual(sharedCaches({}, '[net]\ngit-fetch-with-cli = true\n'), [], 'no cache plugged in, nothing');
  const declared = [{ path: 'X:/other', max_gib: 5 }];
  assert.deepEqual(sharedCaches({ shared_caches: declared }, cargo), declared, 'the local declaration comes first');
});

test('evaluate measures the shared cache and alerts beyond its ceiling, without counting it in the build', async (t) => {
  const root = tray(t);
  buildTree(root);
  const cache = join(tray(t), 'sccache');
  write(join(cache, 'a', 'b.bin'), 2048);
  const under = await evaluate({ root, config: { ...BUDGETS, shared_caches: [{ path: cache, max_gib: 1 }] } });
  assert.equal(under.measures.caches[0].bytes, 2048);
  assert.deepEqual(under.alerts, []);
  const over = await evaluate({ root, config: { ...BUDGETS, shared_caches: [{ path: cache, max_gib: 1 / GIB }] } });
  assert.ok(over.alerts.some((a) => a.startsWith(`Shared cache ${cache}`)));
  assert.equal(over.measures.build.bytes, under.measures.build.bytes, 'the cache is not part of the tree build');
  const seen = await clean({ root, deep: true });
  assert.ok(seen.every((r) => !r.target.startsWith(cache)), 'clean never aims at it');
});

test('--tree names a tree of the clone, or of a declared folder of agent trees, and nothing else', (t) => {
  const { root, tree, git } = repoWithTree(t);
  assert.equal(cloneTree(root, root), true, 'the main tree');
  assert.equal(cloneTree(root, tree), true, 'a worktree');
  assert.equal(cloneTree(root, 'tree'), false, 'never a relative path');
  assert.equal(cloneTree(root, join(dirname(root), 'elsewhere')), false, 'never a folder that does not exist');
  const outside = join(dirname(root), 'agents', 'one');
  mkdirSync(outside, { recursive: true });
  git(outside, 'init', '-b', 'main');
  assert.equal(cloneTree(root, outside), false, 'a repository of the workstation that nobody declared');
  git(root, 'config', '--add', 'warden.agentTrees', join(dirname(root), 'agents'));
  assert.equal(cloneTree(root, outside), true, 'a tree of the declared folder');
  assert.equal(cloneTree(root, join(dirname(root), 'agents')), false, 'the folder itself is no tree');
  mkdirSync(join(outside, 'sub'));
  assert.equal(cloneTree(root, join(outside, 'sub')), false, 'a folder inside a tree is not a tree');
});
