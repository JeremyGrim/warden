# Configuration

Nothing that describes a project is written in a kit script. The project describes itself in three committed files; what belongs to one workstation is set with `git config warden.<key>` and is never committed. Every section is optional: a missing section is not checked.

## `config/rules.json`

| Section | What it refuses |
|---|---|
| `root` (`dirs`, `files`) | A root folder or file that is not listed |
| `required` | A required file that is missing |
| `forbidden_segments`, `forbidden_extensions` | A committed artifact: build, dependencies, archive, binary… |
| `max_size_kib`, `size_exceptions` | A file too big, except a named path |
| `max_lines`, `warn_lines`, `lines_exempt` | A file too long; past `warn_lines` the commit warns without refusing |
| `forbidden_lockfiles` | A second package manager |
| `secrets` (`name`, `pattern`), `secret_exceptions` | A key, a token or a machine path. An exception names a path and a kind, with its reason |
| `foreign_code` | Nothing: named foreign code escapes lines and size, not secrets |
| `single_source` (`file`, `points_to`, `max_lines`) | A `CLAUDE.md` that carries rules instead of pointing to `AGENTS.md` |
| `docs` (`dir`, `max_files`, `forbidden_names`, `forbidden_status`) | Too many documents, a dated or report-like name, a document that calls itself historical. Not in the model since 0.4.0: add it when the project wants it (example below) |
| `versions` (`file`, `read`) | Two manifests that state two versions. `read` is `json:<key.key>` or `toml:<table.key>` |
| `boundaries.rust`, `boundaries.node` | A zone that reaches a forbidden zone or package, even transitively |
| `single_test_binary` (`zones`) | More than one integration test binary per crate |
| `provenance` (`file`, `zones`) | An element with no declared origin, or a declared origin with no element |
| `registry` (`file`, `zones`) | A component with no category, or a registry name absent from the repository |
| `debts` (`name`, `root`, `pattern`, `file`, `must_not_grow`) | A debt file outside its single file; with `must_not_grow`, that file growing at commit |
| `chokepoints` (`name`, `zones`, `extensions`, `pattern`, `message`, `exceptions`) | What must go through its source (an interface text, a colour) written inline in its zone |

A boundary rule:

```json
"boundaries": {
  "rust": {
    "crates": {
      "forbidden_zones": ["modules", "apps"],
      "forbidden_packages": ["tauri*"],
      "forbidden_direct": [{ "package": "platform", "reason": "provider rules stay in their adapter", "except": ["legacy-module"] }]
    }
  },
  "node": { "packages": { "forbidden_zones": ["apps"] } }
}
```

An `except` list only shrinks: an exception that no longer serves is refused.

The `docs` doctrine, as the repository Warden comes from checks it:

```json
"docs": {
  "dir": "docs/",
  "max_files": 15,
  "forbidden_names": ["^(CR|BRIEF|AUDIT|PLAN|SPEC|REPORT|HANDOFF|MINUTES|PROGRESS)[-_ .]", "\\d{8}", "\\d{4}-\\d{2}-\\d{2}"],
  "forbidden_status": "status\\s*:\\s*\\**\\s*(archiv|histor|informational|obsolete|deprecated|superseded)"
}
```

A tool folder such as `.claude` or `.agents` is allowed by the model since 0.4.0: Claude Code invites you to commit `.claude/settings.json`. Add the segment to `forbidden_segments` if your repository keeps it out.

The `secrets` model admits one fictitious user name in test paths: `person`, its own folder included (`C:\Users\person`, `/home/person/`). Neighbouring names such as `person2` or `person.x` are refused. Change the name in the `machine path` pattern if your tests use another one.

## `config/factory.json`

| Key | Meaning |
|---|---|
| `main_branch`, `remote` | The integration branch and its remote |
| `work_dir` | The folder at the main root that holds the slot and the dock (`.work`) |
| `slot.name`, `slot.log` | The slot folder name, and an optional log file next to it |
| `verify.rust` | `full_on` (patterns that verify the whole workspace), `clippy`, `tests`, `separate` (a package tested on its own, with its `args`), `deny` (the `cargo deny` configuration) |
| `verify.npm_advisories` | `lockfile`: the pnpm lockfile compared to a local clone of the GitHub Advisory Database |
| `verify.steps` | `{ title, when, command, unchanged }`: `when` lists path patterns, `command` is an array, `unchanged` lists paths the command must not change (generated files) |
| `verify.all` | Extra steps for `verify.mjs all` |
| `verify.when_missing` | What a check asked for and not run does (a tool absent, no advisory database): `record` (default) lets the commit go, recorded as not verified on it; `block` makes it wait. Never counted as passed |
| `verify.transient_patterns` | Extra patterns of workstation incidents, read line by line: a step that fails with one is replayed once (see [merge-train.md](merge-train.md#classes)) |
| `train.branch`, `train.dock`, `train.max_batch` | The train branch, the dock folder name, the batch size (4) |
| `train.install` | `{ lockfile, command }`: installed again when the lockfile changes |
| `train.build` | `{ title, command }`: the build run once per trial |
| `train.min_free_memory_gib` | Below this memory free to commit, the train halts and `watch` waits for it (8) |
| `train.memory_per_job_gib` | The memory a build job may take: the train's jobs are bounded by it (2) |
| `train.retry_minutes` | A train halted by an incident tries again this long after the latest train that met it, or sooner when the dock changes (10) |
| `train.halt_notice_minutes` | Past this delay since the halt began, `watch` says it once, with exit code 75 (30) |
| `version.line` | The version line the factory bumps within, as a string (`"0.4"`). Absent: the current major.minor. Leaving it is the person's decision, by changing this key |
| `version.files` | The manifests that carry the version, `{ file, read }` as in `versions` of `config/rules.json`. Absent: `versions` of the rules, else `package.json`, `Cargo.toml` and `.claude-plugin/plugin.json` |
| `history.keep_days` | The local history keeps this many days once it passes 512 KiB (90) |
| `release` | `build` (a command), `artifacts` (paths, `*` in the last segment), optional `sign` (a command) and `check_signature` (a command where `{file}` is each artifact). See [factory-guide.md](factory-guide.md#release) |
| `fixes` | What the factory may commit itself, on its own branch: `version`, `lock`, `generated`, `lint`. Default: the first three |

Every default comes from one workstation: size them for yours.

## Checking and depositing a change

`config/factory.json`, `config/rules.json` and `config/disk.json` have a shape the kit checks (`schema.mjs`): a wrong type, a missing required key, a version line that is not a string, a pattern that does not compile, an option outside its values. A key the kit does not read is said as a remark, never refused: it changes nothing, so a misspelt key would silently change nothing. Keys starting with `$` or `_` are comments.

```bash
node scripts/warden/change.mjs check   config/factory.json --from <new text>
node scripts/warden/change.mjs deposit config/factory.json --from <new text> --message "Train: batches of 6"
```

Without `--from`, the text is read from the standard input. `deposit` checks the text, refuses while the hooks are off, while a change of the same file waits for the train, or when the text is already that of the remote main branch. It then commits the file on a branch of its own, `warden/config-<file>-<moment>`, in a tree of its own made from the remote main branch and removed after, under the hooks, and docks `config-<file>.txt`. The train takes it to the main branch through every check; nothing is pushed by the command, and no tree changes branch. A refused change is replaced by depositing again. The interface runs the same command from its configuration view.

## `config/disk.json`

| Key | Default |
|---|---|
| `min_free_gib` | 60 |
| `max_build_gib` | 40 |
| `max_incremental_gib` | 6 |
| `max_worktrees` | 2 (the factory tree never counts) |
| `max_worktree_age_days` | 7 |
| `frozen_copies` | folders that are read and never compiled (the origin of a migration) |

`config/disk.local.json` overrides them for one workstation, never committed. It also lists `roots` and `builds` measured outside the repository, and `shared_caches` (`path`, `max_gib`).

## Workstation settings

| Setting | Meaning |
|---|---|
| `git config warden.factory <path>` | The factory tree. The train runs only there |
| `git config --add warden.agentTrees <folder>` | A folder that holds agent trees outside the clone's worktrees: their builds go to low priority during a train |
| `git config warden.slot <folder>` | The slot folder, for a clone that is not a worktree of the main root |
| `git config warden.tasks <tool>` | The task tool, following the five-gesture contract |
| `git config warden.ghsa <clone>` | The clone of the advisory database (`WARDEN_GHSA_DATABASE` comes first) |
| `git config warden.locale en\|fr` | The display locale (`WARDEN_LOCALE` comes first) |
| `git config --global --add warden.projects <path>` | A project the interface covers, by its main root; one value per project, common to every clone of the workstation |

Two files of the clone's Git folder are written for the interface, never committed: `warden-ui.json`, the marks the person keeps (a case seen, a release published), and `warden-plugin.json`, the plugin version the plugin's session hook saw, written when it changes.
