# Architecture

## Two layers

```text
warden (this repository)
├── kit/                       copied into each project, committed with it
│   ├── scripts/warden/        the scripts, their guards, kit.json (fingerprints)
│   ├── .githooks/             pre-commit, pre-push (models)
│   ├── config/                rules.json, factory.json, disk.json, deny.toml (models)
│   └── AGENTS.md, CLAUDE.md   rule text models, English and French
├── tools/                     install.mjs, fingerprints.mjs, e2e.mjs
├── skills/                    the Claude Code skills
├── agents/factory.md          the factory profile
├── hooks/                     the session-start hook
└── .claude-plugin/            plugin.json, marketplace.json
```

1. **The kit** lives in each project. Codex, a human and the factory go through Git, not through Claude Code, so the checks must live where Git runs them.
2. **The plugin** carries the skills, the factory agent and one session hook. It checks nothing itself.

## The kit

| Script | Role |
|---|---|
| `rules.mjs`, `checks.mjs`, `boundaries.mjs` | The rules; the per-file and tree checks; the Rust and Node boundary adapters |
| `verify.mjs` | The push verification, `all`, the slot keep-alive and release |
| `slot.mjs` | The push slot |
| `train.mjs` | The dock and the train |
| `status.mjs` | The state an agent or the factory reads |
| `disk.mjs`, `priority.mjs` | Disk budgets and cleaning; CPU priority during a train |
| `npm-audit.mjs` | npm advisories against a local database clone |
| `config.mjs`, `messages*.mjs` | Reading the project configuration and workstation settings; display text in English and French |
| `git-env.mjs`, `kit.mjs` | Test isolation from an inherited `GIT_DIR`; the fingerprints |

Design rules:

- Only `node:*` imports.
- Every script has a `node:test` guard next to it. The guards carry their own data and never read the host project's configuration, so they pass in any project.
- Nothing project-specific in a script: configuration sections, or workstation settings.
- A missing section is not checked.
- Each source file stays under 700 lines.

## Fingerprints and updates

The kit is copied as is. `kit.json` gives the version and the SHA-256 of each file, line endings normalised. `kit.test.mjs` refuses an edited, added or missing file on every push.

The installer replaces an unedited file and removes one a previous version installed. It refuses, writing nothing, when a file was edited or is unknown to the kit. A project need becomes a configuration option, or a fix here.

## Machine output and locale

- Rule identifiers, configuration keys, commands and `status.mjs --json` are canonical English.
- Display text goes through `messages.mjs`, with an English catalog and a French one. The `messages.test.mjs` guard checks that both catalogs have the same keys and placeholders.
- Scripts and agents rely on identifiers and JSON, never on display text.
