---
name: preuve-dire
description: Dit si un travail est fini, preuve exécutée à l'appui, ou PAS FINI avec ce qui reste non prouvé. À utiliser avant d'annoncer qu'une tâche, un lot ou un correctif est terminé, avant un dépôt au quai ou une livraison, et chaque fois qu'on rend compte d'un résultat.
---

# Dire la preuve

Un travail est fini quand une preuve exécutée le montre. Tant qu'un écart reste ouvert, il est **PAS FINI**.

## La règle

- Une commande réussie ne prouve que ce qu'elle contrôle. Des tests verts sur une portée partielle ne prouvent pas le parcours.
- Aucun succès simulé : pas de test qui saute ce qu'il devait jouer, pas de seuil posé pour faire passer, pas de résultat deviné.
- On dit d'abord ce qui n'est pas prouvé, puis ce qui l'est.

## Le compte rendu

1. **Non prouvé** : ce qui n'a pas tourné, ce qui a tourné sur une copie ou un faux, ce qui dépend d'un réglage du poste qu'on n'a pas vu. Une ligne par point.
2. **Prouvé** : chaque preuve avec la commande ou le parcours exact qui l'a jouée, et son résultat (« 86 gardes passent », « poussée refusée par l'étape Tests du projet »).
3. **Verdict** : fini, ou **PAS FINI** avec ce qui reste.

## Ce qui compte comme preuve

- Une garde exécutée, dont on a lu la sortie.
- Un parcours joué dans la vraie application, sur une copie de ses données, avec un vrai fournisseur. Il s'arrête sur un écart, et son rapport s'écrit toujours.
- Une poussée vérifiée par le crochet, ou un train monté.

Ne comptent pas : une compilation seule pour un comportement, un test qui ne passe que sur la machine d'un autre, un « ça devrait marcher ».
