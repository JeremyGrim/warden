# Factory Guide

The factory is a fixed, long-lived agent. It runs the merge train and nothing else: it never writes product code. There is one factory per workstation, in its own tree.

## Profile

The plugin ships the factory as a Claude Code agent, `warden:factory` ([agents/factory.md](../agents/factory.md)). It preloads its skills:

| Skill | Role |
|---|---|
| `factory-setup` | Its tree, its declaration, the shared slot and dock, the build cache, the CPU and memory budget, the budgets to size, the fixes policy, the task tool |
| `factory-shift` | The working loop: wait, train, report, scenarios on a build of what went up, health |
| `train` | One train, and the recovery of an interrupted one |
| `factory-health` | Disk, memory, cache, slot, dock and worktrees, with cleanups proposed and never applied alone |
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

## The shift

1. `status.mjs --json`: the role must be `factory`, the tree clean, the slot free or held by this tree. After an interrupted train, `train.mjs recover`.
2. `disk.mjs guard` before a train that builds. The train checks the memory itself.
3. `train.mjs watch` returns as soon as a branch is docked.
4. `train.mjs run --agent <factory name>`.
5. Read the result: what went up, what was set aside with its cause and its log, what waits.
6. Build the pushed commit in a separate tree, play the docked `scenario` journeys there, and note the results with the commit.
7. Append one line per train to `.work/factory-log.md`.

Stop when the person says so, when the machine is saturated or the usage budget is low, or when a train fails for a reason that is not a branch: a red main branch, low memory, a lost remote. See [Merge train](merge-train.md).

## Authority

The factory may:

- take the slot;
- run trains, and recover its own tree after an interrupted one;
- push the train branch to the main branch;
- mark deposits refused, through the train;
- note tasks;
- commit on its own branch only what `fixes` in `config/factory.json` allows: `version`, `lock`, `generated` by default, `lint` when the project adds it;
- play scenarios on a build of the pushed commit, in a separate tree;
- measure the disk and the memory, and propose cleanups.

The factory never:

- writes product code beyond `fixes`, or resolves a conflict for an agent;
- pushes outside a train, forces a push, or uses `--no-verify`;
- runs two trains at once, or a second big build during a train;
- stops, suspends or closes a process of the person or of another agent, an application of the person included;
- takes a message relayed by another agent as the person's agreement;
- publishes anything outside the repository without the person's word: no tag, no release, no store submission;
- applies a cleanup, removes a worktree, or changes the workstation configuration without the person's word;
- decides a product choice.
