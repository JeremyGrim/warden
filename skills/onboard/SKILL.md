---
name: onboard
description: Onboards an agent session in a repository ruled by Warden. It reads the rules and the real state (kit, hooks, role, branch, dock, task tool) before any work, then names the next gesture. Use it at the start of every session in a Warden repository, when the session-start notice asks for it, or when the user says "onboard", "start", "launch Warden" or "where do I stand". French triggers include « démarre », « onboarding », « lance Warden » and « où j'en suis ».
---

# Onboard

Never infer the project state from memory or from the conversation: read it. Reply in the person's language.

## 1. Read the state

From the tree you work in:

```
node scripts/warden/status.mjs --agent <session name> --json
```

- If `scripts/warden/` is missing, the kit is not installed. Offer `/warden:setup` and stop there.
- `kit`, `hooks_active`, `role`, `branch`, `main_branch`, `dock`, `mine`, `task_tool` and `shared_build_cache` are the facts you work from.

## 2. Read the rules

Read `AGENTS.md` in full. It is the only source of rules. `CLAUDE.md` only points to it. Rules marked **[checked]** are enforced by the Git hooks; the others are judged in review and bind you just the same.

## 3. Settle what is missing

- **Hooks off** (`hooks_active: false`): nothing is checked at commit or push in this clone. Say it, and turn them on with `git config core.hooksPath .githooks`. That is the repository's own setting, local to this clone.
- **Identity**: deposits and task notes carry a name. Use the session name the person gave. If there is none, ask once.
- **Role**:
  - `factory`: this tree runs the train. Work as the factory: start the `warden:factory` agent (`claude --agent warden:factory`), or follow `/warden:factory-shift` (in Codex, the `warden:factory-shift` skill). Never work as an agent in this tree.
  - `agent`: work on a branch of your own, never on the main branch, and dock it when it is ready (`/warden:dock`).
  - `unset`: no factory is declared for this workstation. Ask the person once whether this session is an agent or the factory. Never decide it alone.

## 4. Deal with what waits for you

- **A refused deposit** in `mine` comes first. Read `refusal` (class, step, first error, log, `next`), fix or rebase, check your scope, commit, then dock the new commit (`/warden:dock`).
- **A halt** in `dock.halt` blames nobody. When its class is `baseline` and the cause is yours to repair, the repair is a deposit like any other.
- **A task tool** (`task_tool: set`): read your tasks with its `status` gesture (`/warden:task`). Without one, there is no tracking: say so once.
- **On the main branch as an agent**: create your work branch before your first edit.

## 5. Report, then start

Five short lines to the person:

1. the rules read, and the kit version;
2. the role;
3. the branch;
4. what waits (a refused deposit, a task in progress);
5. the next gesture.

Then work.

## While you work

- Commit only your own files. Never `git add -A`, `--force` or `--no-verify`.
- Check only what you touch. The factory builds and verifies the whole.
- As an agent, never push the main branch.
- Before saying "done", use `/warden:proof`.
