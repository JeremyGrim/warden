# Merge Train

## The push slot

One push to the main branch at a time on the workstation, for every tree of the project.

- **The lock** is a folder, because `mkdir` is atomic: `.work/push-slot/` at the main root. Its `held-by.txt` names the tree, the commit and the time.
- **The pre-push hook** takes the slot before verifying, and polls every 5 seconds while another tree holds it. A slot held by its own tree is taken back (an interrupted hook).
- **Abandon**: a slot held for more than 50 minutes is taken back, and the takeover is written to `slot.log` when one is set.
- **Keep-alive**: during a long verification, a detached process refreshes the time every 5 minutes, and ends with the verification.
- **Release**: the slot is given back as soon as the remote carries the commit, or after 3 minutes when the push failed after the hook.
- **Moved branch**: when the main branch moved since the rebase, the push is refused before any verification.

## Docking

A ready branch is rebased on the main branch, green on its own scope, and docked:

```
.work/train-ready/<session>.txt

tree     = <absolute path of the tree that carries the branch>
branch   = <branch name>
tasks    = <task ids, comma separated>
docked   = <dd/mm hh:mm>
scenario = <journey scenario, when the change shows on screen>
```

Two pending deposits at most per agent.

## A train

`node scripts/warden/train.mjs run --agent <factory name>` runs one train:

1. **Leave**: the tree is clean and it is the declared factory tree. The train takes the slot, every core (`CARGO_BUILD_JOBS`) and the CPU priority (`priority.mjs`).
2. **Read the dock**: complete deposits with no `refused` line, in docking order.
3. **Stack**: each branch is fetched from its tree and cherry-picked onto the main branch. Commits already taken are skipped (`git cherry`). A conflicting branch is set aside, never resolved. At most `train.max_batch` branches (4) go in one batch; the others wait.
4. **Trial**, always in this order:
   1. start again from the main branch (`checkout -f`);
   2. install the dependencies, when the lockfile changed;
   3. run the rules and the script guards;
   4. verify the changed files;
   5. build once (`train.build`).
5. **Search by halves**: when the trial fails, the culprit is found by halves. A batch of four costs at most two extra trials.
6. **Push**:
   - the commit is marked verified, so the hook does not verify it again;
   - deposits that went up are removed;
   - each task gets a note.

   A branch set aside gets `refused = <cause>`: its author fixes it, rebases, and removes the line.

`--dry-run` stacks and says what would go up, verifying and pushing nothing. `watch` returns as soon as a branch is ready, checking the dock once a minute.

## Push verification

`verify.mjs push`, run by the pre-push hook:

1. reads what Git pushes, and refuses when the pushed commit is not the tree's, or when tracked files are modified;
2. takes the slot when pushing to the main branch;
3. skips the verification when the train has just verified that exact commit;
4. otherwise plans from the changed files:
   - a file matching `verify.rust.full_on` verifies the whole workspace;
   - otherwise, clippy with `-D warnings` on the touched packages and all their dependents, then the tests of the touched packages;
   - `cargo deny` when a manifest or the lockfile changes;
   - the npm advisories when the pnpm lockfile changes;
   - each project step whose `when` patterns match;
5. replays a failing Rust test once, alone. A test that passes on the second try counts as passed, and is named "to watch".
