---
name: quai-deposer
description: Dépose une branche prête au quai pour que la fabrique l'emmène sur la branche principale, dans un projet qui a le règlement de dépôt (scripts/reglement/). À utiliser quand une branche d'agent est finie et vérifiée sur son périmètre, quand on demande de « déposer », « mettre au train », ou quand un dépôt revient avec une ligne refuse.
---

# Déposer une branche au quai

Seule la fabrique pousse sur la branche principale. Un agent pousse sa branche s'il le faut, jamais la branche principale : il dépose.

## Avant de déposer

1. **Rebaser** sur la branche principale distante : `git fetch`, puis `git rebase origin/<principale>`. La branche principale est dans `config/fabrique.json` (`principale`).
2. **Contrôler son périmètre, et lui seul.** Les tests des paquets touchés, le typage de ce qu'on a touché. Ne pas fabriquer l'application, ne pas lancer clippy ni les tests de tout l'espace : c'est le travail de la fabrique.
3. **Le règlement** : `node scripts/reglement/reglement.mjs`. Zéro écart.
4. Ne commiter que ses propres fichiers. Jamais `git add -A`, jamais `--no-verify`.

## Le dépôt

Le quai est le dossier `train-pret`, voisin du créneau : `.travail/train-pret/` à la racine principale du projet (le dossier parent de `git rev-parse --path-format=absolute --git-common-dir`). Si le poste règle le créneau ailleurs (`git config reglement.creneau`), le quai est à côté de ce dossier.

Un fichier `<session>.txt`, une clé par ligne :

```
arbre    = <chemin absolu de l'arbre qui porte la branche>
branche  = <nom de la branche>
taches   = <identifiants des tâches, séparés par des virgules>
depose   = <jj/mm hh:mm>
parcours = <scénario d'épreuve, si le changement se voit à l'écran>
```

- Lire l'heure sur le poste (`date`), ne pas la deviner.
- Deux dépôts en attente au plus par agent.

## Ensuite

- La fabrique emmène quatre branches au plus par train, dans l'ordre des dépôts. Le dépôt disparaît quand la branche est montée.
- Une branche laissée de côté reçoit une ligne `refuse = <cause>`. On corrige, on rebase, on contrôle de nouveau son périmètre, puis on **retire la ligne** `refuse` : c'est ce qui remet la branche dans la file.
- Un conflit n'est jamais résolu par la fabrique à la place de l'auteur.
