// The local history: one JSON line per push, guard run, train and release, in the work folder next to the dock, never
// committed. It answers how much goes up, how much is refused and why, and what the verifications cost; decisions on
// the workflow are taken on it rather than on impressions.
//
//   {"kind":"push","at":…,"tree":…,"commit":…,"result":"pass|fail|incomplete|already","class":…,"steps":[…],"not_run":[…],"seconds":…}
//   {"kind":"guards","at":…,"tree":…,"kit":"ran|cached","ok":…,"seconds":…}
//   {"kind":"train","at":…,"base":…,"batch":[…],"trials":…,"steps":{title:seconds},"up":[…],"out":[…],"waiting":…,"halted":…,"not_run":[…],"seconds":…}
//   {"kind":"release","at":…,"commit":…,"artifacts":[…],"signed":…}

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HISTORY = 'warden-history.jsonl';
export const historyPath = (slot) => (slot ? join(dirname(slot), HISTORY) : null);
const DAY = 24 * 3600 * 1000;

export function readHistory(file) {
  if (!file || !existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      if (line.trim()) entries.push(JSON.parse(line));
    } catch {
      // A line cut by an interruption: the others still count.
    }
  }
  return entries;
}

// One line added. Past 512 KiB, the lines older than `keepDays` go: the file stays small without a cleanup gesture.
export function appendHistory(file, entry, { keepDays = 90, now = Date.now() } = {}) {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`);
    if (statSync(file).size > 512 * 1024) {
      const kept = readHistory(file).filter((e) => now - Date.parse(e.at) <= keepDays * DAY);
      writeFileSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''));
    }
  } catch {
    // The history measures; it never stops a push or a train.
  }
}

const count = (list, key) => list.reduce((acc, item) => {
  const k = key(item);
  if (k !== null && k !== undefined) acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
const mean = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
const median = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// What the last `days` say.
export function summarize(entries, { days = 7, now = Date.now() } = {}) {
  const recent = entries.filter((e) => now - Date.parse(e.at) <= days * DAY);
  const of = (kind) => recent.filter((e) => e.kind === kind);
  const trains = of('train');
  const pushes = of('push');
  const guards = of('guards');
  const up = trains.flatMap((e) => (e.up ?? []).map((u) => ({ ...u, at: e.at })));
  const steps = {};
  for (const e of trains) {
    for (const [title, seconds] of Object.entries(e.steps ?? {})) {
      steps[title] ??= { title, seconds: 0, runs: 0 };
      steps[title].seconds += seconds;
      steps[title].runs += 1;
    }
  }
  const trainSeconds = trains.reduce((a, e) => a + (e.seconds ?? 0), 0);
  return {
    days,
    trains: trains.length,
    integrations: up.length,
    integrations_per_day: count(up, (u) => u.at.slice(0, 10)),
    dock_to_main_minutes: { median: median(up.map((u) => u.waited_s / 60).filter(Number.isFinite)), max: up.length ? Math.max(...up.map((u) => u.waited_s / 60).filter(Number.isFinite)) : null },
    refusals: count(trains.flatMap((e) => e.out ?? []), (o) => o.class),
    halts: count(trains, (e) => e.halted ?? null),
    trials_per_train: mean(trains.map((e) => e.trials ?? 0)),
    verification_seconds_per_integration: up.length ? Math.round(trainSeconds / up.length) : null,
    costly_steps: Object.values(steps).sort((a, b) => b.seconds - a.seconds).slice(0, 5).map((s) => ({ ...s, seconds: Math.round(s.seconds) })),
    pushes: { count: pushes.length, failed: count(pushes.filter((p) => p.result === 'fail'), (p) => p.class ?? 'defect'), incomplete: pushes.filter((p) => p.result === 'incomplete').length, seconds_mean: mean(pushes.map((p) => p.seconds ?? 0)) },
    guards: { runs: guards.length, kit_cached: guards.filter((g) => g.kit === 'cached').length, seconds_mean: mean(guards.map((g) => g.seconds ?? 0)) },
    not_run: count([...trains, ...pushes].flatMap((e) => e.not_run ?? []), (n) => n),
    releases: of('release').length,
  };
}
