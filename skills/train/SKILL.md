---
name: train
description: Runs one merge train to the main branch in a project ruled by Warden (scripts/warden/train.mjs). Only the factory uses it, from the factory tree, the only one that pushes to the main branch. Use it when the factory must "run the train", "take the docked branches up", or merge what waits at the dock. French triggers include « conduis le train » and « emmène les dépôts ».
---

# Run the train

One factory at a time, in its own tree. The train refuses to run in any other tree once `git config warden.factory` names one. Reply in the person's language.

## Leaving

- The factory tree is clean (`git status`): the train refuses otherwise.
- See what would go up, verifying and pushing nothing: `node scripts/warden/train.mjs run --dry-run`.
- Run it: `node scripts/warden/train.mjs run --agent <factory name>`.
  - `--batch N` sets a shorter batch.
  - `--with <branch>` takes a local branch of the factory along.

## What the train does

1. It takes the push slot, and the CPU priority while it runs.
2. It stacks the deposits in docking order, at most `train.max_batch` of them (four by default). A conflicting branch is set aside, never resolved.
3. Each trial starts again from the main branch:
   - the dependencies, when the lockfile changed;
   - the rules and the script guards;
   - the verification of the changed files;
   - the build, once (`train.build`).
4. When a trial fails, it finds the culprit by halves. The rest goes up.
5. It pushes, then:
   - marks the commit verified, so the hook does not verify it again;
   - removes the deposits that went up;
   - notes each task, when a task tool is set (`git config warden.tasks`).

## After the train

- Read the output: what went up, what was set aside, and why.
- The train does not play the docked `scenario` journeys. The factory plays them on what it just built, then notes the result.
- Never push by hand to the main branch to "unblock" it. Fix the cause, or report it.
- The machine is shared: one train at a time, and no second big build while it runs.
