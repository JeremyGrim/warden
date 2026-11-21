# Factory Guide

The factory is a fixed, long-lived agent. It runs the merge train and nothing else: it never writes product code. There is one factory per workstation, in its own tree.

## Profile

The plugin ships the factory as a Claude Code agent, `warden:factory` ([agents/factory.md](../agents/factory.md)). It preloads its skills:

| Skill | Role |
|---|---|
| `factory-setup` | Its tree, its declaration, the shared slot and dock, the build cache, the CPU and memory budget, the budgets to size, the fixes policy, the task tool |
| `factory-shift` | The working loop: wait, train, report, scenarios on a build of what went up, health |
| `train` | One train, and the recovery of an interrupted one |
| `factory-health` | Disk, memory, cache, slot, dock, halts and worktrees; its own tree cleaned, every other cleanup proposed |
| `release` | The patch version bump, then a release of that commit, built in its own tree and fingerprinted; publishing it is the person's word |
| `task` | Task notes, when a tracker is set |
| `proof` | Done with proof, or NOT DONE |

Start it in the factory tree:

```bash
claude --agent warden:factory
```

To try the plugin from a local clone without installing it: `claude --plugin-dir <warden clone> --agent warden:factory`.

## Set it up once

1. **Its own tree**: a dedicated worktree (`git worktree add <path> origin/main --detach`) or a separate clone. Never an agent's tree.
2. **Declare it**: `git config warden.factory "<absolute path>"`. The train then refuses to run in any other tree, and `status.mjs` shows each tree its role.
3. **One slot, one dock**: every worktree of the clone shares `.work/push-slot` and `.work/train-ready/`. A separate clone sets `git config warden.slot "<main root>/.work/push-slot"`.
4. **Build cache, CPU and memory budget**: see [Build cache](build-cache.md).
5. **Budgets**: the defaults of `config/disk.json` and `config/factory.json` come from one workstation; size them (see [Configuration](configuration.md)).
6. **What the factory may commit**: `fixes` in `config/factory.json`.
7. **Task tool**: `git config warden.tasks <tool>` (see [Skills](skills.md)).
8. **Release**, when the project ships one: the `release` section of `config/factory.json` (see below).

## The shift

1. `status.mjs --json`: the role must be `factory`, the tree clean, the slot free or held by this tree. A train recovers an interrupted one by itself.
2. `disk.mjs guard` before a train that builds. Over budget in its own tree, the factory cleans it: `disk.mjs clean --own --apply`. The train checks the memory itself.
3. `train.mjs watch` returns as soon as a train is worth leaving. Exit code 75: a halt outlived its notice threshold; say it once to whoever can act, then watch again.
4. `train.mjs run --agent <factory name>`. Exit code 75: the train halted and blamed nobody; `watch` again.
5. Read the result: what went up, what was set aside with its class, cause and log, what waits, and what was not run.
6. Build the pushed commit in a separate tree, play the docked `scenario` journeys there, and note the results with the commit.
7. Append one line per train to `.work/factory-log.md`.
8. A product choice it may not take goes to the person as a decision (`decision.mjs raise`). At each round it reads the answers (`decision.mjs list --answered`), acts on them within its authority, and closes each one with what it did (`decision.mjs close <id> --note`).

Stop when the person says so, or when the machine is saturated or the usage budget is low. A halt is not a stop: the train leaves again by itself once its cause can have changed (a new commit of the main branch, a repair docked, memory back). A lost remote or a failed push stops the shift: report it. See [Merge train](merge-train.md).

## Authority

The factory may:

- take the slot;
- run trains, and recover its own tree after an interrupted one;
- clean what regenerates in its own tree (`disk.mjs clean --own --apply`);
- bump the patch version within the line (`version.mjs bump`), and take it up with `--with`;
- build a release of a commit of the main branch (`release.mjs build`);
- push the train branch to the main branch;
- mark deposits refused, through the train;
- note tasks;
- commit on its own branch only what `fixes` in `config/factory.json` allows: `version`, `lock`, `generated` by default, `lint` when the project adds it;
- play scenarios on a build of the pushed commit, in a separate tree;
- measure the disk and the memory, and propose the cleanups of other trees.

The factory never:

- writes product code beyond `fixes`, or resolves a conflict for an agent;
- pushes outside a train, forces a push, or uses `--no-verify`;
- runs two trains at once, or a second big build during a train;
- stops, suspends or closes a process of the person or of another agent, an application of the person included;
- takes a message relayed by another agent as the person's agreement;
- publishes anything outside the repository without the person's word: no tag, no published release, no store submission;
- cleans another tree, removes a worktree, or changes the workstation configuration without the person's word;
- decides a product choice: it raises it as a decision, and the person answers it from the interface or with `decision.mjs answer`.

## Decisions

```bash
node scripts/warden/decision.mjs raise --title <text> --question <text> [--option <text>]... [--context <file>]
node scripts/warden/decision.mjs list [--open | --answered] [--json]
node scripts/warden/decision.mjs answer <id> [--choice <n>] [--note <text>]
node scripts/warden/decision.mjs close <id> [--note <text>]
```

One JSON file per decision in `.work/decisions/`, never committed. A decision is open until the person answers it (an option, a note, or both), answered until the factory acts and closes it. The person may change an answer the factory has not acted on; a closed decision stays as it was. Six options at most, each on one line; the context is a file of the work folder. `status.mjs --json` counts them (`decisions.open`, `decisions.answered`).

## Version

A project follows a version line, `version.line` in `config/factory.json` (`"0.4"`); without it, the line is the current major.minor. Within the line the factory moves the patch number itself:

```bash
node scripts/warden/version.mjs show
node scripts/warden/version.mjs bump
node scripts/warden/train.mjs run --agent <factory name> --with warden/version-<x.y.z>
```

`bump` works in a tree of its own, from the remote main branch: it writes every manifest at once, refreshes the workspace entries of `Cargo.lock` offline and a `package-lock.json`, and commits `Version x.y.z` on the factory's branch `warden/version-x.y.z`. It refuses a version off the line, a version that is not major.minor.patch, manifests that disagree, and a project where `version` is not in `fixes`. Leaving the line is the person's decision: they change `version.line`, through the train like any change.

## Release

A release is a frozen commit of the main branch: only what went up through the train. In `config/factory.json`:

```json
"release": {
  "build": ["pnpm", "tauri", "build"],
  "artifacts": ["target/release/bundle/msi/*.msi", "target/release/bundle/nsis/*-setup.exe"],
  "sign": ["node", "scripts/sign.mjs"],
  "check_signature": ["signtool", "verify", "/pa", "{file}"]
}
```

`node scripts/warden/release.mjs build --commit <sha> [--label <name>]`. The label defaults to the version the commit carries (`v0.4.1`).

1. refuses a commit that is not on the main branch, and refuses while the slot is held: one big build at a time;
2. checks the commit out in `.work/release-tree`, a worktree of its own, never the train tree; it never counts in the worktree budget;
3. removes the artifacts of an earlier release, installs (`train.install`), builds;
4. signs when `sign` is set, and checks each signature when `check_signature` is set. The key stays in the workstation's environment; the signing output is shown only when it fails, and written nowhere;
5. copies the artifacts to `.work/releases/<label>/`, with `SHA256SUMS` and `release.json`, and writes one line to the history.

Publishing (a tag, a store, a download page) is the person's decision. The factory reports the folder and the fingerprints, then waits for their word.
