# Rules of the {{project}} repository

A rule nothing checks is only an intention. These rules are therefore checked by `node scripts/warden/rules.mjs`, at commit and at push, through the Git hooks in `.githooks/`. Rules marked **[checked]** block. The others are judged in review. Changing a rule or a ceiling goes through this file and `config/rules.json`, in one commit that says why.

To start: `git config core.hooksPath .githooks` turns the hooks on. The kit in `scripts/warden/` is copied as is: what belongs to the project goes into `config/`, never into its scripts.

## 1. What enters the repository

- **[checked]** The root is closed. Only the folders and files listed in `config/rules.json` belong there.
- **[checked]** The repository holds source and documentation. Never a build, a log, a capture, an archive, a database, a PDF or a binary. A file over 512 KiB needs a named exception.
- **[checked]** 700 lines at most per file. Split by responsibility, never compact to pass the check. Past 650, the commit warns without refusing: whoever touches the file splits it.
- **[checked]** No secret, no path specific to a machine.
- **[checked]** One package manager, with one lockfile.
- **[checked]** `AGENTS.md` is the only source of rules. `CLAUDE.md` only points to it.

Working material (briefs, reports, captures, exports) goes into `.input/` or `.work/`, which are not committed.

Foreign code enters with a named reason in `config/rules.json` (`foreign_code`) and a way to prove its gap with upstream. It escapes the line and size ceilings, not the secret check, and nothing in it is fixed by hand.

## 2. The repository speaks in the present tense

A document says what is true today. What no longer is gets fixed or deleted: Git keeps the past.

- **[checked]** `docs/` holds 15 files at most, with no date in a name, and no report, brief, audit or plan.
- **[checked]** No document declares itself historical, archived or informational. It would no longer belong here.

## 3. Architecture

- The domain knows no host, provider or hardware; protocols and external tools stay in their adapters. A boundary is checked by declaring it in `config/rules.json` (`boundaries`), and its rule is then marked **[checked]** here.
- No empty shell: a folder exists when it holds something real.
- Every instruction meant for a model lives in a committed resource, never in an interface component.
- Nothing hard-coded: a threshold comes from the model, a resource or a configured budget, never from a number set to make a check pass.

## 4. Working together

- The main branch is the only integration branch.
- Everyone commits only their own files and preserves the work of others, Git index included.
- Before pushing: `git fetch`, fast-forward only, never force. If the remote moved, say so.
- Only the factory pushes to the main branch. An agent pushes its own branch, never the main branch.
- No check is bypassed (`--no-verify`): fix the cause, or propose to change the rule.
- **[checked]** Nothing verifies the repository outside the workstation. The push hook runs the rules, the script guards, then `node scripts/warden/verify.mjs push`: what `config/factory.json` asks for the files the push changes. The pushed commit must be the tree's, with no tracked modification. One push to the main branch at a time on the workstation: the hook takes the slot (`.work/push-slot` at the root), refuses before any verification when the main branch moved, and gives it back when the remote carries the commit.
- An agent checks only what it touches. Its ready branch is docked in `.work/train-ready/<session>.txt`: `tree`, `branch`, `commit` (the commit checked, the only one taken), `tasks`, `docked` (`dd/mm hh:mm`), and `scenario` when the change shows on screen. It is rebased on the main branch and green on its scope; two pending deposits at most per agent. The factory runs `node scripts/warden/train.mjs run --agent <name>`: four branches at most per batch, verified together, the culprit found by halves. A branch set aside gets a `refused =` line naming the failed step, its first error and the log: its author fixes it, rebases and docks again with the new commit, without the line.
- Work is done when an executed proof shows it, and a successful command only proves what it checks. While a gap stays open, write **NOT DONE**. No simulated success. Say first what is not proven.
- No restriction without a basis: the decision of the repository owner, or "provisional: <condition>".
- Replacing a path means deleting the old one.

## 5. The disk

- Work happens in the root. An extra worktree stays an exception, within the ceilings of `config/disk.json`.
- **Never share a `target` between two trees**, by link or by `CARGO_TARGET_DIR`: Cargo can then report success without having compiled the tree's code.
- Deliverables live outside the repository.
- `node scripts/warden/disk.mjs guard` before a big build. `clean` is a dry run; `--apply` stays a gesture of the repository owner.
