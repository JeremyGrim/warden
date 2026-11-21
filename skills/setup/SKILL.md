---
name: setup
description: Installs the Warden kit (Git hooks, rules, push verification, dock and train) in the current project, or updates it, then adapts its configuration by reading the repository. Use it when the user asks to "install Warden", "set up the rules", "update the kit", or when the session-start notice says the project kit is behind. French triggers include « pose le règlement », « installe Warden » and « mets à jour le kit ».
---

# Set up Warden in a project

The kit is copied into the project and committed with it: Git checks, for Claude, Codex, a human or the factory alike. The plugin itself checks nothing. Reply in the person's language.

The installer is `<this skill folder>/../../tools/install.mjs`. The skill folder is given at the top ("Base directory for this skill").

## Steps

1. **Read the state.** `git status`. Never install over work in progress that is not yours. If the tree is dirty, say so and ask.
2. **Dry run.** `node <this skill folder>/../../tools/install.mjs --dry-run`. Read what would be installed, kept and allowed.
3. **Install.** The same command without `--dry-run`.
   - Add `--locale fr` for French rules text (`AGENTS.md`, `CLAUDE.md`). Commands and configuration keys stay English in every locale.
   - A refusal ("edited", "unknown to the kit") writes nothing. Never force or overwrite. Tell the person the gap: it becomes a setting in `config/`, or a kit fix in the Warden repository.
4. **Adapt the configuration by reading the repository.**
   - `config/rules.json`, `root`: the installer allows what is already at the root and lists it. Review that list with the person, and move none of their files without their agreement.
   - `boundaries.rust` and `boundaries.node`: declare them only when the project's architecture already states them, in its code or its documents.
   - `config/factory.json`: the `verify.steps` (`when` holds path patterns, `command` an array), `train.build` when the project builds an application, and `verify.rust.separate` for a package tested on its own.
   - A missing section is not checked. Add nothing "just in case".
5. **The rules text.**
   - If `AGENTS.md` already existed, merge the sections of the model (`kit/AGENTS.md`, or `kit/AGENTS.fr.md`) into it, without losing the project's rules. Each **[checked]** rule matches a section of `config/rules.json`.
   - If `CLAUDE.md` carried rules, move them to `AGENTS.md`, then reduce it to the pointer.
6. **Prove.**
   - `node scripts/warden/rules.mjs` until no finding is left.
   - `node --test "scripts/**/*.test.mjs"`: the kit guards, including the hooks journey in a throwaway project.
   - If the person wants it: `node scripts/warden/verify.mjs all`, which runs every step once.
7. **Commit** only the installed and adapted files: `scripts/warden/`, `.githooks/`, `config/`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.gitattributes`. The message says why. Push only with the person's agreement.

## What you say at the end

- What is installed, the kit version, and what was adapted.
- What is not proven: a step of `config/factory.json` that never ran, or a boundary declared with no graph to read.
- That each clone turns its hooks on once: `git config core.hooksPath .githooks`. A pnpm project can put it in its `prepare` script.
- That the factory is set up with `/warden:factory-setup`.
