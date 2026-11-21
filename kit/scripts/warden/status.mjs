#!/usr/bin/env node
// Where this tree stands, read rather than guessed: what an agent reads first when it joins the project, and what the
// factory reads before each shift. `--history` sums up the local history (history.mjs) instead.
//
//   node scripts/warden/status.mjs [--agent <name>] [--json]
//   node scripts/warden/status.mjs --history [--days N] [--json]
//
// The JSON keys are canonical English; the text follows the locale.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFactory, ROOT, stationSetting } from './config.mjs';
import { loadConfig } from './disk.mjs';
import { dockFolder, isRefused, readDock, readHalt, readTrain } from './dock.mjs';
import { historyPath, readHistory, summarize } from './history.mjs';
import { resolveLocale, t } from './messages.mjs';
import { holder } from './slot.mjs';
import { stationSlot } from './verify.mjs';

function git(args, root) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout.trim() : null;
}

const same = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase();

export function collectStatus({ root = ROOT, agent = null } = {}) {
  const factory = readFactory(root);
  const kit = existsSync(join(root, 'scripts', 'warden', 'kit.json')) ? JSON.parse(readFileSync(join(root, 'scripts', 'warden', 'kit.json'), 'utf8')) : null;
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const mainRoot = commonDir ? dirname(commonDir) : null;
  const factoryTree = stationSetting('factory', root);
  const slot = stationSlot(factory, root);
  const dock = slot ? dockFolder(slot, factory) : null;
  const deposits = dock ? readDock(dock) : [];
  const mine = agent ? deposits.filter((d) => d.name.replace(/\.txt$/, '') === agent || d.name.startsWith(`${agent}-`)) : [];
  return {
    kit: kit ? { name: kit.name, version: kit.version } : null,
    locale: resolveLocale(),
    hooks_active: git(['config', '--get', 'core.hooksPath'], root) === '.githooks',
    rules_source: existsSync(join(root, 'AGENTS.md')) ? 'AGENTS.md' : null,
    main_branch: factory.main_branch,
    remote: factory.remote,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    clean: git(['status', '--porcelain', '--untracked-files=no'], root) === '',
    tree: root,
    main_tree: same(mainRoot, root),
    role: factoryTree ? (same(factoryTree, root) ? 'factory' : 'agent') : 'unset',
    factory_tree: factoryTree,
    factory_fixes: factory.fixes,
    slot: slot ? { folder: slot, holder: holder(slot) } : null,
    // A halted train is every agent's business: a red main branch is repaired by a deposit like any other.
    dock: dock ? { folder: dock, ready: deposits.filter((d) => !isRefused(d)).map(brief), refused: deposits.filter(isRefused).map(brief), halt: readHalt(dock), train: readTrain(dock) } : null,
    mine: mine.map(brief),
    task_tool: stationSetting('tasks', root) ? 'set' : null,
    shared_build_cache: existsSync(join(root, 'Cargo.toml')) ? loadConfig(root).shared_caches.map((c) => c.path) : null,
  };
}

// `refusal`: the structured refusal while it holds; `refused`: its one-line summary.
const brief = (d) => {
  const holds = isRefused(d);
  return { name: d.name, branch: d.branch, tree: d.tree, commit: d.commit, tasks: d.tasks, refused: holds ? d.refused ?? d.refusal?.first_error ?? null : null, refusal: holds ? d.refusal : null };
};

export function formatStatus(s) {
  const yes = (v) => (v ? t('status.yes') : t('status.no'));
  const lines = [
    t('status.kit', { kit: s.kit ? `${s.kit.name} ${s.kit.version}` : t('status.none') }),
    t('status.hooks', { state: s.hooks_active ? t('status.active') : t('status.inactive') }),
    t('status.rules', { source: s.rules_source ?? t('status.none') }),
    t('status.role', { role: t(`status.role.${s.role}`) }),
    t('status.branch', { branch: s.branch, main: s.main_branch, clean: yes(s.clean) }),
    t('status.slot', { state: !s.slot ? t('status.none') : s.slot.holder ? t('status.held_by', { tree: s.slot.holder.tree, since: s.slot.holder.since }) : t('status.free') }),
    t('status.dock', { ready: s.dock?.ready.length ?? 0, refused: s.dock?.refused.length ?? 0 }),
  ];
  if (s.dock?.halt) lines.push(`! ${t('status.halt', { cls: s.dock.halt.class, since: s.dock.halt.at, cause: s.dock.halt.cause })}`);
  for (const d of s.mine) {
    const why = d.refusal ? t('status.refusal', { cls: d.refusal.class, next: d.refusal.next, cause: d.refused ?? d.refusal.first_error }) : d.refused ? t('status.refused', { cause: d.refused }) : '';
    lines.push(`  ${d.name}: ${d.branch}${why ? ` — ${why}` : ''}`);
  }
  lines.push(t('status.tasks', { state: s.task_tool ? t('status.set') : t('status.unset') }));
  if (s.shared_build_cache) lines.push(t('status.cache', { state: s.shared_build_cache.length ? s.shared_build_cache.join(', ') : t('status.unset') }));
  if (!s.hooks_active) lines.push(`! ${t('rules.hooks_inactive')}`);
  return lines;
}

export function formatHistory(h) {
  const pairs = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || t('status.none');
  return [
    t('history.title', { days: h.days }),
    t('history.trains', { trains: h.trains, integrations: h.integrations, per_day: pairs(h.integrations_per_day) }),
    t('history.delay', { median: h.dock_to_main_minutes.median ?? '-', max: h.dock_to_main_minutes.max ?? '-' }),
    t('history.refusals', { refusals: pairs(h.refusals), halts: pairs(h.halts), trials: h.trials_per_train ?? '-' }),
    t('history.cost', { seconds: h.verification_seconds_per_integration ?? '-', steps: h.costly_steps.map((s) => `${s.title} ${s.seconds} s`).join(', ') || t('status.none') }),
    t('history.pushes', { count: h.pushes.count, failed: pairs(h.pushes.failed), incomplete: h.pushes.incomplete, seconds: h.pushes.seconds_mean ?? '-' }),
    t('history.guards', { runs: h.guards.runs, cached: h.guards.kit_cached, seconds: h.guards.seconds_mean ?? '-' }),
    t('history.not_run', { steps: pairs(h.not_run) }),
    t('history.releases', { count: h.releases }),
  ];
}

function main(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  if (argv.includes('--history')) {
    const factory = readFactory();
    const summary = summarize(readHistory(historyPath(stationSlot(factory))), { days: Number(value('--days') ?? 7) });
    if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else for (const line of formatHistory(summary)) console.log(line);
    return;
  }
  const status = collectStatus({ agent: value('--agent') });
  if (argv.includes('--json')) console.log(JSON.stringify(status, null, 2));
  else for (const line of formatStatus(status)) console.log(line);
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) main(process.argv.slice(2));
