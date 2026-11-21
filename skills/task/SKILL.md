---
name: task
description: Keeps task tracking up to date through the five gestures of the tracking contract (status, take, note, block, deliver), in a project that set a task tool (git config warden.tasks). Use it at the start of a session, when taking a task, after a step that matters, when blocked, and when the commit is on the main branch. French triggers include « prends la tâche », « note », « je suis bloqué » and « livre ».
---

# Track a task

Whoever follows the work reads the tracking tool, not the conversation. What is not written in the tool does not exist for them. Reply in the person's language.

## The tool

The tracking contract has five gestures. Any tool that accepts them fits: a workstation script, or a command that talks to Linear, ClickUp or another tracker.

- It is set per workstation, never in the repository: `git config warden.tasks <path or command>`.
- A Node script (`.mjs`, `.cjs`, `.js`) runs through `node <path>`; any other program runs as is.
- A tool that names the gestures differently (for example `etat`, `prendre`, `bloquer`, `livrer`) maps them one to one.
- With no setting, no tracking is connected. Say so once, and invent nothing.

## The five gestures

| When | Gesture |
|---|---|
| The session opens, or you come back | `<tool> status --agent <me>` |
| You start a task | `<tool> take <task> --agent <me>` |
| A step that matters is done | `<tool> note <task> "<what is done>" --agent <me>` |
| You cannot move on | `<tool> block <task> "<what blocks, who can unblock>" --agent <me>` |
| The commit is on the main branch | `<tool> deliver <task> --commit <sha> --proof "<…>" --remaining "<…>" --agent <me>` |

The train writes a note itself on each task it takes up or sets aside.

## A note that helps

- One or two sentences of facts, in the past tense: a cause established, a choice made, a proof played, a commit, a failure.
- Never "continuing" or "received".
- `--proof` is what was really executed. `--remaining` is what is not proven. Nobody goes over it after you: what is written there is what the owner will know of the risk.
- A task on the main branch is not finished until it is delivered.
