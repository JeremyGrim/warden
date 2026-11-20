# Règles du dépôt Warden

Ce dépôt porte le kit d'un règlement de dépôt et le plugin Claude Code qui le pose. Le [README](README.md) dit ce qu'il fait.

## Le kit

- Les scripts du kit (`kit/scripts/reglement/`) n'importent que `node:*`. Ils tournent dans tout projet qui a Node et Git, sans rien installer.
- Rien de propre à un projet n'est écrit dans un script du kit. Ce qui décrit le projet va dans une section de sa configuration ; une section absente ne se joue pas. Ce qui est propre au poste se règle par `git config reglement.<clé>`.
- Chaque script a sa garde en `node:test`, à côté de lui. Une garde ne lit pas la configuration du projet où le kit est posé : elle porte ses propres données.
- Un test qui crée ses propres dépôts Git importe d'abord `environnement-git.mjs`, et figure dans la garde de cet import.
- Une étape lancée par le kit ne transmet pas le contexte d'un lanceur de tests (`NODE_TEST_CONTEXT`) : un `node --test` qui le reçoit saute tout et se dit réussi.
- Chaque règle d'outillage garde en commentaire l'incident qui l'a fait naître.
- Après toute modification du kit : monter la version dans `.claude-plugin/plugin.json` (seule source de la version), puis lancer `node outils/empreintes.mjs`. La garde `kit.test.mjs` refuse un manifeste en retard.

## Le plugin

- Aucun crochet Claude Code sur les appels d'outil. Le seul crochet est celui de l'ouverture de session, et il ne dit rien quand tout va.
- Une skill dit un geste, avec les commandes du kit. Elle ne refait pas un contrôle que Git fait déjà.

## Le dépôt

- 700 lignes au plus par fichier. Les messages et les documents sont en français.
- Les gardes se jouent avec `node --test`, depuis la racine, avant chaque commit.
- Un travail est fini quand une preuve exécutée le montre. Sinon, on écrit **PAS FINI**, et on dit d'abord ce qui n'est pas prouvé.
