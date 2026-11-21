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
| Waiting for you | Only what is the person's: a memory halt or a check that cannot run, said after `train.halt_notice_minutes`; a release not marked published; a removable worktree or a disk budget exceeded outside the factory tree; a kit older than the newest of the workstation; hooks off in a clone | `status.mjs --json`, `disk.mjs report --json --quick`, `.work/releases/` |
| Projects | Each project: its train, its dock, its slot, its kit and hooks, its last train and how it ended | `status.mjs --json`, `.work/warden-history.jsonl` |
| Train | The train under way (batch, trial, step), or its halt (every field, what lifts it), or the last train; the slot; the dock: ready, refused, waiting, taken | `.work/train-ready/` |
| History | Trains, pushes, guards, per deposit, and the measures over 7, 30 or 90 days | `.work/warden-history.jsonl`, `status.mjs --history --json` |
| Health | Disk against its budgets, trees, memory against the train's minimum; the kit, its integrity and the hooks | `disk.mjs report --json`, `kit.json` |
| Version | The version, its line, its manifests; the releases and their artifacts | `version.mjs show --json`, `.work/releases/` |
| Configuration | The project's configuration, read only; the workstation settings | `config/*.json`, `git config` |

Never waiting for the person: a refusal (its author fixes it), a red main branch (a deposit repairs it), an incident being retried, an interrupted train (the next one recovers it).

## Gestures

| Gesture | Command | Where |
|---|---|---|
| Dry run of a train | `train.mjs run --dry-run` | the factory tree |
| The factory's own cleanup, listed then applied | `disk.mjs clean --own [--deep] [--apply]` | the factory tree |
| Read the version | `version.mjs show` | the project |
| Build a release of a commit of the main branch | `release.mjs build --commit <sha>` | the factory tree, slot free |
| Turn the hooks on | `git config core.hooksPath .githooks` | the clone |
| A workstation setting | `git config warden.factory\|slot\|tasks\|ghsa\|locale <value>` | the clone |
| Mark a case seen, a release published | a mark kept in the clone's Git folder (`warden-ui.json`), never committed | the clone |

The page shows the command, the tree it runs in, its output and its exit code. It never runs anything else: no real train, no merge or approval, no skipped check, no recovery or version bump (the factory does them), no cleanup of another tree, no change of branch, no push, no stopped process, no publication. The hooks can only be turned on. A change of the project configuration goes through a deposit like any change; the page shows it read only.

## Security

- It listens on `127.0.0.1` only, and answers only the names `127.0.0.1` and `localhost` on its port: a site that renames itself to reach it is refused.
- Its address carries a random token, after `#`; every call gives it back in a header. Another page of the browser cannot read it nor act through it.
- Its content policy loads nothing from outside: no font, script, image or measure. Nothing leaves the workstation.
- It reads files of the work folder only, never a path outside it.

## Not yet in Warden

- The decisions the factory brings back to the person are free text in `.work/factory-log.md`: the page does not list them.
- The plugin version is unknown to the kit: a kit is compared with the newest kit of the workstation.
- Cleaning another tree alone: `disk.mjs clean --root` also cleans the tree it runs in and the workstation roots.
- Changing the project configuration from the page: the command that would write it in a tree of its own and dock it does not exist yet.
