# User Guide

## Mental model

```text
Project ── rules (config/rules.json, AGENTS.md)
   │
   ├── agents ── branch ──▶ dock ──┐
   │                               ├──▶ factory ── train ──▶ main branch
   └── push hook ── slot ──────────┘
```

- The **rules** say what may enter the repository. Git hooks enforce them on everyone.
- **Agents** work on their own branches and dock them when ready.
- The **factory** is the only one that pushes to the main branch, in trains.
- The **slot** lets one push to the main branch at a time on a workstation.

## Install in a project

```bash
node tools/install.mjs <project> --dry-run   # what would be installed, kept, allowed
node tools/install.mjs <project>
```

or, in Claude Code, `/warden:setup`.

The installer:

- copies `scripts/warden/` with its manifest `kit.json`;
- writes `config/rules.json`, `config/factory.json` and `config/disk.json` when they are missing, adapted to the project:
  - the root allows what is already there, and lists it for review;
  - the lockfile present names the package manager;
  - Rust and the `test` and `build` scripts become verification steps;
- writes `.githooks/pre-commit` and `.githooks/pre-push`, plus `AGENTS.md` and `CLAUDE.md` in the resolved locale;
- adds `.work/` and `.input/` to `.gitignore`, and keeps the hooks LF through `.gitattributes`;
- sets `core.hooksPath` to `.githooks`, unless another hooks folder is already set.

Then review the configuration, run the rules, and commit:

```bash
node scripts/warden/rules.mjs
node --test "scripts/**/*.test.mjs"
git add scripts/warden .githooks config AGENTS.md CLAUDE.md .gitignore .gitattributes
git commit -m "Repository rules, checked by Warden"
```

## Daily use

| You want to | Run |
|---|---|
| Know where this tree stands | `node scripts/warden/status.mjs` |
| Check the rules now | `node scripts/warden/rules.mjs` |
| Verify everything once | `node scripts/warden/verify.mjs all` |
| Dock a ready branch | write `.work/train-ready/<session>.txt` (see [Merge train](merge-train.md)) |
| Run a train (factory only) | `node scripts/warden/train.mjs run --agent <name>` |
| See the disk | `node scripts/warden/disk.mjs report` |
| Clean what regenerates | `node scripts/warden/disk.mjs clean` (dry run), then `--apply` |

## Update the kit

Install again from a newer Warden:

- an unedited kit script is replaced;
- a script a previous version installed and this one no longer does is removed;
- an edited script stops the install, writing nothing.

The models (`config/`, `AGENTS.md`, hooks) are never overwritten.

## Change a rule

A rule changes in two places in one commit: its text in `AGENTS.md` and its data in `config/rules.json`. The commit message says why. A ceiling raised "to make it pass" is not a reason.
