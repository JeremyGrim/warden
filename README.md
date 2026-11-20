# Règlement de dépôt

Un règlement de dépôt vérifié par les crochets Git, pour un projet où plusieurs agents et des humains codent ensemble. Tout ce qui commite y passe : Claude, Codex, un humain, la fabrique. Rien ne s'enregistre de la session, et rien ne part en ligne.

Le dépôt a deux étages :

1. **Le kit** (`kit/`), copié dans le projet et versionné avec lui : les scripts de `scripts/reglement/` et leurs gardes, les crochets de `.githooks/`, et les modèles de `config/`, d'`AGENTS.md` et de `CLAUDE.md`.
2. **Le plugin Claude Code**, qui porte les skills des gestes et un seul crochet, à l'ouverture de session. Il ne contrôle rien lui-même.

Il faut Node 22 ou plus et Git. Les scripts n'importent que `node:*`. Le kit est éprouvé sous Windows, avec Node 24.

## Poser le kit dans un projet

Avec Claude Code :

```
/plugin marketplace add <propriétaire>/reglement-depot
/plugin install reglement-depot@reglement-depot
```

Puis demander de poser le règlement : le skill `reglement-poser` fait la pose et adapte la configuration en lisant le dépôt.

Sans Claude Code, depuis un clone de ce dépôt :

```
node outils/poser.mjs <projet> --simuler
node outils/poser.mjs <projet>
```

La pose :

- copie `scripts/reglement/` tel quel, avec son manifeste d'empreintes `kit.json` ;
- pose les modèles qui manquent, adaptés au projet : la racine admet ce qui y est déjà, et la fabrique prend Rust, le gestionnaire npm et les scripts `test` et `build` ;
- garde tel quel un modèle déjà là ;
- ajoute `.travail/` et `.input/` à `.gitignore`, garde les crochets en LF par `.gitattributes`, crée `.travail/` et active les crochets (`core.hooksPath .githooks`).

Un script du kit retouché dans le projet, ou un fichier inconnu du kit dans `scripts/reglement/`, arrête la pose sans rien écrire. L'écart devient un réglage de `config/`, ou un correctif du kit ici.

Chaque clone active ses crochets une fois : `git config core.hooksPath .githooks`.

## Ce que le kit contrôle

| Quand | Quoi | Script |
|---|---|---|
| Au commit | Le règlement, sur les fichiers indexés, lus dans l'index | `reglement.mjs --index` |
| Au push | Le règlement sur tout l'arbre, frontières comprises | `reglement.mjs` |
| Au push | Les gardes des scripts : `node --test "scripts/**/*.test.mjs"` | — |
| Au push | Le disque, en avertissement | `disque.mjs garde --avertir` |
| Au push | Le périmètre de la poussée, selon `config/fabrique.json` ; le créneau vers la branche principale | `verifier.mjs poussee` |
| À la demande | Le train : lots de branches déposées, vérifiés ensemble, la fautive cherchée par moitiés | `train.mjs conduire` |
| À la demande | Tout le dépôt | `verifier.mjs tout` |

### `config/reglement.json`

Chaque section est facultative : une section absente ne se joue pas.

| Section | Ce qu'elle refuse |
|---|---|
| `racine` | Un dossier ou un fichier de la racine qui n'est pas listé |
| `obligatoires` | Un fichier obligatoire absent |
| `segments_interdits`, `extensions_interdites` | Un artefact versionné : build, dépendances, archive, binaire… |
| `taille_max_kio`, `taille_exceptions` | Un fichier trop gros, sauf exception par chemin |
| `lignes_max`, `lignes_avertissement`, `lignes_exemptes` | Un fichier trop long ; au-delà de l'avertissement, le commit prévient sans refuser |
| `gestionnaires_interdits` | Un second gestionnaire de paquets |
| `secrets`, `secrets_exceptions` | Une clé, un jeton ou un chemin de machine. L'exception se donne par chemin et par type, avec sa raison |
| `code_etranger` | Rien : le code étranger nommé échappe aux lignes et à la taille, pas aux secrets |
| `source_unique` | Un `CLAUDE.md` qui porte des règles au lieu de renvoyer à `AGENTS.md` |
| `docs` | Dans `docs/` : trop de fichiers, un nom daté ou de compte rendu, un document qui se dit historique |
| `versions` | Deux manifestes qui disent deux versions (`json:<clé>`, `toml:<table.clé>`) |
| `frontieres.rust`, `frontieres.node` | Une zone qui atteint une zone ou un paquet interdit, même de loin. Une exception `sauf` ne fait que raccourcir |
| `binaire_de_test_unique` | Plus d'un binaire de test d'intégration par crate |
| `provenance` | Un élément d'une zone sans origine déclarée, ou une origine déclarée sans élément |
| `registre` | Un composant sans catégorie au registre, ou un nom du registre absent du dépôt |
| `dettes` | Un fichier d'une dette hors de son fichier unique ; avec `ne_grandit_pas`, ce fichier qui grandit au commit |
| `passages` | Ce qui doit passer par sa source (un texte d'interface, une couleur) écrit en dur dans sa zone |

### `config/fabrique.json`

- `principale`, `distant` : la branche d'intégration et son distant.
- `creneau` : le nom du dossier du créneau, et un registre facultatif où s'écrit la reprise d'un créneau abandonné.
- `verification` :
  - `rust` : `entier` (les motifs qui vérifient tout l'espace), `clippy`, `tests`, `a_part` (un paquet testé à part, avec ses arguments), `deny` (le fichier de `cargo deny`).
  - `avis_npm` : le verrou pnpm comparé, sur le poste, à un clone de la GitHub Advisory Database.
  - `etapes` : `{ titre, si, commande, inchanges }`. `si` liste des motifs de chemins ; `inchanges`, des chemins que la commande ne doit pas changer (des fichiers générés).
  - `tout` : les étapes en plus pour `verifier.mjs tout`.
- `train` : `branche`, `lot_max`, `installer` (`{ verrou, commande }`), `fabriquer` (`{ titre, commande }`).

### Ce qui est propre au poste

Ces réglages ne se versionnent jamais : `git config reglement.<clé>`.

- `reglement.creneau` : le dossier du créneau, pour un clone qui n'est pas un arbre de la racine.
- `reglement.taches` : l'outil de suivi des tâches, qui suit le contrat de cinq gestes (skill `tache-avancer`).
- `reglement.ghsa` : le clone de la base des avis npm. La variable `REGLEMENT_GHSA_DATABASE` passe devant.
- `config/disque.local.json` : les plafonds du disque propres au poste.

## Le quai et le train

Un agent dépose sa branche prête dans `.travail/train-pret/<session>.txt` (skill `quai-deposer`). La fabrique, seul arbre qui pousse sur la branche principale, conduit le train (skill `train-conduire`) :

1. elle empile au plus quatre branches ;
2. elle joue une fois les dépendances, le règlement, les gardes, la vérification et la fabrication ;
3. elle cherche la fautive par moitiés, puis pousse.

Une branche laissée de côté reçoit une ligne `refuse =`.

## Les skills

| Skill | Pour |
|---|---|
| `reglement-poser` | Poser ou mettre à jour le kit, et adapter sa configuration |
| `quai-deposer` | Déposer une branche prête |
| `train-conduire` | Conduire le train ; la fabrique seulement |
| `tache-avancer` | Tenir le suivi des tâches par cinq gestes, si un outil est branché |
| `preuve-dire` | Dire fini, preuve à l'appui, ou PAS FINI avec ce qui reste |

## Mettre à jour le kit

Ici :

1. modifier le kit ;
2. monter la version dans `.claude-plugin/plugin.json` ;
3. `node outils/empreintes.mjs` ;
4. `node --test`, qui joue les gardes du kit, de la pose et du crochet.

Dans un projet, reposer le kit : un script non retouché est remplacé, et celui qu'une version ne pose plus est retiré.

## Pas encore là

- La coque d'épreuve de parcours. Pour l'instant, la méthode et le contrat de scénario vivent dans le skill `preuve-dire`.
- Le lieu d'essai, la préversion, et la livraison depuis un clone propre avec son empreinte.
- Un adaptateur de frontières pour un autre langage que Rust et Node.
