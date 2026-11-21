---
name: dock
description: Docks a ready branch so that the factory takes it to the main branch, in a project ruled by Warden. Use it when an agent branch is finished and verified on its scope, when the user says "dock", "queue it for the train" or "ready for merge", or when a deposit comes back with a refused line. French triggers include « dépose », « mets au train » and « au quai ».
---

# Dock a branch

Only the factory pushes to the main branch. An agent may push its own branch, never the main branch: it docks. Reply in the person's language.

## Before docking

1. **Rebase** on the remote main branch: `git fetch`, then `git rebase origin/<main branch>`. The main branch is `main_branch` in `config/factory.json`.
2. **Check your scope, and only it.** Run the tests of the packages you touched, and the typing of what you touched. Do not build the application, and do not run clippy or the tests of the whole workspace: that is the factory's job.
3. **Run the rules**: `node scripts/warden/rules.mjs`. No finding may be left.
4. Commit only your own files. Never `git add -A`, never `--no-verify`.

## The deposit

The dock is the `train-ready` folder next to the push slot: `.work/train-ready/` at the project's main root. That root is the parent of `git rev-parse --path-format=absolute --git-common-dir`. `node scripts/warden/status.mjs --json` gives its exact path (`dock.folder`).

The deposit is a `<session>.txt` file, one key per line:

```
tree     = <absolute path of the tree that carries the branch>
branch   = <branch name>
commit   = <the commit you checked: git rev-parse HEAD>
tasks    = <task ids, comma separated>
docked   = <dd/mm hh:mm>
scenario = <journey scenario, when the change shows on screen>
```

- `commit` is what the train takes, exactly. Commits you add after docking do not go up until you dock again.
- `priority = <number>` is set only on the person's word: a deposit with a priority leaves first, the lowest number first.
- Read the time on the workstation (`date`); never guess it.
- Two pending deposits at most per agent.

## Afterwards

- The factory takes four branches at most per train. When the branch goes up, the deposit moves to `taken/`, with the commit taken and where it went.
- A branch set aside gets a `refused = <cause>` line: the step that failed, its first error, and the path of the train log. Fix it, rebase, check your scope again, then dock again with the new `commit`, **without the `refused` line**: that is what puts the branch back in the queue.
- A branch that only conflicted with another branch of the batch waits for the next train, with no refused line.
- The factory never resolves a conflict in place of the author.
