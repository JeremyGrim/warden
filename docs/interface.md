# Interface

A local page for the person: every Warden project of the workstation, what each train did, what waits for them, and the few gestures that bypass nothing. The agents and the factory never use it; they keep their commands.

## Open it

From any project that carries the kit (0.4.3 or later):

```bash
node scripts/warden/ui.mjs
```

Or, without a clone of this repository:

```bash
npx github:JeremyGrim/warden ui [<project>]
```

The command prints the address and opens it in the browser (`--no-open` prints it only, `--port <n>` picks the port). The page stays available while the command runs; Ctrl+C closes it.

## What it covers

The projects are those listed on the workstation, plus the one it is launched from:

```bash
git config --global --add warden.projects <path of the project's main root>
```

The page adds and removes them too. Removing a project from the list never touches the project. Each project is read by its own kit: a project whose kit is older says which data it cannot give ("data absent: kit 0.3.0") instead of an empty view.

| View | What it shows | Source |
|---|---|---|
| Waiting for you | Only what is the person's: a decision the factory raised; a memory halt or a check that cannot run, said after `train.halt_notice_minutes`; a release not marked published; a removable worktree or a disk budget exceeded outside the factory tree; a kit older than the plugin or than the newest kit of the workstation; hooks off in a clone | `.work/decisions/`, `status.mjs --json`, `disk.mjs report --json --quick`, `.work/releases/`, the plugin record |
| Projects | Each project: its train, its dock, its slot, its kit and hooks, its last train and how it ended | `status.mjs --json`, `.work/warden-history.jsonl` |
| Train | The train under way (batch, trial, step), or its halt (every field, what lifts it), or the last train; the slot; the dock: ready, refused, waiting, taken; the decisions of the factory: open, answered, closed | `.work/train-ready/`, `.work/decisions/` |
| History | Trains, pushes, guards, per deposit, and the measures over 7, 30 or 90 days | `.work/warden-history.jsonl`, `status.mjs --history --json` |
| Health | Disk against its budgets, trees, memory against the train's minimum; the kit, the plugin, the integrity and the hooks; the rules: each file the commit hook would refuse (a file over the line ceiling, a secret, a forbidden file) or warn of (a file near the ceiling), named, over the whole working tree, uncommitted files included (from the kit 0.4.7) | `disk.mjs report --json`, `kit.json`, the plugin record, `rules.mjs --json` |
| Version | The version, its line, its manifests; the releases and their artifacts | `version.mjs show --json`, `.work/releases/` |
| Configuration | The project's configuration, checked and deposited as a change; the workstation settings | `config/*.json`, `git config` |

Never waiting for the person: a refusal (its author fixes it), a red main branch (a deposit repairs it), an incident being retried, an interrupted train (the next one recovers it).

## Gestures

| Gesture | Command | Where |
|---|---|---|
| Dry run of a train | `train.mjs run --dry-run` | the factory tree |
| The factory's own cleanup, listed then applied | `disk.mjs clean --own [--deep] [--apply]` | the factory tree |
| The cleanup of one other tree of the clone, listed then applied | `disk.mjs clean --tree <tree> [--deep] [--apply]` | the project |
| Answer a decision of the factory | `decision.mjs answer <id> [--choice <n>] [--note <text>]` | the project |
| Deposit a change of `config/factory.json`, `rules.json` or `disk.json` | `change.mjs deposit <file> [--message <text>]`, the text written in the page on its input | the project |
| Read the version | `version.mjs show` | the project |
| Build a release of a commit of the main branch | `release.mjs build --commit <sha>` | the factory tree, slot free |
| Turn the hooks on | `git config core.hooksPath .githooks` | the clone |
| A workstation setting | `git config warden.factory\|slot\|tasks\|ghsa\|locale <value>` | the clone |
| Mark a case seen, a release published | a mark kept in the clone's Git folder (`warden-ui.json`), never committed | the clone |

The page shows the command, the tree it runs in, its output and its exit code. It never runs anything else: no real train, no merge or approval, no skipped check, no recovery or version bump (the factory does them), no removal of a worktree, no change of branch, no push, no stopped process, no publication. The hooks can only be turned on.

- **Cleaning one tree.** Only a tree of the clone, or a tree of a folder declared with `warden.agentTrees`; never the factory tree (it cleans itself), never the tree the command runs from beside it, never the workstation roots. What it removes regenerates; `--deep` removes `target` and `node_modules`. It refuses while a build runs in that tree.
- **A decision of the factory.** The factory raises a product choice it may not take (`decision.mjs raise`): a title, a question, a few options, and a file of the work folder for context. The person answers with an option, a note, or both, and may change the answer until the factory acts on it and closes the decision.
- **A change of the project configuration** goes the way every change goes. The page checks the text against the shape of the file (`change.mjs check`, `schema.mjs`): a wrong type, a missing key or a pattern that does not compile is an error and blocks; a key the kit does not read is said. The deposit commits it on a branch of its own (`warden/config-<file>-<moment>`), in a tree of its own made from the remote main branch and removed after, under the hooks, and docks it (`config-<file>.txt`). The train takes it to the main branch through every check. Nothing is pushed by the gesture, and no tree changes branch. A refused change is replaced by depositing again; a change still waiting for the train is never overwritten.

## Security

- It listens on `127.0.0.1` only, and answers only the names `127.0.0.1` and `localhost` on its port: a site that renames itself to reach it is refused.
- Its address carries a random token, after `#`; every call gives it back in a header. Another page of the browser cannot read it nor act through it.
- Its content policy loads nothing from outside: no font, script, image or measure. Its two Poppins weights are files of the kit, served by the page itself (SIL Open Font License, `ui-poppins-OFL.txt`). Nothing leaves the workstation.
- It reads files of the work folder only, never a path outside it.

## The plugin version

The kit does not carry the plugin. The plugin's session hook leaves the plugin version in the clone's Git folder (`warden-plugin.json`: the version and since when), written only when it changes; the page reads it there. Until a session of the plugin 0.4.4 or later opens in a clone, the page says it does not know, and compares the kit with the newest kit of the workstation.
