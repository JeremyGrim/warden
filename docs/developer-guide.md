# Developer Guide

## Layout

See [Architecture](architecture.md). The kit is under `kit/`, the installer and the trial under `tools/`, and the plugin parts under `skills/`, `agents/`, `hooks/` and `.claude-plugin/`.

## Changing the kit

1. Change the script and its guard together. A guard carries its own data; it never reads a host project's configuration.
2. Print text through `t('key', vars)`. Add the key to both `messages.en.mjs` and `messages.fr.mjs`, with the same placeholders.
3. A test that creates Git repositories imports `./git-env.mjs` first, and is listed in `git-env.test.mjs`.
4. A step the kit launches goes through `run()` from `config.mjs`. It never inherits `NODE_TEST_CONTEXT`, and Windows `.cmd` programs go through the shell.
5. Raise the version in `.claude-plugin/plugin.json`, the only source of the version.
6. Run `node tools/fingerprints.mjs`.
7. Run `npm test`, then `node tools/e2e.mjs`.
8. Run `claude plugin validate .` and `claude plugin validate ./.claude-plugin/marketplace.json`.

## The end-to-end trial

`node tools/e2e.mjs [--output <folder>] [--keep]` creates blank projects in a temporary folder:

- one with Rust and Node, with three crates, an app and a web folder;
- one with Node only.

On each, it installs the kit and plays:

- refused commits (lines, secret, lockfile, root);
- a boundary crossed and refused at push;
- pushes verified on their scope, and pushes refused by a test or a step;
- two trains, one with a culprit found by halves;
- the factory role, refusing a train outside its tree;
- the status an agent reads.

It writes `report.md`, `verdicts.json` and one log per command. It needs Cargo, clippy and pnpm.

## Rules of this repository

They are in [AGENTS.md](../AGENTS.md).
