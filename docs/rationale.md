# Why Each Rule Exists

Warden's tooling rules come from incidents in the repository it was first written for, where up to a dozen agents worked at once. The code keeps each reason next to the rule it explains.

| Incident | The rule it produced |
|---|---|
| Two trees shared a `target`: Cargo reported `Finished` on a tree that did not compile | Never share a `target`; `disk.mjs guard` reports a link or an outside `CARGO_TARGET_DIR` |
| 10 Nov.: a hook started from a linked worktree exports `GIT_DIR`, and tests wrote into the real repository (`core.bare = true`, three stray commits) | `git-env.mjs`, imported first by every test that creates repositories, and its own guard |
| 11 Nov.: a slot taken by hand always beat a hook that polled every 30 s | The hook polls every 5 s |
| 11 Nov., 01:18: two branches, green on their own, made a 701-line file together, refused after 35 minutes of verification | The train runs the rules first, in seconds |
| 11 Nov.: a failing batch of thirteen cost up to four extra verifications | `train.max_batch` = 4 |
| 12 Nov., 02:22: two tools missing their screen labels, refused after the whole verification and build | The train runs the script guards before the verification |
| 12 Nov., 09:08: a branch stacked on another deposit replayed commits already taken, and looked like a conflict | `git cherry` skips commits already in the train |
| 12 Nov., 10:27: a series set aside for missing dependencies that were in its lockfile | Each trial installs its batch dependencies before the guards |
| 20 Nov., 02:25: a tool rewrote the lockfile during a trial; the next trial kept it, failed, and the push was refused | Each trial starts again from the main branch with `checkout -f` |
| A timed test fails on a saturated workstation | A failing test is replayed once, alone, and named "to watch" |
| 20 Nov.: while proving this kit, a `node --test` started from another test runner skipped every file and reported success | A step never inherits `NODE_TEST_CONTEXT` |
| 20 Nov.: while proving this kit, a machine path written with doubled separators (`'C:\\Users\\…'`) went through the secret check | The `machine path` pattern accepts doubled separators |
| 20 Nov.: a Windows clone can turn a `sh` hook into CRLF, and it stops running | The installer keeps `.githooks/*` LF through `.gitattributes` |

## Rules that come from method

- **A rule nothing checks is only an intention.** Each rule is marked **[checked]** in `AGENTS.md`, or is judged in review.
- **An exception is named.** It carries its exact path and its reason. A boundary exception only shrinks.
- **The repository speaks in the present tense.** Git keeps the past; working material goes into `.input/` or `.work/`.
- **Nothing hard-coded.** A threshold comes from the model, a resource or a configured budget.
- **No restriction without a basis.** A restriction rests on the owner's decision, or reads "provisional: <condition>".
- **Say first what is not proven.**
