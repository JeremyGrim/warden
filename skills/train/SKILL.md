---
name: train
description: Runs one merge train to the main branch in a project ruled by Warden (scripts/warden/train.mjs), recovers the factory tree after an interrupted one, and reads a halt. Only the factory uses it, from the factory tree, the only one that pushes to the main branch. Use it when the factory must "run the train", "take the docked branches up", merge what waits at the dock, or "recover the train". French triggers include « conduis le train », « emmène les dépôts » and « reprends le train ».
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

1. It recovers a train left interrupted whose process is gone, takes the push slot, then checks the memory free to commit. Below `train.min_free_memory_gib`, it halts.
2. It sets its budget: every core, bounded by the memory (`train.memory_per_job_gib` per job), incremental compilation off, and the CPU priority while it runs.
3. It reads the dock: deposits with a `priority` first, then in docking order. A refused deposit leaves again once it names a new commit. It takes exactly the docked `commit`. When the branch moved on since, it says so and takes only that commit. Halted on a red main branch, with neither the main branch nor the dock changed, it does not leave.
4. It stacks at most `train.max_batch` deposits (four by default).
   - A branch that conflicts with the main branch is set aside, never resolved.
   - A branch that only conflicts with another branch of the batch waits. If that other one goes up, the branch is set aside then, since it conflicts with the new main branch.
5. It runs the advisories on the main branch alone. If they fail there, every trial checks them first: only a batch that repairs them goes up, and nobody is blamed for them.
6. Each trial starts again from the main branch:
   - the dependencies, when the lockfile changed;
   - the rules and the script guards (the kit's own tests only when the kit, Node or Git changed);
   - the verification of the changed files;
   - the build, once (`train.build`).
7. Every failed step gets a class: `violation`, `defect`, `conflict`, `transient`, `incomplete` or `baseline`. An incident of the workstation (`transient`) is replayed once.
8. When a trial fails, it finds the culprit by halves. The rest goes up.
9. When every branch fails, or an incident survives its replay, it verifies the main branch alone on the same files. If that fails too, the train halts (exit code 75, `_halt.json`) and refuses nobody. A check that could not run (`incomplete`) halts it too when `verify.when_missing` is `block`; with `record`, the commit goes up and its notes say what was not run.
10. It pushes, then:
   - marks the commit verified, so the hook does not verify it again;
   - moves the deposits that went up to `taken/`, with the commit taken and where it went;
   - notes each task, when a task tool is set (`git config warden.tasks`);
   - names the scenarios to play on a build of the pushed commit.
11. A branch set aside gets `<session>.refusal.json` (class, step, rule, files, first error, log, refused commit, `next`) and a `refused =` line.

Each train writes its whole output to `train-logs/<date>.log`, next to the dock.

## When a train was interrupted

A killed process or a power cut leaves the tree on the train branch, sometimes in the middle of a cherry-pick. When that process is gone, the next train recovers the tree first and leaves. By hand: `node scripts/warden/train.mjs recover`. Both put the tree back where the train left from, abort the cherry-pick, remove the train references, and give back the slot this tree held. Both refuse while a train is still running.

## When the train halts

`_halt.json` in the dock says why, on which commit of the main branch, and for which dock. Every agent sees it in its status.

- `baseline`: the main branch is red on its own. The repair is a deposit like any other; the next train leaves when the main branch moves or the dock changes.
- `transient`: the memory is low, or an incident persisted on the main branch alone. `watch` waits for the memory, or for `train.retry_minutes`.
- `incomplete`: a check the project blocks on could not run. A workstation matter.

`watch` returns once with exit code 75 when a halt outlives `train.halt_notice_minutes` since it began, however many trains met it since.

## After the train

- Read the output: what went up, what was set aside with its class, what was not run, and why.
- The train does not play the docked `scenario` journeys. The factory builds the pushed commit in a separate tree, plays them there, then notes the result.
- Never push by hand to the main branch to "unblock" it. Fix the cause, or report it.
- The machine is shared: one train at a time, and no second big build while it runs.
