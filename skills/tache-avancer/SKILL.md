---
name: tache-avancer
description: Tient le suivi des tâches à jour par les cinq gestes du contrat de suivi (etat, prendre, note, bloquer, livrer), dans un projet qui a branché un outil de suivi (git config reglement.taches). À utiliser au début d'une session, en prenant une tâche, après une étape qui compte, quand on est bloqué, et quand le commit est sur la branche principale.
---

# Avancer une tâche

Celui qui suit le travail lit l'outil de suivi, pas la conversation. Ce qui n'est pas écrit dans l'outil n'existe pas pour lui.

## L'outil

Le contrat de suivi tient en cinq gestes. N'importe quel outil qui les accepte convient : un script du poste, ou une commande qui parle à Linear, ClickUp ou un autre suivi.

- Il se règle par poste, jamais dans le dépôt : `git config reglement.taches <chemin ou commande>`.
- Un script Node (`.mjs`, `.cjs`, `.js`) se lance par `node <chemin>` ; un autre programme se lance tel quel.
- Sans réglage, il n'y a pas de suivi branché : le dire une fois, et ne rien inventer.

## Les cinq gestes

| Quand | Geste |
|---|---|
| On ouvre la session, ou on revient | `<outil> etat --agent <moi>` |
| On commence une tâche | `<outil> prendre <tâche> --agent <moi>` |
| Une étape qui compte est faite | `<outil> note <tâche> "<ce qui est fait>" --agent <moi>` |
| On ne peut plus avancer | `<outil> bloquer <tâche> "<ce qui bloque, qui peut débloquer>" --agent <moi>` |
| Le commit est sur la branche principale | `<outil> livrer <tâche> --commit <sha> --preuve "<…>" --reste "<…>" --agent <moi>` |

Le train écrit lui-même une note sur chaque tâche qu'il monte ou laisse de côté.

## Une note qui sert

- Une ou deux phrases, des faits, au passé : une cause établie, un choix pris, une preuve jouée, un commit, un échec.
- Pas « je continue », pas « reçu ».
- `--preuve` : ce qui a été réellement exécuté. `--reste` : ce qui n'est pas prouvé. Personne ne repasse derrière : ce qui est écrit là est ce que le responsable saura du risque.
- Une tâche sur la branche principale n'est pas finie tant qu'elle n'est pas livrée.
