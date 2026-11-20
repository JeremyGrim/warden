---
name: reglement-poser
description: Pose le règlement de dépôt (kit de crochets Git, règlement, vérification de poussée, quai et train) dans le projet courant, ou le met à jour, puis adapte sa configuration en lisant le dépôt. À utiliser quand on demande de « poser le règlement », « installer le kit », « mettre à jour le kit », ou quand l'ouverture de session dit que le kit du projet est en retard.
---

# Poser le règlement

Le kit se copie dans le projet et se versionne avec lui : c'est Git qui contrôle, pour Claude, Codex, un humain ou la fabrique. Ce plugin ne contrôle rien lui-même.

L'outil de pose est `<dossier de ce skill>/../../outils/poser.mjs`. Le dossier de ce skill est donné en tête (« Base directory for this skill »).

## Les étapes

1. **Lire l'état.** `git status` : on ne pose rien par-dessus un travail en cours qui n'est pas le sien. Si l'arbre est sale, le dire et demander.
2. **Simuler.** `node <dossier de ce skill>/../../outils/poser.mjs --simuler`. Lire ce qui serait posé, gardé et admis.
3. **Poser.** La même commande sans `--simuler`.
   - Un refus (« retouché », « inconnu du kit ») n'écrit rien. Ne jamais forcer ni écraser. Dire l'écart à la personne : il devient un réglage dans `config/`, ou un correctif du kit dans le dépôt du plugin.
4. **Adapter la configuration en lisant le dépôt.**
   - `config/reglement.json`, `racine` : l'outil admet ce qui est déjà à la racine et le liste. Relire cette liste avec la personne. Ne déplacer aucun de ses fichiers sans son accord.
   - Les frontières (`frontieres.rust`, `frontieres.node`) : les déclarer seulement si l'architecture du projet les dit déjà, dans son code ou ses documents.
   - `config/fabrique.json` : les étapes (`si` : des motifs de chemins, `commande` : un tableau), `train.fabriquer` si le projet construit une application, `verification.rust.a_part` pour un paquet qui se teste à part.
   - Une section absente ne se joue pas. Ne rien ajouter « au cas où ».
5. **Les règles.**
   - `AGENTS.md` existait : y reporter les sections du modèle (`kit/AGENTS.md` du plugin) sans perdre les règles du projet. Chaque règle marquée **[contrôlée]** correspond à une section de `config/reglement.json`.
   - `CLAUDE.md` portait des règles : les reporter dans `AGENTS.md`, puis le réduire au renvoi.
6. **Prouver.**
   - `node scripts/reglement/reglement.mjs` jusqu'à zéro écart.
   - `node --test "scripts/**/*.test.mjs"` : les gardes du kit, dont le parcours des crochets dans un projet jetable.
   - Si la personne le veut : `node scripts/reglement/verifier.mjs tout`, qui joue toutes les étapes une fois.
7. **Commiter** seulement les fichiers posés et adaptés : `scripts/reglement/`, `.githooks/`, `config/`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`. Le message dit pourquoi. Pousser seulement avec l'accord de la personne.

## Ce qu'on dit à la fin

- Ce qui est posé, la version du kit, et ce qui a été adapté.
- Ce qui n'est pas prouvé : une étape de `config/fabrique.json` qui n'a jamais tourné, une frontière déclarée sans graphe à lire.
- Chaque clone active ses crochets une fois : `git config core.hooksPath .githooks`. Un projet pnpm peut le mettre dans son script `prepare`.
