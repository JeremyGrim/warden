import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests that create their own Git repositories never inherit the repository of whoever launches them. A Git hook started
// from a linked worktree exports GIT_DIR as an absolute path: an inherited `git init --bare` or commit would then write
// into the real repository (incident of 10 November 2026: `core.bare = true` in the shared .git/config, three "t"
// commits on a branch). Imported first by those tests, this module removes from their process the variables that point
// at a repository; their `git`, and the scripts they launch, only see the folders they are given.
export const REPOSITORY_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
];
for (const variable of REPOSITORY_VARIABLES) delete process.env[variable];
// Nor the workstation's global configuration (the list of projects the interface covers, warden.projects): their
// `git config --global` writes a throwaway file, which reads the real one (identity, line endings) through an include.
if (!process.env.WARDEN_TEST_GLOBAL) {
  const real = process.env.GIT_CONFIG_GLOBAL || join(homedir(), '.gitconfig');
  const tray = mkdtempSync(join(tmpdir(), 'warden-gitconfig-'));
  const file = join(tray, 'gitconfig');
  writeFileSync(file, existsSync(real) ? `[include]\n\tpath = ${real.replaceAll('\\', '/')}\n` : '');
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.WARDEN_TEST_GLOBAL = file;
  process.on('exit', () => rmSync(tray, { recursive: true, force: true }));
}
// The guards read their messages in English, whatever the workstation locale.
process.env.WARDEN_LOCALE = 'en';
