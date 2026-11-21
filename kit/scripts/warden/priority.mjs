// CPU priority goes to the factory while its train runs.
//
// What compiles in the train's tree gets high priority; what compiles in another tree of the project, low priority;
// what cannot be tied to a tree does not move: nothing is ever penalised in doubt. When the train ends, each process
// it touched gets its priority back. Nothing is stopped or suspended.

import { constants, getPriority, setPriority } from 'node:os';

import { BUILD_TOOLS, inTree } from './disk.mjs';

const BUILD_BINARY = /[\\/]target[\\/].*[\\/](deps|debug|release|preview)[\\/][^\\/]+$/i;

// The project's trees: the main root and those carrying its name followed by a suffix (`project`, `project-e2`).
export function projectTrees(mainRoot) {
  const name = mainRoot.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop();
  return new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w-]*[\\\\/]`, 'i');
}

// Whose each build process is: 'train', 'other' or '' (unknown). By its own command line, otherwise by its descendants
// (cargo does not name its tree, its rustc do), otherwise by its ancestors.
export function classify(processes, root, others = projectTrees(root)) {
  const ofTrain = inTree(root);
  const kind = (text) => (!text ? '' : ofTrain(text) ? 'train' : others.test(text) ? 'other' : '');
  const byId = new Map(processes.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of processes) children.set(p.parent, [...(children.get(p.parent) ?? []), p.pid]);
  const result = new Map();
  for (const p of processes) {
    if (!BUILD_TOOLS.test(p.name) && !BUILD_BINARY.test(p.executable ?? '')) continue;
    let k = kind(`${p.line} ${p.executable ?? ''}`);
    const queue = [...(children.get(p.pid) ?? [])];
    for (let n = 0; !k && queue.length && n < 300; n += 1) {
      const id = queue.shift();
      k = kind(byId.get(id)?.line);
      queue.push(...(children.get(id) ?? []));
    }
    for (let id = p.parent, n = 0; !k && byId.has(id) && n < 12; n += 1) {
      k = kind(byId.get(id).line);
      id = byId.get(id).parent;
    }
    result.set(p.pid, k);
  }
  return result;
}

const WANTED = { train: constants.priority.PRIORITY_ABOVE_NORMAL, other: constants.priority.PRIORITY_LOW };

// One pass: sets the priority of each classified process, and keeps the previous priority to give it back.
export function adjust(processes, root, kept, { read = getPriority, set = setPriority, others } = {}) {
  for (const [pid, k] of classify(processes, root, others)) {
    const wanted = WANTED[k];
    if (wanted === undefined) continue;
    try {
      if (!kept.has(pid)) kept.set(pid, read(pid));
      if (read(pid) !== wanted) set(pid, wanted);
    } catch {
      // A process that ended between reading and setting: nothing to do.
    }
  }
}

// The train has ended: each process still alive gets its previous priority back.
export function restorePriorities(kept, { set = setPriority } = {}) {
  for (const [pid, before] of kept) {
    try {
      set(pid, before);
    } catch {
      // Already ended.
    }
  }
  kept.clear();
}
