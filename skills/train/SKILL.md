---
name: train
description: Runs one merge train to the main branch in a project ruled by Warden (scripts/warden/train.mjs), and recovers the factory tree after an interrupted one. Only the factory uses it, from the factory tree, the only one that pushes to the main branch. Use it when the factory must "run the train", "take the docked branches up", merge what waits at the dock, or "recover the train". French triggers include « conduis le train », « emmène les dépôts » and « reprends le train ».
---

# Run the train

One factory at a time, in its own tree. The train refuses to run in any other tree once `git config warden.factory` names one. Reply in the person's language.

## Leaving

- The factory tree is clean (`git status`): the train refuses otherwise.
- See what would go up, verifying and pushing nothing: `node scripts/warden/train.mjs run --dry-run`.
- Run it: `node scripts/warden/train.mjs run --agent <factory name>`.
  - `--batch N` sets a shorter batch.
  - `--with <branch>` takes a local branch of the factory along: always taken, outside the batch count. It carries only what `fixes` allows.

## What the train does

1. It takes the push slot, then checks the memory free to commit. Below `train.min_free_memory_gib`, it does not leave.
2. It sets its budget: every core, bounded by the memory (`train.memory_per_job_gib` per job), incremental compilation off, and the CPU priority while it runs.
3. It reads the dock: deposits with a `priority` first, then in docking order. It takes exactly the docked `commit`. When the branch moved on since, it says so and takes only that commit.
4. It stacks at most `train.max_batch` deposits (four by default).
   - A branch that conflicts with the main branch is set aside, never resolved.
   - A branch that only conflicts with another branch of the batch waits. If that other one goes up, the branch is set aside then, since it conflicts with the new main branch.
5. It runs the advisories on the main branch alone. If they fail there, the main branch is red: the train stops and blames nobody.
6. Each trial starts again from the main branch:
   - the dependencies, when the lockfile changed;
   - the rules and the script guards;
   - the verification of the changed files;
   - the build, once (`train.build`).
7. When a trial fails, it finds the culprit by halves. The rest goes up.
8. When every branch fails, it verifies the main branch alone on what the batch changes. If that fails too, the main branch is red: the train stops and refuses nobody.
9. It pushes, then:
   - marks the commit verified, so the hook does not verify it again;
   - moves the deposits that went up to `taken/`, with the commit taken and where it went;
   - notes each task, when a task tool is set (`git config warden.tasks`);
   - names the scenarios to play on a build of the pushed commit.
10. A branch set aside gets `refused = <step> fails: <first error> (log: <path>)`.

Each train writes its whole output to `train-logs/<date>.log`, next to the dock.

## When a train was interrupted

A killed process or a power cut leaves the tree on the train branch, sometimes in the middle of a cherry-pick. The next train refuses to leave and says so. Run:

```
node scripts/warden/train.mjs recover
node scripts/warden/train.mjs run --dry-run
```

`recover` puts the tree back where the train left from, aborts the cherry-pick, removes the train references, and gives back the slot this tree held. It refuses while a train is still running.

## After the train

- Read the output: what went up, what was set aside, and why.
- The train does not play the docked `scenario` journeys. The factory builds the pushed commit in a separate tree, plays them there, then notes the result.
- Never push by hand to the main branch to "unblock" it. Fix the cause, or report it.
- The machine is shared: one train at a time, and no second big build while it runs.
