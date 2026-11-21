# Security

## What Warden reads and sends

- **It reads the repository**: tracked and untracked non-ignored files, the index, and `cargo metadata`.
- **It never reads** the conversation, the agent's tool calls, or anything outside the project and the workstation settings it names.
- **Nothing leaves the workstation**:
  - no CI is involved;
  - the npm advisories are compared to a local clone of the public GitHub Advisory Database;
  - `cargo deny` downloads the public RustSec database and compares it locally.
- **No telemetry.**
- **The interface** (`ui.mjs`) listens on 127.0.0.1 only, answers only its own names, and asks every call for the random token of its address. Its content policy loads nothing from outside; it reads the work folder only, and runs only the gestures of [Interface](interface.md). A configuration change made from the page is committed under the hooks and docked for the train: the page pushes nothing.

## Secrets

- The `secrets` section of `config/rules.json` refuses private keys, GitHub, Anthropic, OpenAI and Slack tokens, AWS keys, and machine paths (a real user folder). Separators may be single or doubled.
- An exception names one path and one kind, with its reason. Foreign code escapes the line and size ceilings, never the secret check.
- Workstation settings (`git config warden.*`, `config/disk.local.json`) hold paths, never secrets, and are never committed.

## The plugin

- The only hook runs at session start. It reads the project's `kit.json` and `core.hooksPath`, and prints at most three lines. It writes one file, the plugin version, in the clone's Git folder (`warden-plugin.json`), when that version changes.
- There is no hook on tool calls, and nothing is recorded from the session.
- The factory agent has no authority to change the workstation configuration or to clean the disk without the person's word.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
