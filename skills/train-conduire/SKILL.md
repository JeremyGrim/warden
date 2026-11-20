---
name: train-conduire
description: Conduit le train vers la branche principale dans un projet qui a le règlement de dépôt (scripts/reglement/train.mjs). Réservé à la fabrique, le seul arbre qui pousse sur la branche principale. À utiliser quand on est désigné fabrique et qu'il faut « conduire le train », « emmener les dépôts », ou attendre des branches prêtes.
---

# Conduire le train

Une seule fabrique à la fois, dans son seul arbre. Si une autre fabrique tourne, on ne conduit pas.

## Le départ

- L'arbre de la fabrique est propre (`git status`) : le train refuse sinon.
- Voir ce qui monterait, sans rien vérifier ni pousser : `node scripts/reglement/train.mjs conduire --simuler`.
- Conduire : `node scripts/reglement/train.mjs conduire --agent <nom de la session>`.
  - `--lot N` pour un lot plus court ; `--avec <branche>` pour emmener une branche locale de la fabrique.
- Attendre une branche prête sans rien coûter : `node scripts/reglement/train.mjs veille`, qui rend la main dès qu'un dépôt arrive.

## Ce que fait le train

1. Il prend le créneau de poussée, et la priorité du processeur tant qu'il tourne.
2. Il empile les dépôts dans l'ordre, au plus `train.lot_max` (quatre par défaut). Une branche en conflit est laissée de côté, jamais résolue.
3. Chaque essai repart de la branche principale : dépendances si le verrou change, règlement et gardes des scripts, vérification des fichiers changés, fabrication une fois (`train.fabriquer`).
4. Si l'essai échoue, il cherche la fautive par moitiés. Le reste monte.
5. Il pousse, marque le commit vérifié (le crochet ne le revérifie pas), retire les dépôts montés, et note chaque tâche si un outil de suivi est réglé (`git config reglement.taches`).

## Après le train

- Lire la sortie : ce qui est monté, ce qui est laissé de côté et pourquoi.
- Les `parcours` déposés ne sont pas joués par le train : la fabrique les joue sur ce qu'elle vient de fabriquer, puis note le résultat.
- Ne jamais pousser à la main sur la branche principale pour « débloquer » : on corrige la cause, ou on la dit.
- La machine est partagée : un train à la fois, et pas de second gros build pendant qu'il tourne.
