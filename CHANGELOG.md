# Changelog

## 0.2.0 - 2026-11-21

### Changed

- English is canonical: commands, options, configuration keys, rule identifiers, file names and JSON output.
  - The kit moves to `scripts/warden/`.
  - The configuration files are `config/rules.json`, `config/factory.json` and `config/disk.json`.
  - Workstation settings are `git config warden.*`.
  - The work folder is `.work/`, and the dock is `.work/train-ready/`.
- Display text is English or French. It is resolved from `WARDEN_LOCALE`, `git config warden.locale`, then the system locale. The installer writes `AGENTS.md` and `CLAUDE.md` in that locale.
- Every skill and all documentation are in English. The skills accept English and French triggers.
- The `machine path` pattern admits the fictitious person's own folder (`C:\Users\person`), and still refuses neighbouring names such as `person2` or `person.x`.

### Added

- The factory as a fixed agent, `warden:factory`, with its own skills: `factory-setup`, `factory-shift` and `factory-health`.
- `git config warden.factory` declares the factory tree. The train refuses to run anywhere else.
- `/warden:onboard`, the launch skill for every agent session, backed by `scripts/warden/status.mjs`. It reports the kit, hooks, role, branch, slot, dock, the agent's own deposits, the task tool and the shared build cache.
- The [Build cache](docs/build-cache.md) guide: the shared compiler cache, the CPU budget, and what the kit measures.
- The session hook reminds a new session to onboard.

## 0.1.0 - 2026-11-20

### Added

- The kit:
  - the rules, the Rust and Node boundaries, the push verification, the push slot;
  - the dock and the merge train, the disk guard, the train's CPU priority, and npm advisories compared on the workstation.
- The rules also cover the component registry, debts that only shrink, and chokepoints.
- The installer, with its fingerprint manifest. It refuses to overwrite an edited kit script.
- The Claude Code plugin, with five skills and one session hook.
- The end-to-end trial on blank Rust + Node and Node-only projects.

### Fixed

These issues were found while proving the kit:

- a `node --test` step no longer inherits a parent runner's context;
- machine paths with doubled separators are refused;
- the hooks stay LF on Windows clones.
