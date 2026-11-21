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
| `docs` (`dir`, `max_files`, `forbidden_names`, `forbidden_status`) | Too many documents, a dated or report-like name, a document that calls itself historical |
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
| `train.branch`, `train.dock`, `train.max_batch` | The train branch, the dock folder name, the batch size |
| `train.install` | `{ lockfile, command }`: installed again when the lockfile changes |
| `train.build` | `{ title, command }`: the build run once per trial |

## `config/disk.json`

| Key | Default |
|---|---|
| `min_free_gib` | 60 |
| `max_build_gib` | 40 |
| `max_incremental_gib` | 6 |
| `max_worktrees` | 2 |
| `max_worktree_age_days` | 7 |
| `frozen_copies` | folders that are read and never compiled (the origin of a migration) |

`config/disk.local.json` overrides them for one workstation, never committed. It also lists `roots` and `builds` measured outside the repository, and `shared_caches` (`path`, `max_gib`).

## Workstation settings

| Setting | Meaning |
|---|---|
| `git config warden.factory <path>` | The factory tree. The train runs only there |
| `git config warden.slot <folder>` | The slot folder, for a clone that is not a worktree of the main root |
| `git config warden.tasks <tool>` | The task tool, following the five-gesture contract |
| `git config warden.ghsa <clone>` | The clone of the advisory database (`WARDEN_GHSA_DATABASE` comes first) |
| `git config warden.locale en\|fr` | The display locale (`WARDEN_LOCALE` comes first) |
