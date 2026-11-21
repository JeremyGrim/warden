# Troubleshooting

## Nothing is checked at commit or push

The hooks are inactive in this clone. Run `git config core.hooksPath .githooks`; `status.mjs` reports `hooks_active`. A hook that does not run at all on Linux or macOS may have lost its executable bit or gained CRLF line endings: the installer keeps `.githooks/* text eol=lf` in `.gitattributes`.

## "Install refused: scripts/warden/ differs from the kit"

A kit script was edited in the project, or a file was added to `scripts/warden/`. Put the file back as the kit installed it, or move your own file elsewhere. A project need becomes a setting in `config/`; a kit change is made in the Warden repository, then installed.

## "the kit is as its version delivered it" fails

Same cause, seen at push by `kit.test.mjs`. In the Warden repository itself, run `node tools/fingerprints.mjs` after changing the kit.

## The push waits for the slot

Another tree holds it. The message names the tree and the time. A slot held for more than 50 minutes is taken back. Never delete the slot folder by hand while a push may run.

## "main moved since your rebase"

Fetch, rebase on the remote main branch, check your scope again, push again. Nothing was verified for nothing.

## "this tree is not the factory"

`git config warden.factory` names another tree. Agents dock; only the factory tree runs the train.

## A test passes on the second try

It counts as passed, and the output names it "to watch". A timed test on a saturated workstation is the usual cause. If it keeps coming back, fix the test.

## A deposit keeps being set aside

Read `<session>.refusal.json` next to it, or `status.mjs --agent <name> --json` (`mine[].refusal`): the class, the step, the rule and paths, the first error, the log, and `next`. Fix it or rebase, check your scope, commit, then write the new `commit` in the deposit; the refused line can stay. The same commit docked again stays refused. A branch whose tree no longer exists is taken from the local branch of the same name when the repository still has it; otherwise it is refused with "branch not found".

## A deposit refused before 0.4.0 does not leave

It has a `refused =` line and no refusal file: remove the line once, as before.

## "a train is still running in this tree"

The recorded train process is alive. Wait for it. When it is gone, the next train recovers the tree by itself; `node scripts/warden/train.mjs recover` does the same by hand.

## "The main branch … is red on its own"

Every branch of the batch failed and so did the main branch alone, or an incident survived its replay there too. No branch was refused, and the train halted (exit code 75, `_halt.json`). Read the cause and the log: a broken test on the main branch, a tool that changed on the workstation. Repair it through a deposit like any other: the next train leaves as soon as the main branch moves or the dock changes, and takes the waiting deposits with the repair. Until then a train does not leave for nothing ("is still red").

## "The advisories fail on … alone"

A new advisory concerns a dependency of the main branch. No branch is blamed: each trial checks the advisories first, so only a batch that bumps the dependency goes up. Dock that bump.

## "Memory: … free to commit"

The train halted on the memory. `watch` waits for it to come back, and says it once past `train.halt_notice_minutes`. Something holds the workstation's memory: name it to the person. The factory never stops a process to free memory. The threshold is `train.min_free_memory_gib`.

## "replayed once" after an incident

A step failed with an incident of the workstation (memory, a file held, the network) and was replayed. It passed: nothing to do. If it fails again, the train verifies the main branch alone: when the main branch passes, the branch is refused as a `defect` (it may exhaust the memory by itself); when it fails too, the train halts.

## "not run, …" / "Not run on this train, so not verified"

A check asked for could not run: a tool absent, no advisory database. It is never counted as passed. With `verify.when_missing = record`, the commit goes up and its notes say what was not verified; with `block`, the push and the train wait. Install the missing tool on the workstation, or keep the advisory database (`npm-audit.mjs` says how).

## "Kit guards: already passed"

The kit's own tests passed in this clone on the same kit files, Node, Git and platform: they are not run again. The fingerprint and the project's script tests still run. `node scripts/warden/guards.mjs --all` runs everything.

## Messages in the wrong language

Check `WARDEN_LOCALE`, then `git config warden.locale`, then the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`).

## `cargo metadata failed: boundaries not checked`

The workspace does not resolve offline. Run `cargo metadata --offline --locked` to see why.

## "Cargo.lock is not up to date with the manifests"

A manifest changed and the lockfile did not follow. The rules read the workspace with `--locked` and never rewrite the lockfile. Update it with Cargo in your tree, check it, and commit it with the manifest.
