#!/usr/bin/env node
// The disk method, tooled. Budgets are in config/disk.json, and in config/disk.local.json for what belongs to the
// workstation (never committed).
//
//   node scripts/warden/disk.mjs report [--root <repo>]... [--build <folder>]...
//   node scripts/warden/disk.mjs guard  [--warn]
//   node scripts/warden/disk.mjs clean  [--deep] [--apply] [--root <repo>]... [--build <folder>]...
//   node scripts/warden/disk.mjs clean  --own [--deep] [--apply]     the factory tree alone, from the factory tree
//
// `clean` is a dry run by default. Nothing follows a link, nothing leaves the root, and a worktree is never removed by
// this tool.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { lstat, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { freemem, homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stationSetting } from './config.mjs';
import { t } from './messages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLEAN = 'node scripts/warden/disk.mjs clean';
export const GIB = 1024 ** 3;

export function readable(bytes) {
  const units = t('disk.units').split(',');
  let value = bytes;
  let rank = 0;
  while (value >= 1024 && rank < units.length - 1) {
    value /= 1024;
    rank += 1;
  }
  return `${rank === 0 ? value : value.toFixed(1)} ${units[rank]}`;
}

// Measures without ever crossing a link. On Windows, a junction counts as a link.
export async function measure(path) {
  const total = { bytes: 0, files: 0, links: [] };
  const start = await lstat(path).catch(() => null);
  if (!start) return total;
  if (start.isSymbolicLink()) {
    total.links.push(path);
    return total;
  }
  if (!start.isDirectory()) {
    total.bytes = start.size;
    total.files = 1;
    return total;
  }

  const readFolder = async (folder) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(folder, entry.name);
      if (entry.isSymbolicLink()) total.links.push(child);
      else if (entry.isDirectory()) stack.push(child);
      else {
        const card = await lstat(child).catch(() => null);
        if (card) {
          total.bytes += card.size;
          total.files += 1;
        }
      }
    }
  };

  const stack = [path];
  let active = 0;
  await new Promise((done, fail) => {
    const next = () => {
      if (stack.length === 0 && active === 0) {
        done();
        return;
      }
      while (active < 32 && stack.length) {
        active += 1;
        readFolder(stack.pop()).then(() => {
          active -= 1;
          next();
        }, fail);
      }
    };
    next();
  });
  return total;
}

// A target is safe when no link sits under the root on its way, and it stays inside the root once resolved.
export async function refusalReason(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return t('disk.refuse.outside');
  let current = root;
  for (const piece of rel.split(sep)) {
    current = join(current, piece);
    const card = await lstat(current).catch(() => null);
    if (!card) return t('disk.refuse.absent');
    if (card.isSymbolicLink()) return t('disk.refuse.link', { path: current });
  }
  const resolved = relative(await realpath(root), await realpath(target));
  if (resolved.startsWith('..') || isAbsolute(resolved)) return t('disk.refuse.outside_resolved');
  return null;
}

async function subfolders(folder) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// The incremental caches of a build folder, profiles and target triples included.
async function incrementals(build) {
  const found = [];
  for (const level1 of await subfolders(build)) {
    const folder1 = join(build, level1);
    if (existsSync(join(folder1, 'incremental'))) found.push(join(folder1, 'incremental'));
    for (const level2 of await subfolders(folder1)) {
      const candidate = join(folder1, level2, 'incremental');
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

// What regenerates quickly in a build folder.
export async function buildDisposables(build) {
  const fixed = ['tmp', 'doc', 'package'].map((c) => join(build, c)).filter((c) => existsSync(c));
  return [...(await incrementals(build)), ...fixed];
}

// What regenerates quickly in a repository: disposable without a second thought.
export async function disposables(root) {
  const fixed = ['node_modules/.cache', 'coverage'].map((c) => join(root, ...c.split('/'))).filter((c) => existsSync(c));
  return [...(await buildDisposables(join(root, 'target'))), ...fixed];
}

// What regenerates slowly: only on request.
export function heavy(root) {
  return ['target', 'node_modules'].map((c) => join(root, c)).filter((c) => existsSync(c));
}

function git(args, cwd) {
  const out = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.status === 0 ? out.stdout : null;
}

export function worktrees(root) {
  const out = git(['worktree', 'list', '--porcelain'], root);
  if (!out) return [];
  const blocks = out.trim().split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const value = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
    return { path: value('worktree'), branch: value('branch')?.replace('refs/heads/', '') ?? t('disk.detached') };
  });
  return blocks.slice(1).map((tree) => {
    if (!existsSync(tree.path)) return { ...tree, absent: true, removable: true, modified: 0, unpushed: 0, ageDays: 0 };
    const modified = (git(['status', '--porcelain'], tree.path) ?? '').split('\n').filter(Boolean).length;
    const unpushed = Number(git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], tree.path) ?? 0);
    const date = Number(git(['log', '-1', '--format=%ct'], tree.path) ?? 0);
    const ageDays = Math.floor((Date.now() / 1000 - date) / 86400);
    return { ...tree, modified, unpushed, ageDays, removable: modified === 0 && unpushed === 0 };
  });
}

// The memory the workstation can still commit, in bytes: past it, a build fails (Windows: os error 1455, 19 November).
// Windows gives it directly; Linux, the available memory plus the free swap; elsewhere, the free memory. Null when the
// workstation does not say.
export function freeMemory() {
  if (process.platform === 'win32') {
    const script = '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory';
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
    const kib = Number(out.stdout?.trim());
    return out.status === 0 && Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  }
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? 0);
    return (kib('MemAvailable') + kib('SwapFree')) * 1024 || null;
  } catch {
    return freemem();
  }
}

// The shared cache client (sccache) also holds the tree it compiles: a build served by the cache launches no rustc.
export const BUILD_TOOLS = /^(cargo|rustc|clippy-driver|link|lld-link|rust-lld|cc|ld|cargo-deny|sccache|build-script-[\w-]+)(\.exe)?$/i;
const CARGO_LOCKS = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];

// The workstation processes: id, parent, name, command line, executable and, outside Windows, working folder.
export function stationProcesses() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress';
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (out.status !== 0 || !out.stdout.trim()) return null;
    return [JSON.parse(out.stdout)].flat().map((p) => ({
      pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name ?? '', line: p.CommandLine ?? '', executable: p.ExecutablePath ?? '', dir: '',
    }));
  }
  let pids;
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const read = (f) => {
    try {
      return f();
    } catch {
      return '';
    }
  };
  return pids.map((pid) => {
    const line = read(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '));
    return {
      pid: Number(pid),
      parent: Number(read(() => readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+\S+\s+/, '').split(' ')[0])) || 0,
      name: basename(line.split(' ')[0] ?? ''),
      line,
      executable: read(() => readlinkSync(`/proc/${pid}/exe`)),
      dir: read(() => readlinkSync(`/proc/${pid}/cwd`)),
    };
  });
}

export function inTree(root) {
  const normal = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const pattern = new RegExp(`${normal(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/"' ])`);
  return (text) => Boolean(text) && pattern.test(normal(text));
}

// A process holds this tree: a build tool whose command line names the tree or which works in it, or any program
// launched from the tree (a test, a build script, the built application). Processes of the other trees of the
// workstation do not count: with several agents, there always is one.
export function buildInTree(root, processes = stationProcesses()) {
  if (!processes) return null;
  const inside = inTree(root);
  return processes.find((p) => inside(p.executable) || (BUILD_TOOLS.test(p.name) && (inside(p.line) || inside(p.dir)))) ?? null;
}

// The locks Cargo sets in a build folder, profiles and target triples included.
export async function cargoLocks(build) {
  const folders = [];
  for (const level1 of await subfolders(build)) {
    folders.push(join(build, level1));
    for (const level2 of await subfolders(join(build, level1))) folders.push(join(build, level1, level2));
  }
  return folders.flatMap((folder) => CARGO_LOCKS.map((name) => join(folder, name))).filter((path) => existsSync(path));
}

// Cargo does not name its tree (on Windows its working folder cannot be read), and its open files do not prevent
// renaming `target`. But while it compiles it keeps its locks: we try to take them.
export function heldLocks(files) {
  if (!files.length) return [];
  if (process.platform === 'win32') {
    const script = [
      '$held = foreach ($f in $input) {',
      "  try { $s = [IO.File]::Open($f, 'Open', 'ReadWrite', 'ReadWrite, Delete') } catch { $f; continue }",
      '  try { $s.Lock(0, 1); $s.Unlock(0, 1) } catch { $f } finally { $s.Dispose() }',
      '}',
      '$held',
    ].join('\n');
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, input: files.join('\n'), encoding: 'utf8' });
    if (out.status !== 0) return files;
    return out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  return files.filter((f) => {
    const attempt = spawnSync('flock', ['-n', '-E', '75', f, 'true'], { windowsHide: true });
    return attempt.error ? false : attempt.status === 75;
  });
}

// What keeps a tree from being cleaned, or null. Each tree for itself.
export async function treeBusy(root, processes = stationProcesses()) {
  const held = buildInTree(root, processes);
  if (held) return t('disk.busy.process', { name: held.name });
  const build = existsSync(join(root, 'target')) ? join(root, 'target') : root;
  const locks = heldLocks(await cargoLocks(build));
  if (locks.length) return t('disk.busy.cargo', { lock: relative(root, locks[0]) });
  return null;
}

// Remove by renaming first: a half-emptied `target` in place would fool the next build, while a folder moved aside lets
// it start from scratch. A file that cannot be removed is said, not hidden.
async function remove(target) {
  const aside = `${target}.to-remove-${process.pid}`;
  try {
    await rename(target, aside);
  } catch (error) {
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return t('disk.refuse.held');
    throw error;
  }
  try {
    await rm(aside, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    return t('disk.refuse.partial', { path: aside, code: error.code });
  }
  return null;
}

async function freeSpace(path) {
  const card = await statfs(path);
  return card.bavail * card.bsize;
}

// Two trees on the same `target` each think the other is up to date: Cargo compares dates, and a tree can turn green
// without its code being compiled.
export async function sharedTarget(root, env) {
  const card = await lstat(join(root, 'target')).catch(() => null);
  if (card?.isSymbolicLink()) return t('disk.target_is_link');
  if (env.CARGO_TARGET_DIR) {
    const rel = relative(root, resolve(root, env.CARGO_TARGET_DIR));
    if (rel.startsWith('..') || isAbsolute(rel)) return t('disk.target_outside');
  }
  return null;
}

export async function evaluate({ root, config, quick = false, env = process.env }) {
  const alerts = [];
  const free = await freeSpace(root);
  if (free < config.min_free_gib * GIB) {
    alerts.push(t('disk.free_low', { drive: parse(root).root, free: readable(free), min: config.min_free_gib, clean: CLEAN }));
  }
  const shared = await sharedTarget(root, env);
  if (shared) alerts.push(t('disk.shared_target', { reason: shared }));
  // A frozen copy (the origin repository of a migration) is read, never compiled.
  for (const frozen of config.frozen_copies ?? []) {
    if (existsSync(join(root, frozen, 'target'))) alerts.push(t('disk.frozen_built', { dir: frozen }));
  }
  // The factory tree is not an agent's: it never counts in the worktree budget, nor ages (21 November). Nor does the
  // release and version trees the factory keeps in its work folder.
  const factoryTree = stationSetting('factory', root);
  const kitTree = (path) => (factoryTree && resolve(path).toLowerCase() === resolve(factoryTree).toLowerCase()) || /[\\/](release|version)-tree$/.test(path);
  const trees = worktrees(root).filter((tree) => !kitTree(tree.path));
  if (trees.length > config.max_worktrees) alerts.push(t('disk.too_many_trees', { count: trees.length, max: config.max_worktrees }));
  for (const tree of trees) {
    if (tree.ageDays > config.max_worktree_age_days) alerts.push(t('disk.old_tree', { days: tree.ageDays, path: tree.path }));
  }
  const measures = {};
  if (!quick) {
    measures.build = await measure(join(root, 'target'));
    measures.incremental = 0;
    for (const folder of await incrementals(join(root, 'target'))) measures.incremental += (await measure(folder)).bytes;
    if (measures.build.bytes > config.max_build_gib * GIB) {
      alerts.push(t('disk.build_over', { size: readable(measures.build.bytes), max: config.max_build_gib, clean: CLEAN }));
    }
    if (measures.incremental > config.max_incremental_gib * GIB) {
      alerts.push(t('disk.incremental_over', { size: readable(measures.incremental), max: config.max_incremental_gib, clean: CLEAN }));
    }
    measures.caches = [];
    for (const cache of config.shared_caches ?? []) {
      const m = { ...cache, bytes: (await measure(cache.path)).bytes, free: await freeSpace(cache.path).catch(() => null) };
      measures.caches.push(m);
      if (cache.max_gib && m.bytes > cache.max_gib * GIB) alerts.push(t('disk.cache_over', { path: cache.path, size: readable(m.bytes), max: cache.max_gib }));
      if (m.free !== null && m.free < config.min_free_gib * GIB) {
        alerts.push(t('disk.cache_free_low', { drive: parse(cache.path).root, free: readable(m.free), min: config.min_free_gib }));
      }
    }
  }
  return { alerts, free, trees, measures };
}

// The build cache shared by every tree of the workstation. It is declared in `config/disk.local.json`
// (`shared_caches`), otherwise read from the workstation Cargo configuration, where it is plugged in (`SCCACHE_DIR`
// and `SCCACHE_CACHE_SIZE`). The guard measures it; `clean` never touches it: it bounds itself.
export function sharedCaches(config, cargoConfig) {
  if (Array.isArray(config.shared_caches)) return config.shared_caches;
  const value = (key) => new RegExp(`^\\s*${key}\\s*=\\s*['"]([^'"]+)['"]`, 'm').exec(cargoConfig ?? '')?.[1];
  const path = value('SCCACHE_DIR');
  if (!path) return [];
  const size = /^(\d+(?:\.\d+)?)\s*([KMGT])?/i.exec(value('SCCACHE_CACHE_SIZE') ?? '');
  const unit = { K: 1 / (1024 * 1024), M: 1 / 1024, G: 1, T: 1024 }[(size?.[2] ?? 'G').toUpperCase()];
  return [{ path, max_gib: size ? Number(size[1]) * unit : null }];
}

function stationCargoConfig() {
  const file = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'config.toml');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// Lists, or applies, what can be removed. Returns what was seen for each target.
export async function clean({ root, deep = false, apply = false }) {
  return handle(root, deep ? heavy(root) : await disposables(root), apply);
}

// The same for a build folder placed outside any repository.
export async function cleanBuild({ build, deep = false, apply = false }) {
  const targets = deep ? [build] : await buildDisposables(build);
  return handle(dirname(build), targets, apply);
}

async function handle(root, targets, apply) {
  const result = [];
  for (const target of targets) {
    const refused = await refusalReason(root, target);
    if (refused) {
      result.push({ target, bytes: 0, removed: false, refused });
      continue;
    }
    const m = await measure(target);
    if (m.links.length) {
      result.push({ target, bytes: m.bytes, removed: false, refused: t('disk.refuse.contains_links', { count: m.links.length, first: m.links[0] }) });
      continue;
    }
    const held = apply ? await remove(target) : null;
    result.push({ target, bytes: held ? 0 : m.bytes, removed: apply && !held, refused: held });
  }
  return result;
}

export function loadConfig(root = ROOT) {
  const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  const config = { ...readJson(join(root, 'config', 'disk.json')), ...readJson(join(root, 'config', 'disk.local.json')) };
  return { ...config, shared_caches: sharedCaches(config, stationCargoConfig()) };
}

function requestedPaths(argv, flag, fromConfig = []) {
  const paths = [];
  argv.forEach((word, i) => {
    if (word === flag && argv[i + 1]) paths.push(resolve(argv[i + 1]));
  });
  for (const path of fromConfig) paths.push(resolve(path));
  return [...new Set(paths)];
}

const requestedRoots = (argv, config) => [...new Set([ROOT, ...requestedPaths(argv, '--root', config.roots)])];
const requestedBuilds = (argv, config) => requestedPaths(argv, '--build', config.builds);

function treeLine(tree) {
  const state = tree.absent
    ? t('disk.tree.absent')
    : tree.removable
      ? t('disk.tree.removable', { path: tree.path })
      : t('disk.tree.pending', { modified: tree.modified, unpushed: tree.unpushed });
  return `    ${tree.path} [${tree.branch}], ${t('disk.tree.age', { days: tree.ageDays })}, ${state}`;
}

async function reportCommand(argv, config) {
  for (const root of requestedRoots(argv, config)) {
    if (!existsSync(root)) {
      console.log(t('disk.report.absent', { root }));
      continue;
    }
    const { alerts, free, trees, measures } = await evaluate({ root, config });
    const deps = await measure(join(root, 'node_modules'));
    const history = await measure(join(root, '.git'));
    console.log(`${basename(root)}  (${root})`);
    console.log(`  ${t('disk.report.free').padEnd(20)} ${readable(free)}`);
    console.log(`  ${t('disk.report.build').padEnd(20)} ${t('disk.report.build_detail', { build: readable(measures.build.bytes), incremental: readable(measures.incremental) })}`);
    if (measures.build.links.length) console.log(`    ${t('disk.report.link', { path: measures.build.links[0] })}`);
    console.log(`  ${'node_modules'.padEnd(20)} ${readable(deps.bytes)}`);
    console.log(`  ${t('disk.report.history').padEnd(20)} ${readable(history.bytes)}`);
    console.log(`  ${t('disk.report.trees').padEnd(20)} ${trees.length}`);
    for (const tree of trees) console.log(treeLine(tree));
    console.log(alerts.length ? alerts.map((a) => `  ! ${a}`).join('\n') : `  ${t('disk.report.within')}`);
    console.log('');
  }
  for (const build of requestedBuilds(argv, config)) {
    const m = await measure(build);
    let incremental = 0;
    for (const folder of await incrementals(build)) incremental += (await measure(folder)).bytes;
    console.log(t('disk.report.outside_build', { path: build }));
    console.log(`  ${t('disk.report.build_detail', { build: readable(m.bytes), incremental: readable(incremental) })}`);
    if (m.bytes > config.max_build_gib * GIB) console.log(`  ! ${t('disk.report.beyond', { max: config.max_build_gib })}`);
    console.log('');
  }
  for (const cache of config.shared_caches) {
    const bytes = (await measure(cache.path)).bytes;
    const max = cache.max_gib ? t('disk.report.cache_max', { max: cache.max_gib }) : '';
    console.log(t('disk.report.cache', { path: cache.path, size: readable(bytes), max, free: readable(await freeSpace(cache.path).catch(() => 0)) }));
  }
  console.log(t('disk.report.temp', { size: readable((await measure(tmpdir())).bytes) }));
}

async function guardCommand(argv, config) {
  const warnOnly = argv.includes('--warn');
  const { alerts } = await evaluate({ root: ROOT, config, quick: warnOnly });
  if (!alerts.length) {
    console.log(t('disk.guard.ok'));
    return;
  }
  for (const alert of alerts) console.error(t('disk.guard.alert', { alert }));
  if (!warnOnly) process.exitCode = 1;
}

// `--own`: the factory cleans its own tree, and only it, without asking anyone: what it removes regenerates, and the
// tree is nobody else's. It refuses in any other tree.
async function cleanCommand(argv, config) {
  const apply = argv.includes('--apply');
  const deep = argv.includes('--deep');
  if (argv.includes('--own')) {
    const factoryTree = stationSetting('factory', ROOT);
    if (!factoryTree || resolve(factoryTree).toLowerCase() !== ROOT.toLowerCase()) {
      console.error(t('disk.clean.not_own', { tree: factoryTree ?? '-' }));
      process.exitCode = 1;
      return;
    }
    argv = [];
    config = { ...config, roots: [], builds: [] };
  }
  const processes = apply ? stationProcesses() : [];
  // Each tree for itself: a build in another tree of the workstation does not hold this one back.
  const free = async (path) => {
    if (!apply) return true;
    const busy = await treeBusy(path, processes);
    if (!busy) return true;
    console.error(t('disk.clean.busy', { path, reason: busy }));
    process.exitCode = 1;
    return false;
  };
  let total = 0;
  const show = ({ target, bytes, removed, refused }) => {
    if (refused) {
      console.log(`${t('disk.clean.refused').padEnd(10)} ${target}: ${refused}`);
      return;
    }
    total += bytes;
    console.log(`${(removed ? t('disk.clean.removed') : t('disk.clean.to_remove')).padEnd(10)} ${readable(bytes).padStart(10)}  ${target}`);
  };
  for (const root of requestedRoots(argv, config)) {
    if (await free(root)) (await clean({ root, deep, apply })).forEach(show);
  }
  for (const build of requestedBuilds(argv, config)) {
    if (await free(build)) (await cleanBuild({ build, deep, apply })).forEach(show);
  }
  console.log(apply ? t('disk.clean.total_removed', { size: readable(total) }) : t('disk.clean.total_dry', { size: readable(total) }));
  if (!apply) console.log(t('disk.clean.hint'));
}

async function main(argv) {
  const [command = 'report', ...rest] = argv;
  const config = loadConfig();
  if (command === 'report') return reportCommand(rest, config);
  if (command === 'guard') return guardCommand(rest, config);
  if (command === 'clean') return cleanCommand(rest, config);
  console.error(t('disk.unknown', { command }));
  process.exitCode = 2;
  return undefined;
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) await main(process.argv.slice(2));
