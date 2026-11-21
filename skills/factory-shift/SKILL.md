---
name: factory-shift
description: Runs the factory's shift in a project ruled by Warden. It waits for docked branches, runs the trains, reports each one, plays the docked scenarios on a build of what went up, lets a halted train resume by itself, and keeps the workstation healthy between trains. Use it in the factory session, when the user says "start the shift", "keep the trains running" or "watch the dock". French triggers include « lance la tournée », « surveille le quai » and « fais tourner les trains ».
---

# The factory shift

Run it only in the factory tree (`node scripts/warden/status.mjs` shows `Role: factory`). Reply in the person's language.

## Each round

1. **State.** Read `node scripts/warden/status.mjs --json`. You need `role` set to `factory`, a clean tree, and a slot that is free or held by this tree.
   - A train left interrupted is recovered by the next train when its process is gone. If the tree is not clean otherwise, run `node scripts/warden/train.mjs recover`. The tree is yours, never product code.
   - Anything else: stop and say why.
2. **Health**, before any train that builds: `node scripts/warden/disk.mjs guard`. Over budget in your own tree, clean it: `node scripts/warden/disk.mjs clean --own --apply` (add `--deep` only if it is still over). Any other tree is the person's gesture, from the interface or `disk.mjs clean --tree <tree> --apply` (`/warden:factory-health`). The train checks the memory itself.
3. **Wait.** `node scripts/warden/train.mjs watch` returns as soon as a train is worth leaving. It costs nothing while waiting: run it in the background.
   - Exit code 0: go to the train.
   - Exit code 75: a halt outlived its notice threshold. Say it once, to whoever can act: the person for the memory or a missing tool. A red main branch is already in every agent's status: note it in the shift log. Then `watch` again.
4. **Train.** `node scripts/warden/train.mjs run --agent <factory name>` (see `/warden:train`). Exit code 75: the train halted and blamed nobody; `watch` again.
5. **Read the result.**
   - **Went up**: note the commit. Each task already received its note from the train. The deposit moved to `taken/`.
   - **Set aside**: `<session>.refusal.json` gives the class, the step, the first error, the log and `next`. The task got the same note. Fixing it is the author's job, unless it is in `fixes` and on your own branch. The deposit leaves again by itself once its author docks a new commit.
   - **Waiting**: a branch that only conflicted with another branch of the batch waits for the next train, with no refusal.
   - **Not run**: a check that could not run is named in the output and the notes; it was not verified. A missing tool is a workstation matter: tell the person once.
   - **Halted** (`_halt.json`, exit code 75): nobody was refused. A red main branch waits for its repair, a deposit like any other; low memory waits for the memory; an incident is tried again. `watch` knows when to leave again. Never stop a process.
6. **Scenarios.** When the train names scenarios to play, build the pushed commit in a separate tree, never in the train tree: its build is the last trial's, which may be a combination that failed. A worktree or a clone of that exact commit is right. Play the journey with the project's journey tooling, and note the result with the commit on the task. A failure is a finding to report to the person; never revert silently.
7. **Shift log.** Append one line per train to `.work/factory-log.md`: time, commit, branches that went up, branches set aside and why.
8. **Decisions.** A product choice you may not take goes to the person once, as a decision, never as free text alone:

   ```bash
   node scripts/warden/decision.mjs raise --title "<one line>" --question "<what to choose, and why it is theirs>" --option "<first>" --option "<second>" --context train-logs/<log>
   ```

   - Two to four options when the choice has them; none when the answer is free. `--context` names a file of the work folder (a train log, a refusal) the person opens beside it.
   - At each round, read the answers: `node scripts/warden/decision.mjs list --answered --json`. Act on each within your authority, then close it with what you did: `node scripts/warden/decision.mjs close <id> --note "<what was done>"`. An answer that asks for more than your authority allows goes back to the person in your report.
   - A decision still open needs nothing from you: the person sees it in the interface and in every status (`decisions.open`).

## Stop

- when the person says so;
- when the machine is saturated, or the usage budget is low;
- when the remote is lost or a push fails. Report it, with the logs.

A halt is not a stop: the train resumes by itself once its cause can have changed.

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
4. what was not run, so not verified;
5. anything the person must decide.
