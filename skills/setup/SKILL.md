---
name: setup
description: Installs the Warden kit (Git hooks, rules, push verification, dock and train) in the current project, or updates it, adapts its configuration by reading the repository, and takes it to the main branch in one pass. Use it when the user asks to "install Warden", "set up the rules", "update the kit", or when the session-start notice says the project kit is behind. French triggers include « pose le règlement », « installe Warden » and « mets à jour le kit ».
---

# Set up Warden in a project

The kit is copied into the project and committed with it: Git checks, for Claude, Codex, a human or the factory alike. The plugin itself checks nothing. Reply in the person's language.

The installer is `<this skill folder>/../../tools/install.mjs`. The skill folder is the folder of this `SKILL.md`: Claude Code gives it at the top ("Base directory for this skill"), Codex lists it with the skill.

**One pass.** Asking for the install is asking for all of it: installed, adapted, proven, committed and pushed, in the same turn. What the repository already holds (an advisory, a long file, a secret pattern in a test, manifests that disagree, a build that fails) is never a reason to stop: Warden names it as a debt, and only what is new refuses. Never edit a product file to make Warden pass. Ask the person only what is theirs alone, at most once, at the end.

## Steps

1. **Read the state.** `git status`. Work that is not yours in progress: say so and ask, it is the one question that comes first. A clean tree: go on.
2. **Install.** `node <this skill folder>/../../tools/install.mjs` (`--locale fr` for French rules text in `AGENTS.md` and `CLAUDE.md`; commands and keys stay English).
   - A refusal ("edited", "unknown to the kit") writes nothing. Never force. Tell the person the gap: a setting in `config/`, or a kit fix in the Warden repository.
   - At adoption (the configuration not yet on the remote main branch), the installer names what the repository already holds, where each check reads it: the advisories in `config/deny.toml` and `verify.npm_advisories.ignore`; the files over the lines or the size and the secret patterns in `config/rules.json`, listed under `_adopted`; manifests that disagree leave the single-version rule out; a project step that fails today is left out. Read what it says and pass it on. A possible key it names is for the person to check, and revoke if real: say it plainly.
3. **Adapt the configuration by reading the repository.**
   - `config/rules.json`, `root`: the installer allows what is already at the root and lists it. Keep it; moving the person's files is theirs to decide.
   - `boundaries.rust` and `boundaries.node`: only when the project's architecture already states them, in its code or its documents.
   - `config/factory.json`: the `verify.steps` (`when` holds path patterns, `command` an array), `train.build` when the project builds an application, `verify.rust.separate` for a package tested on its own. A missing section is not checked: add nothing "just in case".
4. **Each step is tried once on the repository as it stands.** The installer tried the steps it declared, after installing the dependencies, and left out those that fail today, under `_adopted.failing` in `config/factory.json`, with their first error. Do the same for a step you add and for `train.build`: run its command once; a step that fails today is not declared yet, it goes to `_adopted.failing` and is named to the person as a debt to repair. Declared, it would refuse every push and halt every train for what nobody brought.
5. **The rules text.**
   - If `AGENTS.md` already existed, merge the sections of the model (`kit/AGENTS.md`, or `kit/AGENTS.fr.md`) into it, without losing the project's rules. Each **[checked]** rule matches a section of `config/rules.json`.
   - If `CLAUDE.md` carried rules, move them to `AGENTS.md`, then reduce it to the pointer.
6. **Prove.**
   - `node scripts/warden/rules.mjs`: no finding left.
   - `node scripts/warden/guards.mjs --all`: the kit guards, including the hooks journey in a throwaway project.
   - An update from a kit before 0.4.0: the pre-push hook left as that kit wrote it is replaced; a hook the project changed is kept, and must call `node scripts/warden/guards.mjs` in place of `node --test "scripts/**/*.test.mjs"`.
7. **Commit and push.** Commit only the installed and adapted files: `scripts/warden/`, `.githooks/`, `config/`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.gitattributes`. Then push, through the hooks, never with `--no-verify`:
   - no factory declared yet: on the main branch, from the main root. The kit is the project's first rule; there is no dock to go through yet;
   - a factory declared: dock it (`/warden:dock`), the train takes it up.
   - A refused push names what refused. Something the project already held that the installer did not name: name it the same way (with its reason, under `_adopted`), commit, push again. Something your install brought: fix it. Stop only on what the person alone can decide.
8. **The factory.** When the person named this session the factory, or asked for one, follow the `factory-setup` skill now, in the same turn.

## What you say at the end

- What is installed, the kit version, and that it is on the main branch (the commit).
- The debts it named, by kind and count, and the failing steps left out: each is a debt to repay, then to remove from `_adopted`.
- What is not proven: a step that never ran, a boundary declared with no graph to read.
- That the project is on the workstation's interface (the installer lists it: `npx github:JeremyGrim/warden ui`). If the installer said it could not, give the person its command.
- That each other clone turns its hooks on once: `git config core.hooksPath .githooks`. A pnpm project can put it in its `prepare` script.
- At most one question, if one is left that only the person can answer.
