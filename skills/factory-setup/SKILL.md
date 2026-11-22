---
name: factory-setup
description: Sets up the Warden factory on a workstation. It gives the factory its own tree, declares that tree, shares the push slot and the dock, prepares the shared build cache, the CPU and memory budget and the task tool, sizes the default budgets, and sets what the factory may commit itself. Use it once per workstation, or when the factory moves, when the user says "set up the factory", "make this session the factory" or "the factory needs its tree". French triggers include « prépare la fabrique » and « installe la fabrique ».
---

# Set up the factory

The factory is one long-lived session that runs the merge train and nothing else: it never writes product code. One factory at a time per workstation. Reply in the person's language.

Everything here is workstation configuration, outside the repository, except the budgets and the fixes policy of `config/`, which the project commits. Change nothing on the machine without the person's agreement, and say what you changed and how to undo it.

## 1. Its own tree

- A dedicated worktree of the project (`git worktree add <path> origin/<main branch> --detach`), or a separate clone. Never an agent's tree, never the person's working tree.
- It stays clean. The train checks out its own branch there (`train.branch` in `config/factory.json`) and comes back to where it left from: the same branch, or the same commit when the tree is detached.

## 2. Declare it

```
git config warden.factory "<absolute path of the factory tree>"
```

- The setting is shared by every worktree of the clone.
- From then on, `train.mjs` refuses to run anywhere else.
- `status.mjs` shows each tree its role: `factory` there, `agent` everywhere else.
- A separate clone sets the same value in its own config.

## 3. One slot, one dock

- The work folder (`work_dir`, `.work` by default) at the main root holds the push slot, the dock (`train-ready/`) and the train logs (`train-logs/`). Every worktree of the clone finds them on its own.
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

The incremental cache stays per tree: sccache does not cache incremental builds. The train turns incremental compilation off for its own builds.

A C or C++ dependency whose build carries its own compiler cache can fail under sccache: whisper.cpp with its `GGML_CCACHE` option gave `C1041` under MSVC. Turn that inner cache off for such a dependency, as its build documentation says.

## 5. The CPU and memory budget

- Agent trees share half the machine: `[build] jobs = <half the cores>` in a Cargo configuration of the folder that holds them, outside any repository.
- The train takes every core for its own builds (`CARGO_BUILD_JOBS`), bounded by the memory free to commit, and the CPU priority while it runs (`priority.mjs`). Agent builds go to low priority; unknown processes do not move.
- The train knows the worktrees of the clone. Agent trees elsewhere, a separate clone for instance, are declared so that their builds go to low priority too: `git config --add warden.agentTrees "<folder>"`.

## 6. Size the budgets

The default values come from one workstation. They are starting values: measure yours and set them with the person.

| Budget | Default | Where |
|---|---|---|
| Free disk | 60 GiB | `config/disk.json`, `min_free_gib` |
| Build of a tree | 40 GiB | `max_build_gib` |
| Incremental caches | 6 GiB | `max_incremental_gib` |
| Agent worktrees | 2 | `max_worktrees` (the factory tree never counts) |
| Worktree age | 7 days | `max_worktree_age_days` |
| Batch | 4 branches | `config/factory.json`, `train.max_batch` |
| Memory free to commit before a train | 8 GiB | `train.min_free_memory_gib` |
| Memory per build job | 2 GiB | `train.memory_per_job_gib` |

The disk budgets of one workstation go in `config/disk.local.json`, never committed. A slot held for more than 50 minutes counts as abandoned; this delay is fixed.

## 7. What the factory may commit

`fixes` in `config/factory.json` lists what the factory may commit itself, on its own branch taken with `--with`. Everything else goes back to the author.

- `version`: the version number of a release;
- `lock`: a lockfile regenerated by its own tool, with no manifest change;
- `generated`: files a generator writes, never edited by hand;
- `lint`: mechanical lint fixes.

The default is `["version", "lock", "generated"]`. Adding `lint`, or emptying the list, is the project's decision: ask the person.

## 8. The task tool

If the person uses one: `git config warden.tasks <path or command>` (see `/warden:task`). The train then notes each task it takes up or sets aside.

## 9. Prove it

- In the factory tree, `node scripts/warden/status.mjs` shows `Role: factory`. In an agent tree, it shows `Role: agent`.
- `node scripts/warden/train.mjs run --dry-run` stacks the docked branches and pushes nothing.
- `node scripts/warden/disk.mjs report` shows the shared cache and its ceiling.

Then start the factory itself: `claude --agent warden:factory` in the factory tree. In Codex, which has no plugin agents, open a session in the factory tree and have it follow the profile `<this skill folder>/../../agents/factory.md` and the `warden:factory-shift` skill.
