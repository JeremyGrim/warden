// The push slot to the main branch: one push at a time on the workstation, taken by the hook itself. The lock is a
// folder (`mkdir` fails when it exists), shared by every worktree of the workstation; `held-by.txt` says which tree
// holds it, for which commit, since when. Its name and log come from config/factory.json.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { t } from './messages.mjs';

export const ABANDONED_MS = 50 * 60 * 1000;
// A `mkdir` attempt costs nothing: a waiting hook polls often, or a slot taken by hand always gets in first (seen on
// 11 November, twice in a row, at 30 s).
export const STEP_MS = 5 * 1000;
const HOLDER = 'held-by.txt';

// Where the slot lives: set for this clone (`git config warden.slot <folder>`), otherwise in the work folder of the
// root this tree belongs to (the root itself, or a tree linked to it). A separate clone with no setting has none.
export function slotFolder({ configured, commonGitDir, name = 'push-slot', workDir = '.work' }) {
  if (configured) return configured;
  if (!commonGitDir) return null;
  const work = join(dirname(commonGitDir), workDir);
  return existsSync(work) ? join(work, name) : null;
}

function read(folder) {
  try {
    return readFileSync(join(folder, HOLDER), 'utf8');
  } catch {
    return '';
  }
}

function since(folder) {
  const written = /^since: (.+)$/m.exec(read(folder))?.[1];
  const date = written ? Date.parse(written) : NaN;
  if (!Number.isNaN(date)) return date;
  try {
    return statSync(folder).mtimeMs;
  } catch {
    return 0;
  }
}

const heldByThisTree = (folder, tree) => read(folder).split(/\r?\n/).includes(`tree: ${tree}`);

function write(folder, { tree, commit, now }) {
  writeFileSync(join(folder, HOLDER), `push hook\ntree: ${tree}\ncommit: ${commit}\nsince: ${new Date(now).toISOString()}\n`);
}

// Takes the slot, waiting for it to free up. A slot of this tree is taken back (an interrupted hook); a slot held for
// more than 50 minutes is abandoned, taken back, and the takeover is written to the log when there is one
// (`slot.log`, a file next to the slot).
export async function take({ folder, tree, commit, now = () => Date.now(), sleep, maxWait = ABANDONED_MS, step = STEP_MS, say = () => {}, log = null }) {
  const start = now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(folder);
      write(folder, { tree, commit, now: now() });
      return { taken: true };
    } catch (error) {
      if (error.code !== 'EEXIST') return { taken: false, reason: t('slot.cannot_take', { code: error.code }) };
    }
    const holder = read(folder).trim().replace(/\s*\n\s*/g, ' ; ') || t('slot.no_holder');
    if (heldByThisTree(folder, tree)) {
      write(folder, { tree, commit, now: now() });
      return { taken: true, takenBack: holder };
    }
    if (now() - since(folder) > ABANDONED_MS) {
      if (log && existsSync(log)) appendFileSync(log, `\n- ${new Date(now()).toISOString()} — ${t('slot.log_takeover', { tree, holder })}\n`);
      write(folder, { tree, commit, now: now() });
      return { taken: true, takenBack: holder };
    }
    if (now() - start >= maxWait) return { taken: false, reason: t('slot.held', { holder }) };
    if (!announced) {
      say(t('slot.waiting', { holder, seconds: Math.round(step / 1000) }));
      announced = true;
    }
    await sleep(step);
  }
}

// The holder refreshes its time during a long verification: otherwise, past 50 minutes, another hook would think it
// abandoned and take it in the middle of the work.
export function refresh(folder, tree, now = Date.now()) {
  if (!heldByThisTree(folder, tree)) return false;
  writeFileSync(join(folder, HOLDER), read(folder).replace(/^since: .*$/m, `since: ${new Date(now).toISOString()}`));
  return true;
}

// Gives the slot back, only when it belongs to this tree.
export function release(folder, tree) {
  if (existsSync(folder) && heldByThisTree(folder, tree)) rmSync(folder, { recursive: true, force: true });
}

// The hook ends before Git sends: the slot is given back when the main branch carries the pushed commit, or after the
// delay when the push failed after the hook.
export async function releaseOnArrival({ folder, tree, commit, remoteHead, sleep, now = () => Date.now(), delay = 180 * 1000, step = 2 * 1000 }) {
  const start = now();
  while (now() - start < delay) {
    if (remoteHead() === commit) break;
    await sleep(step);
  }
  release(folder, tree);
}

// Who holds the slot now, for a status report: null when it is free.
export function holder(folder) {
  if (!folder || !existsSync(folder)) return null;
  const text = read(folder);
  return { tree: /^tree: (.+)$/m.exec(text)?.[1] ?? null, commit: /^commit: (.+)$/m.exec(text)?.[1] ?? null, since: new Date(since(folder)).toISOString() };
}
