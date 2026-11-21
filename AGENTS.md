# Rules of the Warden repository

This repository holds the Warden kit and the Claude Code plugin that installs it. The [README](README.md) says what it does; the [Developer guide](docs/developer-guide.md) says how to change it.

## The kit

- The kit scripts (`kit/scripts/warden/`) import only `node:*`. They run in any project that has Node and Git, with nothing to install.
- Nothing specific to a project is written in a kit script. What describes the project goes into a section of its configuration, and a missing section is not checked. What belongs to one workstation is set with `git config warden.<key>`.
- English is canonical for code, commands, configuration keys, rule identifiers and JSON. Display text goes through `t()`, with the same keys and placeholders in the English and French catalogs.
- Every script has its `node:test` guard next to it. A guard never reads the configuration of the project the kit is installed in: it carries its own data.
- A test that creates its own Git repositories imports `git-env.mjs` first, and is listed in `git-env.test.mjs`.
- A step launched by the kit never passes on a test runner's context (`NODE_TEST_CONTEXT`). A `node --test` that receives it skips everything and reports success.
- Every tooling rule keeps, in a comment, the incident it came from.
- After any change to the kit: raise the version in `.claude-plugin/plugin.json` (the only source of the version), then run `node tools/fingerprints.mjs`. The `kit.test.mjs` guard refuses a manifest that lags behind.

## The plugin

- No Claude Code hook on tool calls. The only hook runs at session start, and it says nothing when all is well.
- A skill names a gesture and uses the kit's commands. It never repeats a check Git already makes.
- The factory agent has no authority beyond the train, its own tree and its releases: no product code, no workstation change, no cleanup of another tree and no publication without the person's word.
- No person is a relay for an ordinary unblocking: a result the rules can classify says what comes next by itself.

## The repository

- 700 lines at most per file. Code, documentation and skills are in English; the French catalogs (`messages*.fr.mjs`) and the French models (`*.fr.md`) are the only French files.
- Run the guards with `npm test` before each commit, and `node tools/e2e.mjs` before each version.
- Work is done when an executed proof shows it. Otherwise write **NOT DONE**, and say first what is not proven.
