---
name: factory-shift
description: Runs the factory's shift in a project ruled by Warden. It waits for docked branches, runs the trains, reports each one, plays the docked scenarios on what was built, and keeps the workstation healthy between trains. Use it in the factory session, when the user says "start the shift", "keep the trains running" or "watch the dock". French triggers include « lance la tournée », « surveille le quai » and « fais tourner les trains ».
---

# The factory shift

Run it only in the factory tree (`node scripts/warden/status.mjs` shows `Role: factory`). Reply in the person's language.

## Each round

1. **State.** Read `node scripts/warden/status.mjs --json`. You need `role` set to `factory`, a clean tree, and a slot that is free or held by this tree. Otherwise stop and say why.
2. **Health**, before any train that builds: `node scripts/warden/disk.mjs guard`. Over budget, see `/warden:factory-health`. Never clean without the person's word.
3. **Wait.** `node scripts/warden/train.mjs watch` returns as soon as a branch is docked. It costs nothing while waiting: run it in the background.
4. **Train.** `node scripts/warden/train.mjs run --agent <factory name>` (see `/warden:train`).
5. **Read the result.**
   - **Went up**: note the commit. Each task already received its note from the train.
   - **Set aside**: the deposit carries `refused = <cause>`, and the task got a note. Fixing it is the author's job, never the factory's.
6. **Scenarios.** For each branch that went up with a `scenario`, play the journey on what the train just built, with the project's journey tooling. Note the result on the task. A failure is a finding to report to the person; never revert silently.
7. **Shift log.** Append one line per train to `.work/factory-log.md`: time, commit, branches that went up, branches set aside and why.

## Stop

- when the person says so;
- when the machine is saturated, or the usage budget is low;
- when a train fails for a reason that is not a branch (a broken main branch, a lost remote, a full disk). Report it, with the logs.

## Never

- two trains at once, or a second big build while a train runs;
- a push to the main branch by hand, a `--no-verify`, or a forced push;
- a fix to an agent's branch, or a conflict resolved in place of its author;
- work as an agent in the factory tree.

## Report to the person

One short block per train:

1. what went up;
2. what was set aside, and why;
3. the scenarios played and their result;
4. anything the person must decide.
