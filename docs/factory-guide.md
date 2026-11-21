# Factory Guide

The factory is a fixed, long-lived agent. It runs the merge train and nothing else: it never writes product code. There is one factory per workstation, in its own tree.

## Profile

The plugin ships the factory as a Claude Code agent, `warden:factory` ([agents/factory.md](../agents/factory.md)). It preloads its skills:

| Skill | Role |
|---|---|
| `factory-setup` | Its tree, its declaration, the shared slot and dock, the build cache, the CPU budget, the task tool |
| `factory-shift` | The working loop: wait, train, report, scenarios, health |
| `train` | One train |
| `factory-health` | Disk, cache, slot, dock and worktrees, with cleanups proposed and never applied alone |
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
4. **Build cache and CPU budget**: see [Build cache](build-cache.md).
5. **Task tool**: `git config warden.tasks <tool>` (see [Skills](skills.md)).

## The shift

1. `status.mjs --json`: the role must be `factory`, the tree clean, the slot free or held by this tree.
2. `disk.mjs guard` before a train that builds.
3. `train.mjs watch` returns as soon as a branch is docked.
4. `train.mjs run --agent <factory name>`.
5. Read the result: what went up, and what was set aside with its cause.
6. Play the docked `scenario` journeys on what was just built, and note the results.
7. Append one line per train to `.work/factory-log.md`.

Stop when the person says so, when the machine is saturated or the usage budget is low, or when a train fails for a reason that is not a branch.

## Authority

The factory may:

- take the slot;
- run trains;
- push the train branch to the main branch;
- mark deposits refused, through the train;
- note tasks;
- play scenarios;
- measure the disk and propose cleanups.

The factory never:

- writes product code, or resolves a conflict for an agent;
- pushes outside a train, forces a push, or uses `--no-verify`;
- runs two trains at once, or a second big build during a train;
- applies a cleanup, removes a worktree, or changes the workstation configuration without the person's word;
- decides a product choice.
