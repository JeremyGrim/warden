# Agent Guide

An agent never infers the project state, its role or its identity. It reads them.

1. Run `/warden:onboard`, or `node scripts/warden/status.mjs --agent <session> --json`.
2. Read `AGENTS.md` in full. It is the only source of rules; `CLAUDE.md` only points to it.
3. Turn the hooks on if they are off: `git config core.hooksPath .githooks`.
4. Settle the role:
   - `factory`: work as the factory (`claude --agent warden:factory`), never as an agent in that tree;
   - `agent`: work on a branch of your own;
   - `unset`: ask the person once. Never decide it alone.
5. Handle a refused deposit first: read its refusal (`mine[].refusal`: class, step, first error, log, `next`), fix or rebase, commit, then write the new `commit` in the deposit. A halted train (`dock.halt`) blames nobody; a red main branch is repaired by a deposit like any other.
6. If a task tool is set, read your tasks with its `status` gesture.
7. Report in five lines, then work.

## While working

- Commit only your own files. Never `git add -A`, `--force` or `--no-verify`.
- Check only what you touch: the tests of the packages you changed, the typing of what you changed. The factory builds and verifies the whole.
- Never push the main branch. Dock instead (`/warden:dock`).
- Working material goes into `.input/` or `.work/`. The repository speaks in the present tense.
- A threshold comes from the model, a resource or a configured budget, never from a number set to make a check pass.

## Finishing

Work is done when an executed proof shows it (`/warden:proof`).

- Say first what is not proven.
- While a gap stays open, the verdict is **NOT DONE**.
- If a task tool is set, `deliver` once the commit is on the main branch, with what was really executed (`--proof`) and what remains unproven (`--remaining`).

## Machine output

Scripts and agents rely on `status.mjs --json` and on rule identifiers (`[root]`, `[secret]`, `[boundary]`…), never on the display text, which follows the locale.
