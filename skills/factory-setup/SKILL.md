---
name: factory-setup
description: Sets up the Warden factory on a workstation. It gives the factory its own tree, declares that tree, shares the push slot and the dock, and prepares the shared build cache, the CPU budget and the task tool. Use it once per workstation, or when the factory moves, when the user says "set up the factory", "make this session the factory" or "the factory needs its tree". French triggers include « prépare la fabrique » and « installe la fabrique ».
---

# Set up the factory

The factory is one long-lived session that runs the merge train and nothing else: it never writes product code. One factory at a time per workstation. Reply in the person's language.

Everything here is workstation configuration, outside the repository. Change nothing on the machine without the person's agreement, and say what you changed and how to undo it.

## 1. Its own tree

- A dedicated worktree of the project (`git worktree add <path> origin/<main branch> --detach`), or a separate clone. Never an agent's tree, never the person's working tree.
- It stays clean. The train checks out its own branch there (`train.branch` in `config/factory.json`) and comes back.

## 2. Declare it

```
git config warden.factory "<absolute path of the factory tree>"
```

- The setting is shared by every worktree of the clone.
- From then on, `train.mjs` refuses to run anywhere else.
- `status.mjs` shows each tree its role: `factory` there, `agent` everywhere else.
- A separate clone sets the same value in its own config.

## 3. One slot, one dock

- The work folder (`work_dir`, `.work` by default) at the main root holds the push slot and the dock (`train-ready/`). Every worktree of the clone finds them on its own.
- A separate clone points to the same slot: `git config warden.slot "<main root>/.work/push-slot"`. Agents and the factory must share one slot, or two pushes can race.

## 4. The shared build cache (Rust projects)

Every tree compiles the same registry dependencies. A cache shared by the whole workstation compiles each of them once. Warden measures it (`disk.mjs report` and `guard`) and never cleans it; installing it is a workstation step.

1. Read sccache's current documentation before choosing options: do not rely on memory.
2. Install it: `cargo install sccache --locked`.
3. Plug it in one place, the workstation Cargo configuration (`~/.cargo/config.toml`), never in the repository:
   - `[build] rustc-wrapper = "<path to sccache>"`;
   - `[env] SCCACHE_DIR = "<a folder on a disk with room>"` and `SCCACHE_CACHE_SIZE = "<ceiling, for example 20G>"`;
   - `SCCACHE_IGNORE_SERVER_IO_ERROR = "1"`, so that a cache server that does not answer means compiling without the cache, not failing.
4. Keep a copy of the file before the change, and write in it how to undo the change.
5. Measure: build a tree with an empty `target` without the cache, then again with the cache filled. Read the counters (`sccache --show-stats`).

The incremental cache stays per tree: sccache does not cache incremental builds.

## 5. The CPU budget

- Agent trees share half the machine: `[build] jobs = <half the cores>` in a Cargo configuration of the folder that holds them, outside any repository.
- The train takes every core for its own builds (`CARGO_BUILD_JOBS`) and the CPU priority while it runs (`priority.mjs`). Agent builds go to low priority; unknown processes do not move.

## 6. The task tool

If the person uses one: `git config warden.tasks <path or command>` (see `/warden:task`). The train then notes each task it takes up or sets aside.

## 7. Prove it

- In the factory tree, `node scripts/warden/status.mjs` shows `Role: factory`. In an agent tree, it shows `Role: agent`.
- `node scripts/warden/train.mjs run --dry-run` stacks the docked branches and pushes nothing.
- `node scripts/warden/disk.mjs report` shows the shared cache and its ceiling.

Then start the factory itself: `claude --agent warden:factory` in the factory tree.
