# Règlement du dépôt {{project}}

Une règle que rien ne vérifie reste une intention. Ce règlement est donc contrôlé par `node scripts/warden/rules.mjs`, au commit et au push, par les crochets Git de `.githooks/`. Les règles marquées **[contrôlée]** bloquent. Les autres se jugent à la relecture. Changer une règle ou un plafond passe par ce fichier et `config/rules.json`, dans un commit qui dit pourquoi.

Pour démarrer : `git config core.hooksPath .githooks` active les crochets. Le kit de `scripts/warden/` se copie tel quel : ce qui est propre au projet va dans `config/`, jamais dans ses scripts. Les commandes et les clés de configuration sont en anglais ; les messages suivent la langue du poste.

## 1. Ce qui entre dans le dépôt

- **[contrôlée]** La racine est fermée. Seuls les dossiers et fichiers listés dans `config/rules.json` y ont leur place.
- **[contrôlée]** Le dépôt contient du source et de la documentation. Jamais de build, de log, de capture, d'archive, de base de données, de PDF ni de binaire. Un fichier de plus de 512 Kio demande une exception nommée.
- **[contrôlée]** 700 lignes au plus par fichier. On découpe par responsabilité, sans compacter pour passer le contrôle. Au-delà de 650, le commit avertit sans refuser : celui qui touche le fichier le découpe.
- **[contrôlée]** Aucun secret, aucun chemin propre à une machine.
- **[contrôlée]** Un seul gestionnaire de paquets, avec un seul fichier de verrouillage.
- **[contrôlée]** `AGENTS.md` est la seule source des règles. `CLAUDE.md` ne fait qu'y renvoyer.

La matière de travail (briefs, comptes rendus, captures, exports) va dans `.input/` ou `.work/`, qui ne sont pas versionnés.

Le code étranger entre avec une raison nommée dans `config/rules.json` (`foreign_code`) et un moyen de prouver son écart avec l'amont. Il échappe aux lignes et à la taille, pas aux secrets, et on n'y corrige rien à la main.

## 2. Le dépôt parle au présent

Un document dit ce qui est vrai aujourd'hui. Ce qui ne l'est plus se corrige ou se supprime : Git garde le passé.

- **[contrôlée]** `docs/` compte 15 fichiers au plus, sans date dans le nom, sans compte rendu, brief, audit ni plan.
- **[contrôlée]** Aucun document ne se déclare historique, archivé ou informatif. Il n'a alors plus sa place ici.

## 3. L'architecture

- Le domaine ne connaît ni hôte, ni fournisseur, ni matériel ; les protocoles et les outils extérieurs restent dans leurs adaptateurs. Une frontière se contrôle en la déclarant dans `config/rules.json` (`boundaries`), et sa règle se marque **[contrôlée]** ici.
- Pas de coquille vide : un dossier existe quand il contient du vrai.
- Toute consigne destinée à un modèle vit dans une ressource versionnée, pas dans un composant d'interface.
- Rien en dur : un seuil vient du modèle, d'une ressource ou d'un budget configuré, jamais d'un chiffre posé pour faire passer.

## 4. Travailler à plusieurs

- La branche principale est la seule branche d'intégration.
- Chacun ne commite que ses propres fichiers et préserve le travail des autres, index Git compris.
- Avant de pousser : `git fetch`, avance rapide seulement, jamais de force. Si le distant a bougé, on le dit.
- Seule la fabrique pousse sur la branche principale. Un agent pousse sa branche, jamais la branche principale.
- On ne contourne pas un contrôle (`--no-verify`) : on corrige, ou on propose de changer la règle.
- **[contrôlée]** Rien ne vérifie le dépôt hors du poste. Le crochet de push joue le règlement, les gardes des scripts, puis `node scripts/warden/verify.mjs push` : ce que `config/factory.json` demande pour les fichiers que la poussée change. Le commit poussé doit être celui de l'arbre, sans modification suivie. Une seule poussée vers la branche principale à la fois sur le poste : le crochet prend le créneau (`.work/push-slot` de la racine), refuse avant toute vérification si la branche principale a bougé, et le rend quand le distant porte le commit.
- L'agent ne contrôle que ce qu'il touche. Sa branche prête se dépose dans `.work/train-ready/<session>.txt` : `tree`, `branch`, `tasks`, `docked` (`jj/mm hh:mm`), et `scenario` si le changement se voit à l'écran. Elle est rebasée sur la branche principale et verte sur son périmètre ; deux dépôts en attente au plus par agent. La fabrique conduit `node scripts/warden/train.mjs run --agent <nom>` : quatre branches au plus par lot, vérifiées ensemble, la fautive cherchée par moitiés. Une branche laissée de côté reçoit une ligne `refused =` : son auteur corrige, rebase et retire la ligne.
- Un travail est fini quand une preuve exécutée le montre, et une commande réussie ne prouve que ce qu'elle contrôle. Tant qu'un écart reste ouvert, on écrit **PAS FINI**. Aucun succès simulé. On dit d'abord ce qui n'est pas prouvé.
- Aucune restriction sans fondement : la décision du responsable du dépôt, ou « provisoire : <condition> ».
- Remplacer un chemin, c'est supprimer l'ancien.

## 5. Le disque

- On travaille dans la racine. Un arbre de travail supplémentaire reste une exception, dans les plafonds de `config/disk.json`.
- **Jamais de `target` partagé entre deux arbres**, ni par lien ni par `CARGO_TARGET_DIR` : Cargo peut alors annoncer un succès sans avoir compilé le code de l'arbre.
- Les livrables vivent hors du dépôt.
- `node scripts/warden/disk.mjs guard` avant un gros build. `clean` simule ; `--apply` reste un geste du responsable du dépôt.
