# Merge Train

## The push slot

One push to the main branch at a time on the workstation, for every tree of the project.

- **The lock** is a folder, because `mkdir` is atomic: `.work/push-slot/` at the main root. Its `held-by.txt` names the tree, the commit and the time.
- **The pre-push hook** takes the slot before verifying, and polls every 5 seconds while another tree holds it. A slot held by its own tree is taken back (an interrupted hook).
- **Abandon**: a slot held for more than 50 minutes is renamed aside, then taken by `mkdir` like a free one, so two hooks cannot both take it. The takeover is written to `slot.log` when one is set.
- **Keep-alive**: during a long verification, a detached process refreshes the time every 5 minutes, and ends with the verification.
- **Release**: the slot is given back as soon as the remote carries the commit, or after 3 minutes when the push failed after the hook.
- **Moved branch**: when the main branch moved since the rebase, the push is refused before any verification.

## Docking

A ready branch is rebased on the main branch, green on its own scope, and docked:

```
.work/train-ready/<session>.txt

tree     = <absolute path of the tree that carries the branch>
branch   = <branch name>
commit   = <the commit checked by its author>
tasks    = <task ids, comma separated>
docked   = <dd/mm hh:mm>
scenario = <journey scenario, when the change shows on screen>
priority = <number, only on the person's word>
```

Two pending deposits at most per agent. The train takes exactly the docked `commit`: commits added after docking were neither checked nor declared by the author. A deposit with no `commit` takes the branch tip, and the train says so.

## A train

`node scripts/warden/train.mjs run --agent <factory name>` runs one train:

1. **Leave**: the tree is clean, it is the declared factory tree, and no previous train was left interrupted. The train takes the slot.
2. **Budget**: below `train.min_free_memory_gib` of memory free to commit, the train does not leave. Otherwise it takes every core, bounded by the memory (`train.memory_per_job_gib` per job, `CARGO_BUILD_JOBS`), turns incremental compilation off (`CARGO_INCREMENTAL=0`), and takes the CPU priority (`priority.mjs`).
3. **Read the dock**: complete deposits with no `refused` line. Those with a `priority` come first, the lowest number first, then the docking order.
4. **Locate**: each branch is fetched from its tree. When the tree no longer exists, the local branch of the same name is taken, and the train says so. A deposit that cannot be read is set aside alone; the train goes on with the others.
5. **Stack**: each docked commit is cherry-picked onto the main branch. Commits already taken are skipped (`git cherry`). At most `train.max_batch` branches (4) go in one batch; the others wait. A branch the factory takes with `--with` is always taken, outside that count.
   - A branch that conflicts with the main branch is set aside, never resolved.
   - A branch that only conflicts with another branch of the batch waits. If that other branch goes up, the first one conflicts with the new main branch and is set aside then; otherwise it waits for the next train, with no refused line.
6. **Advisories on the main branch alone**: `verify.mjs advisories`. When they fail there, the main branch is red: the train stops and blames nobody.
7. **Trial**, always in this order:
   1. start again from the main branch (`checkout -f`);
   2. install the dependencies, when the lockfile changed;
   3. run the rules and the script guards;
   4. verify the changed files (`verify.mjs files`);
   5. build once (`train.build`).
8. **Search by halves**: when the trial fails, the culprit is found by halves. A batch of four costs at most two extra trials.
9. **The main branch alone**: when every branch failed, the main branch alone goes through the same checks, on the files the batch changes. When it fails too, the fault is not in the branches: the train stops and refuses nobody.
10. **Push**:
    - the commit is marked verified, so the hook does not verify it again;
    - deposits that went up move to `taken/`, with the commit taken and where it went;
    - each task gets a note;
    - the train names the scenarios to play on a build of the pushed commit.

    A branch set aside gets `refused = <step> fails: <first error> (log: <path>)`: its author fixes it, rebases, and docks again with the new commit.

Each train writes its whole output to `.work/train-logs/<date>.log`.

`--dry-run` stacks and says what would go up, verifying and pushing nothing. `watch` returns as soon as a branch is ready, checking the dock once a minute.

## Scenarios

The train tree keeps the build of the last trial, which may be a combination that failed; and the tree goes back where it left from at the end. A journey is never played there. The factory builds the pushed commit in a separate tree (a worktree or a clone of that commit), plays the journey, and notes the result with the commit.

## An interrupted train

A killed process, a workstation out of memory or a power cut leaves the factory tree on the train branch, sometimes in the middle of a cherry-pick. The train records where it left from in the Git folder of its tree, and the next train refuses to leave while that record is there. `node scripts/warden/train.mjs recover`:

- refuses while the train process is still alive;
- aborts a cherry-pick in progress;
- checks out where the train left from;
- removes the train references;
- gives back the slot this tree held.

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

The rules read the Rust workspace with `--locked`: a lockfile behind the manifests is a finding, never rewritten.
