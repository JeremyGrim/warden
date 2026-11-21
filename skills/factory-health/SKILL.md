---
name: factory-health
description: Keeps the factory workstation healthy in a project ruled by Warden. It watches the disk budgets, the shared build cache, the push slot, stale or refused deposits and extra worktrees, and proposes cleanups without applying them. Use it between trains, when a guard alerts, or when the user asks "is the factory healthy", "disk space" or "what is stuck". French triggers include « santé de la fabrique », « place disque » and « qu'est-ce qui bloque ».
---

# Factory health

Look, measure, propose. Every removal is the person's gesture. Reply in the person's language.

## Disk

- `node scripts/warden/disk.mjs report` shows, for each tree:
  - the free space;
  - the build and its incremental share;
  - `node_modules`;
  - the Git history;
  - the worktrees;
  - the shared build cache and its ceiling.
- `node scripts/warden/disk.mjs guard` fails when a budget of `config/disk.json` is exceeded (local overrides in `config/disk.local.json`).
- `node scripts/warden/disk.mjs clean` lists what regenerates quickly, as a dry run. `--deep` adds `target` and `node_modules`. `--apply` removes, **only on the person's word**. It never follows a link, never leaves the root, and refuses a tree where a build is running.
- A `target` shared between two trees (a link, or `CARGO_TARGET_DIR` outside the tree) is an alert: Cargo can report success without compiling that tree.

## Push slot

- `status.mjs` shows who holds it and since when.
- A slot held for more than 50 minutes is taken back by the next hook, and logged when `slot.log` is set.
- Never delete the slot folder by hand while a push may be running.

## Dock

- **Deposits refused a long time ago**: remind the author through a task note.
- **Deposits whose tree no longer exists**: the train sets them aside with "branch not found". Report them to the person.
- More than two pending deposits for one agent breaks the rule: tell that agent.

## Worktrees

- The disk report says which worktrees are clean and fully pushed, and so removable, and which still hold work.
- Removing one is the person's gesture, never the factory's.

## Report

Say only what needs attention, one line each, then the proposed action and who must take it.
