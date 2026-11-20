// Les tests qui créent leurs propres dépôts git n'héritent jamais du dépôt de celui qui les lance. Un crochet de git lancé
// depuis un worktree lié exporte GIT_DIR, en chemin absolu : un `git init --bare` ou un commit hérité écrirait alors dans
// le vrai dépôt (incident du 10 novembre 2026 : `core.bare = true` dans le .git/config partagé, trois commits « t » sur
// une branche). Importé en premier par ces tests, ce module retire de leur processus les variables qui désignent un dépôt ;
// leurs `git`, et les scripts qu'ils lancent, ne voient plus que les dossiers qu'on leur donne.
export const VARIABLES_DU_DEPOT = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
];
for (const variable of VARIABLES_DU_DEPOT) delete process.env[variable];
