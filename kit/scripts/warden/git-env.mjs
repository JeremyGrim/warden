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
// The guards read their messages in English, whatever the workstation locale.
process.env.WARDEN_LOCALE = 'en';
