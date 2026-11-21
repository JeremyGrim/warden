---
name: release
description: Builds a release of a project ruled by Warden from a commit of the main branch, in a tree of its own, with SHA-256 fingerprints and the signature checked when the project signs. Only the factory uses it, from the factory tree; publishing the release is the person's decision. Use it when the person asks to "build the release", "make the installer" or "package version X". French triggers include « fabrique la release », « fais l'installeur » and « prépare la version ».
---

# Build a release

Only the factory builds a release, from its tree, and only from a commit that went up through the train. Reply in the person's language.

## Before

- The project configures it in `config/factory.json`, section `release`: `build` (a command), `artifacts` (paths, `*` in the last segment), and optionally `sign` and `check_signature` (`{file}` is each artifact). With no section, say so and stop: setting it is the project's choice.
- The commit is on the remote main branch, and carries the version to release. Within the line, bump it yourself first:
  1. `node scripts/warden/version.mjs show`: the current version, the line, the next one;
  2. `node scripts/warden/version.mjs bump`: the next patch, committed on `warden/version-<x.y.z>`;
  3. `node scripts/warden/train.mjs run --agent <factory name> --with warden/version-<x.y.z>`.

  A version off the line (`0.5.0` on the `0.4` line) is refused: leaving the line is the person's decision, written in `version.line`.
- No train runs and the slot is free: one big build at a time on the workstation.

## Build

```
node scripts/warden/release.mjs build --commit <sha>
```

It:

1. refuses a commit that is not on the main branch;
2. checks the commit out in `.work/release-tree`, a worktree of its own, never the train tree;
3. removes the artifacts of an earlier release, installs (`train.install`), builds;
4. signs when `sign` is set, and checks each signature when `check_signature` is set;
5. writes `.work/releases/v<version>/`: the artifacts, `SHA256SUMS` and `release.json`, and one line to the history.

## Secrets

- The signing key stays in the workstation's environment, where the person put it. Never read it, print it, copy it, or ask for it in the conversation.
- The signing output is shown only when it fails, and written nowhere. Do not paste it into a note or a report.

## After

Report to the person, briefly:

1. the commit and the label;
2. each artifact with its SHA-256;
3. whether it was signed, and whether the signature checked;
4. what is not proven: an installer not yet installed on a clean machine, a journey not yet played on it.

Then wait. Publishing (a tag, a store, a download page, a message to users) is the person's decision, never yours. A failed release is a finding to report with its log (`build.log` in the release folder); never retry it with checks removed.
