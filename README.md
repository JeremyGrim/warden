# Warden

[![Version](https://img.shields.io/badge/version-0.3.0-c71244)](CHANGELOG.md)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)](https://code.claude.com/docs/en/plugins/overview)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-none-2ea44f)](docs/architecture.md)

Warden keeps a repository in order when several AI agents and humans work on it at once.

It gives the repository one set of rules that Git itself enforces: at commit, at push, and in a merge train that only one factory drives. Claude, Codex, a human or a script all go through the same hooks, so nothing depends on watching an agent.

`warden` is the Claude Code plugin. The kit it installs runs on Node and Git alone.

## Why Warden

- **Rules checked by Git, not by trust.** A rule nothing checks is only an intention. Each rule lives in `config/rules.json` and is enforced by the pre-commit and pre-push hooks.
- **One integration path.** Agents dock their ready branches. A single factory verifies them in batches, finds a culprit by halves, and is the only one to push to the main branch.
- **Verification sized to the change.** A push runs what its files touch: clippy and tests on the touched Rust packages and their dependents, the project steps whose paths changed, and dependency checks when a lockfile moves.
- **Nothing recorded, nothing sent.** Checks read the repository, never the conversation or tool calls. No CI is needed, and advisories are compared on the workstation.
- **Zero dependencies.** The kit imports only `node:*`, and its own guards run on every push.

## Requirements

- Node.js 22 or newer
- Git
- For Rust projects: Cargo, plus `cargo-deny` for the dependency check (optional)
- For Node projects: the project's own package manager (pnpm, npm, yarn or bun)

The kit has been tried end to end on Windows with Node 24. Other systems are not proven yet.

## Install

In Claude Code:

```
/plugin marketplace add JeremyGrim/warden
/plugin install warden@warden
```

The repository is private: Claude Code clones it with the workstation's Git credentials (`gh auth login`, then `gh auth setup-git`).

Then ask the agent to set Warden up in your project. The `/warden:setup` skill installs the kit and adapts its configuration by reading the repository.

Without Claude Code, from a clone of this repository:

```bash
node tools/install.mjs <project> --dry-run
node tools/install.mjs <project>
```

The installer copies `scripts/warden/` as is, with its fingerprint manifest. It installs the missing models (`AGENTS.md`, `CLAUDE.md`, `.githooks/`, `config/`) adapted to the project, keeps the existing ones as they are, and turns the hooks on. Each clone turns its hooks on once: `git config core.hooksPath .githooks`.

## Start an agent session

```
/warden:onboard
```

The onboarding reads the real state instead of guessing it: the kit version, the hooks, the role of this tree (agent or factory), the branch, the dock and the agent's own deposits. It then reads `AGENTS.md` and names the next gesture. A new session is reminded of it by the plugin's only hook.

```bash
node scripts/warden/status.mjs --agent <session> --json
```

## The factory

The factory is a fixed agent with its own profile, its own tree and its own skills. It runs the merge train and nothing else.

```bash
git config warden.factory "<absolute path of the factory tree>"
claude --agent warden:factory
```

Once a factory tree is declared, the train refuses to run anywhere else. The factory sets itself up (`/warden:factory-setup`), runs its shift (`/warden:factory-shift`), takes each train (`/warden:train`), and watches the workstation (`/warden:factory-health`). The shared build cache, the CPU budget and the push slot are part of its setup. See the [Factory guide](docs/factory-guide.md) and [Build cache](docs/build-cache.md).

## What Warden checks

| When | What | Script |
|---|---|---|
| Commit | The rules, on the staged files, read from the index | `rules.mjs --staged` |
| Push | The rules on the whole tree, boundaries included | `rules.mjs` |
| Push | The script guards: `node --test "scripts/**/*.test.mjs"` | — |
| Push | The disk budgets, as a warning | `disk.mjs guard --warn` |
| Push | The push scope, per `config/factory.json`; the push slot to the main branch | `verify.mjs push` |
| Factory | The merge train: batches, one trial, culprit by halves | `train.mjs run` |
| On demand | Everything at once | `verify.mjs all` |

The rules cover:

- the closed root, required files, artifacts, size and line ceilings;
- secrets and machine paths, a single package manager, and a single source of rules;
- documents written in the present tense, and one version across manifests;
- Rust and Node architecture boundaries, provenance, a component registry;
- debts that only shrink, and chokepoints (texts and colours that must go through their source).

Every section is optional. See [Configuration](docs/configuration.md).

## The merge train

```text
agent branch ──▶ dock (.work/train-ready/<session>.txt) ──▶ factory train ──▶ main
                                                         │
                       slot: one push to main at a time ─┘
```

1. An agent rebases, checks its own scope, and docks its branch.
2. The factory stacks up to four branches and runs one trial: dependencies, rules, guards, verification, build.
3. If the trial fails, the factory finds the culprit by halves, sets it aside with a `refused =` line that names the failed step, and pushes the rest. When every branch fails and the main branch alone fails too, the train stops and blames nobody.

See [Merge train](docs/merge-train.md).

## Language

English is canonical for:

- code, commands and options;
- configuration keys and rule identifiers;
- file names and JSON output;
- public documentation.

Display text can be English or French. The locale is resolved in this order:

1. `WARDEN_LOCALE` (`en` or `fr`)
2. `git config warden.locale`
3. the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`, then the runtime's)
4. English

The installer writes `AGENTS.md` and `CLAUDE.md` in the resolved locale (`--locale en|fr` forces one). Skills accept English and French triggers and answer in the person's language.

## Documentation

- [User guide](docs/user-guide.md)
- [Agent guide](docs/agent-guide.md)
- [Factory guide](docs/factory-guide.md)
- [Merge train](docs/merge-train.md)
- [Build cache](docs/build-cache.md)
- [Configuration](docs/configuration.md)
- [Skills and agent](docs/skills.md)
- [Architecture](docs/architecture.md)
- [Why each rule exists](docs/rationale.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Developer guide](docs/developer-guide.md)

## Quality

```bash
npm test          # every guard of the kit, the installer and the session hook
node tools/e2e.mjs   # the end-to-end trial on blank Rust + Node and Node-only projects
claude plugin validate .
```

- Source files are limited to 700 lines.
- The kit has no dependency.
- Its fingerprint manifest refuses a kit edited in place.
- The end-to-end trial plays real repositories, real hooks, Cargo and pnpm. It covers:
  - refused commits;
  - verified and refused pushes;
  - a crossed boundary;
  - two trains, one of them with a culprit;
  - a red main branch that blames no branch;
  - an interrupted train, recovered;
  - the factory role;
  - the status an agent reads.

## License

Not licensed yet. The repository is private until a license is chosen.
