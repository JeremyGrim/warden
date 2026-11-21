# Build Cache and CPU Budget

Several agent trees and the factory compile the same project on one workstation. Without care, each tree compiles every registry dependency on its own, and the builds fight over the CPU. Warden splits this in two:

- the **workstation** shares a build cache and bounds the agents;
- the **kit** measures the cache and gives the CPU to the train.

## The shared build cache

A compiler cache shared by every tree (sccache) compiles each registry dependency once for the whole workstation.

It is a workstation setting, outside every repository. A repository never depends on it: without it, Cargo compiles as before. The `/warden:factory-setup` skill sets it up with the person's agreement:

1. Read sccache's current documentation before choosing options.
2. `cargo install sccache --locked`.
3. In the workstation Cargo configuration (`~/.cargo/config.toml`):

   ```toml
   [build]
   rustc-wrapper = "<path to sccache>"

   [env]
   SCCACHE_DIR = "<a folder on a disk with room>"
   SCCACHE_CACHE_SIZE = "20G"
   # A cache server that does not answer means compiling without the cache, not failing.
   SCCACHE_IGNORE_SERVER_IO_ERROR = "1"
   ```

4. Keep a copy of the file before the change, and note how to undo it.
5. Measure a build from an empty `target` without, then with, the cache filled, and read `sccache --show-stats`.

The incremental cache stays per tree: sccache does not cache incremental builds.

A C or C++ dependency whose build carries its own compiler cache can fail under sccache: whisper.cpp with its `GGML_CCACHE` option gave `C1041` under MSVC. Turn that inner cache off for such a dependency, as its build documentation says.

## What the kit does with it

- `disk.mjs` finds the cache in the workstation Cargo configuration (`SCCACHE_DIR`, `SCCACHE_CACHE_SIZE`), or in `config/disk.local.json` (`shared_caches`, with `path` and `max_gib`).
- `report` shows its size, its ceiling and the free space on its disk.
- `guard` alerts when it goes over its ceiling, or when its disk runs low.
- `clean` never touches it: it bounds itself.
- A build served by the cache launches no `rustc`. `disk.mjs` counts `sccache` as a build tool, so that a tree compiling through the cache is still seen as busy.

## Never share a `target`

Two trees on the same `target`, through a link or through `CARGO_TARGET_DIR`, think each other up to date: Cargo compares dates, and a tree can turn green without its code being compiled. `disk.mjs guard` reports it. The shared cache is the right way to share work between trees.

## The CPU budget

- **Agents** share half the machine. A Cargo configuration in the folder that holds the agent trees, outside any repository, sets `[build] jobs = <half the cores>`.
- **The train** takes every core for its builds (`CARGO_BUILD_JOBS`), bounded by the memory free to commit: `train.memory_per_job_gib` per job, 2 GiB by default. A build that runs out of memory to commit fails (`os error 1455` on Windows). Below `train.min_free_memory_gib`, 8 GiB by default, the train does not leave and says so. It never stops a process to free memory.
- **Incremental compilation is off in the train** (`CARGO_INCREMENTAL=0`). The train compiles once per trial, like a continuous integration: the incremental cache serves it nothing, grew to 50 GiB in one factory tree, and keeps sccache from caching the workspace crates.
- **The priority**: while the train runs, `priority.mjs`:
  - raises the builds of its tree to high priority;
  - lowers the builds of the other trees of the project: the worktrees of the clone, and the folders declared with `git config --add warden.agentTrees <folder>`;
  - leaves alone what it cannot tie to a tree.

  A tree is recognised by its whole path in a command line, never by a bare folder name. When the train ends, every process gets its previous priority back. Nothing is stopped or suspended.
