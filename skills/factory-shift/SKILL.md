---
name: factory-shift
description: Runs the factory's shift in a project ruled by Warden. It waits for docked branches, runs the trains, reports each one, plays the docked scenarios on a build of what went up, recovers after an interrupted train, and keeps the workstation healthy between trains. Use it in the factory session, when the user says "start the shift", "keep the trains running" or "watch the dock". French triggers include « lance la tournée », « surveille le quai » and « fais tourner les trains ».
---

# The factory shift

Run it only in the factory tree (`node scripts/warden/status.mjs` shows `Role: factory`). Reply in the person's language.

## Each round

1. **State.** Read `node scripts/warden/status.mjs --json`. You need `role` set to `factory`, a clean tree, and a slot that is free or held by this tree.
   - The tree is not clean, or `train.mjs run --dry-run` says a previous train was interrupted: run `node scripts/warden/train.mjs recover`, then the dry run again. The tree is yours, never product code.
   - Anything else: stop and say why.
2. **Health**, before any train that builds: `node scripts/warden/disk.mjs guard`. Over budget, see `/warden:factory-health`. Never clean without the person's word. The train checks the memory itself.
3. **Wait.** `node scripts/warden/train.mjs watch` returns as soon as a branch is docked. It costs nothing while waiting: run it in the background.
4. **Train.** `node scripts/warden/train.mjs run --agent <factory name>` (see `/warden:train`).
5. **Read the result.**
   - **Went up**: note the commit. Each task already received its note from the train. The deposit moved to `taken/`.
   - **Set aside**: the deposit carries `refused = <cause>`: the step that failed, its first error, and the log. The task got the same note. Fixing it is the author's job, unless it is in `fixes` and on your own branch.
   - **Waiting**: a branch that only conflicted with another branch of the batch waits for the next train, with no refused line.
   - **Main branch red**: the train stopped and refused nobody. Report the cause and the log to the person, and wait for the repair.
   - **Memory low**: the train did not leave. Report it; never stop a process.
6. **Scenarios.** When the train names scenarios to play, build the pushed commit in a separate tree, never in the train tree: its build is the last trial's, which may be a combination that failed. A worktree or a clone of that exact commit is right. Play the journey with the project's journey tooling, and note the result with the commit on the task. A failure is a finding to report to the person; never revert silently.
7. **Shift log.** Append one line per train to `.work/factory-log.md`: time, commit, branches that went up, branches set aside and why.

## Stop

- when the person says so;
- when the machine is saturated, or the usage budget is low;
- when a train fails for a reason that is not a branch: a red main branch, a lost remote, a full disk, low memory. Report it, with the logs.

## Never

- two trains at once, or a second big build while a train runs;
- a push to the main branch by hand, a `--no-verify`, or a forced push;
- a fix to an agent's branch, or a conflict resolved in place of its author;
- a process of the person or of another agent stopped to free memory;
- work as an agent in the factory tree.

## Report to the person

One short block per train:

1. what went up;
2. what was set aside, why, and where the log is;
3. the scenarios played on a build of that commit, and their result;
4. anything the person must decide.
