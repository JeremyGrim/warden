# Changelog

## 0.3.0 - 2026-11-21

The factory, after a review by a factory that runs a real train.

### Fixed

- A red main branch no longer refuses the whole dock.
  - The advisories run on the main branch alone before each batch.
  - When every branch fails, the main branch alone goes through the same checks.
  - If it fails, the train stops and refuses nobody.
- Scenarios are played on a build of the pushed commit, in a separate tree, never in the train tree: its build is the last trial's.
- The rules read the Rust workspace with `--locked` only. A lockfile behind the manifests is a named finding, never rewritten.
- A refused deposit names the failed step, its first error and the train log.
- A deposit that cannot be read (no common history, a tree gone) is set aside alone; the train goes on.
- The `--with` branch is always taken, outside the batch count.
- A branch that only conflicts with another branch of the batch waits instead of being refused.
- The build priority recognises a tree by its whole path, never by a bare name: the worktrees of the clone, and the declared agent trees.
- An abandoned slot is renamed aside, then taken by `mkdir`: two hooks cannot both take it.
- A detached factory tree comes back to the commit it left from.
- A deposit docked on 31 December stays first on 1 January.
- The factory tree no longer counts in the worktree budget.

### Added

- `train.mjs recover`, for a tree left by an interrupted train. A train refuses to leave after an interrupted one.
- `commit =` in a deposit: the train takes exactly that commit, and says when the branch moved on.
- `priority =` in a deposit, set on the person's word.
- `taken/` keeps the deposits that went up; `train-logs/` keeps the log of each train.
- The memory budget of the train:
  - a check before it leaves (`train.min_free_memory_gib`);
  - build jobs bounded by memory (`train.memory_per_job_gib`);
  - incremental compilation off in the train.
- `fixes` in `config/factory.json`: what the factory may commit itself.
- Three more limits to the factory's authority:
  - a relayed message is never the person's agreement;
  - nothing is published without the person's word;
  - no process of the person or of another agent is stopped.
- `verify.mjs files` and `verify.mjs advisories`, used by the train.
- `git config warden.agentTrees`, for agent trees outside the clone's worktrees.
- The budgets to size, in `factory-setup`.

## 0.2.0 - 2026-11-21

### Changed

- English is canonical: commands, options, configuration keys, rule identifiers, file names and JSON output.
  - The kit moves to `scripts/warden/`.
  - The configuration files are `config/rules.json`, `config/factory.json` and `config/disk.json`.
  - Workstation settings are `git config warden.*`.
  - The work folder is `.work/`, and the dock is `.work/train-ready/`.
- Display text is English or French. It is resolved from `WARDEN_LOCALE`, `git config warden.locale`, then the system locale. The installer writes `AGENTS.md` and `CLAUDE.md` in that locale.
- Every skill and all documentation are in English. The skills accept English and French triggers.
- The `machine path` pattern admits the fictitious person's own folder (`C:\Users\person`), and still refuses neighbouring names such as `person2` or `person.x`.

### Added

- The factory as a fixed agent, `warden:factory`, with its own skills: `factory-setup`, `factory-shift` and `factory-health`.
- `git config warden.factory` declares the factory tree. The train refuses to run anywhere else.
- `/warden:onboard`, the launch skill for every agent session, backed by `scripts/warden/status.mjs`. It reports the kit, hooks, role, branch, slot, dock, the agent's own deposits, the task tool and the shared build cache.
- The [Build cache](docs/build-cache.md) guide: the shared compiler cache, the CPU budget, and what the kit measures.
- The session hook reminds a new session to onboard.

## 0.1.0 - 2026-11-20

### Added

- The kit:
  - the rules, the Rust and Node boundaries, the push verification, the push slot;
  - the dock and the merge train, the disk guard, the train's CPU priority, and npm advisories compared on the workstation.
- The rules also cover the component registry, debts that only shrink, and chokepoints.
- The installer, with its fingerprint manifest. It refuses to overwrite an edited kit script.
- The Claude Code plugin, with five skills and one session hook.
- The end-to-end trial on blank Rust + Node and Node-only projects.

### Fixed

These issues were found while proving the kit:

- a `node --test` step no longer inherits a parent runner's context;
- machine paths with doubled separators are refused;
- the hooks stay LF on Windows clones.
