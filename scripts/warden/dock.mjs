// The dock: the deposits waiting for the train, their refusals, and the halt the train waits on. Plain files next to the
// push slot, read by the train, by status.mjs and by any agent.
//
//   <session>.txt            a deposit, written by its author
//   <session>.refusal.json   why the train set it aside, written by the train; it holds while the deposit names the
//                            refused commit
//   _halt.json               why the train halted without blaming anyone, and what it waits for
//   taken/                   the deposits that went up

import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const HALT = '_halt.json';
// The train under way: its batch, its trial, its step, rewritten at each step and removed at its end. A file left by a
// train whose process is gone says an interrupted train, which the next one recovers.
export const TRAIN = '_train.json';
export const dockFolder = (slot, factory) => join(dirname(slot), factory.train.dock);
export const refusalPath = (dock, name) => join(dock, name.replace(/\.txt$/, '.refusal.json'));

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// A deposit: `key = value` lines. The docking moment `dd/mm hh:mm` takes the year that puts it closest to now (a deposit
// of 31 December read on 1 January stays first); with no moment, the file date.
export function readDeposit(name, text, fileDate = 0, now = Date.now()) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const found = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (found) fields[found[1].toLowerCase()] = found[2];
  }
  const when = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(fields.docked ?? '');
  let moment = fileDate;
  if (when) {
    const year = new Date(now).getFullYear();
    const at = (y) => new Date(y, Number(when[2]) - 1, Number(when[1]), Number(when[3]), Number(when[4])).getTime();
    moment = [year - 1, year, year + 1].map(at).reduce((best, m) => (Math.abs(m - now) < Math.abs(best - now) ? m : best));
  }
  return {
    name,
    tree: fields.tree,
    branch: fields.branch,
    commit: fields.commit || null,
    tasks: (fields.tasks ?? '').split(/[,\s]+/).filter(Boolean),
    scenarios: (fields.scenario ?? '').split(/[,\s]+/).filter(Boolean),
    priority: /^-?\d+$/.test(fields.priority ?? '') ? Number(fields.priority) : null,
    refused: fields.refused ?? null,
    refusal: null,
    moment,
  };
}

// Two names of one commit: a full hash and its abbreviation.
export const sameCommit = (a, b) => Boolean(a && b) && Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));

// A refusal holds while the deposit still names the refused commit: docking a new commit is enough to leave again, with
// no line to erase, and docking the same commit again leaves it refused. A `refused` line with no refusal file (written
// before 0.4.0) holds until it is removed.
export function isRefused(deposit) {
  if (deposit.refusal) return !deposit.commit || sameCommit(deposit.refusal.commit, deposit.commit);
  return Boolean(deposit.refused);
}

// The deposits that leave: complete, not refused. A deposit with a `priority` leaves first, the lowest number first
// (the person's order of value); then arrival order.
export function readyDeposits(deposits) {
  const rank = (d) => d.priority ?? Number.POSITIVE_INFINITY;
  return deposits.filter((d) => d.tree && d.branch && !isRefused(d))
    .sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) - rank(b)) || a.moment - b.moment || a.name.localeCompare(b.name));
}

// The dock as it is: every deposit, with its refusal when it has one. Deposits that went up live in `taken/`.
export function readDock(dock) {
  const files = existsSync(dock) ? readdirSync(dock).filter((f) => f.endsWith('.txt')) : [];
  return files.map((f) => ({
    ...readDeposit(f, readFileSync(join(dock, f), 'utf8'), statSync(join(dock, f)).mtimeMs),
    refusal: readJsonFile(refusalPath(dock, f)),
  }));
}

// The train sets a deposit aside: the refusal file, and the `refused` line for whoever reads the deposit alone.
export function writeRefusal(dock, name, record, line) {
  writeFileSync(refusalPath(dock, name), `${JSON.stringify(record, null, 2)}\n`);
  appendFileSync(join(dock, name), `\nrefused = ${line}\n`);
}

export function clearRefusal(dock, name) {
  rmSync(refusalPath(dock, name), { force: true });
}

// The dock as a halt saw it: each ready deposit with its commit. A new deposit, or a new commit, is a change.
export const dockKey = (deposits) => deposits.map((d) => `${d.name}@${d.commit ?? ''}`).sort().join(',');

export const readHalt = (dock) => readJsonFile(join(dock, HALT));
export const writeTrain = (dock, train) => writeFileSync(join(dock, TRAIN), `${JSON.stringify(train, null, 2)}\n`);
export const clearTrain = (dock) => rmSync(join(dock, TRAIN), { force: true });

// The train under way as the status gives it, with whether its process still lives.
export function readTrain(dock) {
  const train = readJsonFile(join(dock, TRAIN));
  if (!train) return null;
  let alive = false;
  try {
    process.kill(train.pid, 0);
    alive = true;
  } catch (error) {
    alive = error.code === 'EPERM';
  }
  return { ...train, alive };
}
export const writeHalt = (dock, halt) => writeFileSync(join(dock, HALT), `${JSON.stringify(halt, null, 2)}\n`);
export const clearHalt = (dock) => rmSync(join(dock, HALT), { force: true });

// A red main branch changes only with a new commit of the main branch or a change in the dock: the repair is a deposit
// like any other. Until then a train would replay the same failure, so it does not leave.
export const haltHolds = (halt, { main, dock }) => Boolean(halt) && halt.class === 'baseline' && halt.main === main && halt.dock === dock;

// The halt a train writes. The same halt again (same class, reason and step) keeps the moment it began and whether it
// was said: an incident retried every `retry_minutes` would otherwise start over each time, never reach its notice
// threshold, and never be said (21 November). `last` is the latest train that met it.
export function continuedHalt(previous, halt, now = new Date().toISOString()) {
  const same = Boolean(previous) && ['class', 'reason', 'step'].every((key) => (previous[key] ?? null) === (halt[key] ?? null));
  return { ...halt, at: same ? previous.at : now, last: now, noticed: same && Boolean(previous.noticed) };
}

// What `watch` does while the train is halted: `go` when a train is worth leaving, `notice` once the halt outlived its
// notice threshold since it began (said once), `wait` otherwise.
//   baseline                 a new commit of the main branch, or a change in the dock
//   memory                   the memory free to commit is back above the train's minimum
//   any other incident       `retry_minutes` passed since the latest train, or a change in the dock
export function whileHalted(halt, { main, dock, freeGib = null, now = Date.now(), train }) {
  if (!halt) return 'go';
  const since = (moment) => (now - Date.parse(moment)) / 60000;
  let go;
  if (halt.class === 'baseline') go = halt.main !== main || halt.dock !== dock;
  else if (halt.reason === 'memory') go = freeGib === null || freeGib >= train.min_free_memory_gib;
  else go = since(halt.last ?? halt.at) >= train.retry_minutes || halt.dock !== dock;
  if (go) return 'go';
  return !halt.noticed && since(halt.at) >= train.halt_notice_minutes ? 'notice' : 'wait';
}
