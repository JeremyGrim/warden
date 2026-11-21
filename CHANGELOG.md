# Changelog

## 0.4.3 - 2026-11-21

### Added

- **The interface** (`ui.mjs`, `ui.html`, `ui.css`, `ui-*.mjs`): a local page for the person, served by the kit, covering every project of the workstation (`git config --global warden.projects`), each read by its own kit. It shows what waits for the person and nothing else, the train under way or its halt, the dock, the history and its measures, the disk, the kit, the version, the releases and the configuration. It runs only the gestures that bypass nothing: a dry run, the factory's own cleanup, reading the version, a release, turning the hooks on, the workstation settings, and marks kept in the clone's Git folder. It listens on 127.0.0.1 only, behind the token of its address, and loads nothing from outside. See `docs/interface.md`.
- **`npx github:JeremyGrim/warden setup|install|ui`** (`tools/cli.mjs`): the kit installed, or the interface opened, without the Claude Code plugin and without publishing anything.
- `disk.mjs report --json [--quick]`: the disk measures, the trees, the alerts and the memory free to commit, for the interface.
- The train under way in `.work/train-ready/_train.json`, given by `status.mjs` (`dock.train`, with whether its process lives).
- Each train line of the history says how it ended (`outcome`: `done`, `halted`, `stopped`), which branches wait for a neighbour (`pending`), and its log.

## 0.4.2 - 2026-11-21

### Fixed

- **A halt that persists is said.** Each train that met an incident wrote the halt anew, with a new `at` and `noticed: false`. Retried every `train.retry_minutes` (10), a `transient` or `incomplete` halt never reached `train.halt_notice_minutes` (30): a missing tool was never said, and the halt's `at` gave its latest train, not its beginning. The same halt again (same class, reason and step) now keeps when it began and whether it was said; `last` gives the latest train that met it, and the retry counts from it.

## 0.4.1 - 2026-11-21

Versions now move within the 0.4 line.

### Added

- **The factory's version bump** (`version.mjs`): `show` gives the version of every manifest, its line and the next one; `bump` writes the next patch in every manifest at once, refreshes the workspace entries of `Cargo.lock` offline and a `package-lock.json`, and commits it on the factory's branch `warden/version-x.y.z`, for the train to take with `--with`. It works in a tree of its own. The line is `version.line` in `config/factory.json`, by default the current major.minor; leaving it is the person's decision. The manifests are `version.files`, else `versions` of the rules, else `package.json`, `Cargo.toml` and `.claude-plugin/plugin.json`.
- A release is labelled by default with the version its commit carries (`v0.4.1`).

### Fixed

- The README badge said 0.3.0, and its merge train section still described the refused line and a train that stops.
- `docs/skills.md` counted eleven skills; there are ten.
- `docs/merge-train.md` said a batch of four costs at most two extra trials: it takes two to four, depending on where the culprit stands.

## 0.4.0 - 2026-11-21

Less coordination: an agent produces, submits, fixes and gets its work integrated without a person relaying anything, whenever the rules and the results say what comes next.

### Added

- **A class for every failure**: `violation`, `defect`, `conflict`, `transient`, `incomplete`, `baseline` (`outcome.mjs`). The class decides what follows.
- **Workstation incidents** (os error 1455, LNK1102, a file held, a full disk, the network, a killed process) are replayed once, at push and in the train. An incident that survives its replay is judged on the main branch alone: the branch is refused only when the main branch passes. A project adds its own patterns with `verify.transient_patterns`.
- **"Not run" is never "passed"**: a check that could not run (a tool absent, no advisory database) is said and recorded. `verify.when_missing`: `record` (default) lets the commit go and names what was not verified in its notes; `block` makes the push and the train wait. `verify.mjs files`, `advisories` and `all` exit with 3 in that case.
- **Structured refusals**: `<session>.refusal.json` next to a deposit set aside: class, step, rule, paths, first error, log, refused commit, base, train, and `next` (`fix_and_redock`, `rebase_and_redock`). `status.mjs --json` gives it in `mine[].refusal`.
- **Return on a new commit**: a refused deposit leaves again once it names another commit. No line to erase; the same commit docked again stays refused.
- **Halts that blame nobody** (`_halt.json`, exit code 75), seen by every agent in its status:
  - a red main branch halts the train until the main branch moves or the dock changes; the repair is a deposit like any other, and the train does not leave for nothing meanwhile;
  - low memory halts it until the memory is back;
  - an incident, or a blocked check that could not run, halts it for `train.retry_minutes`.
- **`watch`** waits for what can lift a halt, and says it once past `train.halt_notice_minutes`, with exit code 75.
- **A dead interrupted train is recovered** by the next train; `recover` stays for the hand.
- **`guards.mjs`**: the project's script tests and the kit fingerprint run on every push and trial; the kit's own tests only when a kit file, Node, Git or the platform changed since they last passed in the clone. Measured on the trial: about 22 s to 0.1 s per push.
- **`disk.mjs clean --own`**: the factory cleans what regenerates in its own tree without asking anyone. It refuses in any other tree.
- **The local history** (`.work/warden-history.jsonl`, `history.keep_days`) and `status.mjs --history [--days N]`: integrations per day, delay from the dock to the main branch, refusals by class, halts, trials per train, verification cost per integration, costliest steps, pushes, guards spared, what was not run.
- **The release** (`release.mjs build --commit <sha>`, skill `release`): a commit of the main branch built in `.work/release-tree`, never the train tree; `SHA256SUMS`, `release.json`; optional signature and its check, whose output is written nowhere. Publishing stays the person's decision.
- **Apache License 2.0.**

### Changed

- When the advisories fail on the main branch alone, each trial checks them first instead of stopping the train: only a batch that repairs them goes up.
- The rules model no longer carries the `docs` doctrine nor forbids `.claude`, `.codex` and `.agents`: they belonged to the repository Warden comes from. `docs/configuration.md` gives the `docs` section to add back.
- A train set aside by the memory, a red main branch or an incident now exits with 75 instead of 1.

### Migration

- No configuration key is required. A project's `config/` is kept as is by the installer.
- The pre-push hook: the installer replaces a hook left exactly as kits up to 0.3.0 wrote it. A hook the project changed is kept: replace its `node --test "scripts/**/*.test.mjs" || exit 1` line with `node scripts/warden/guards.mjs || exit 1`.
- A deposit refused before 0.4.0 carries a `refused =` line and no refusal file: remove the line once, as before.
- A factory that read exit code 1 as "the train did not leave" reads 75.

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
