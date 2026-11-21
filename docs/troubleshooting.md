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

Read its `refused =` line. Fix it, rebase, check your scope, then remove the line. A branch whose tree no longer exists is refused with "branch not found".

## Messages in the wrong language

Check `WARDEN_LOCALE`, then `git config warden.locale`, then the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`).

## `cargo metadata failed: boundaries not checked`

The workspace does not resolve offline. Run `cargo metadata --offline` to see why; a missing or stale `Cargo.lock` is the usual cause.
