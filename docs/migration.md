# Import contrôlé des jeux existants

Ne pas démarrer la rotation sur les anciens salons avant d’avoir choisi les correspondances. L’inventaire et le plan sont privés : ils peuvent contenir les IDs des membres abonnés.

## Préparation locale

```sh
pnpm build
pnpm admin doctor
pnpm admin inventory --output data/inventory.json
```

Créer `data/import-manifest.json` à partir de [l’exemple](import-manifest.example.json). Pour chaque jeu : un salon canonique, un rôle de notifications sans permissions globales, l’état cible, éventuellement l’ID RAWG vérifié et des alias. Remplacer les IDs d’exemple, vérifier la correspondance puis passer `confirmed` à `true`.

Un doublon ne doit pas apparaître comme un deuxième jeu pour la même identité. Conserver les salons secondaires et campagnes en dehors du manifeste ; aucun historique n’est déplacé ou effacé. Un rôle encore utilisé comme droit d’accès doit être dissocié avant import : par exemple, un accès à un forum privé ne doit pas devenir accidentellement un abonnement facultatif.

```sh
pnpm admin plan --manifest data/import-manifest.json --output data/import-plan.json
```

Lire `changes` et `errors`, les IDs, les états et le choix du salon. Le plan vérifie l’unicité des identités, les plafonds, la hiérarchie et les permissions globales des rôles. Il annonce la normalisation des accès aux salons sélectionnés et la désactivation des mentions libres des rôles.

Si `removeGameOptions` est `true`, l’application retirera seulement les références aux jeux importés dans les options du questionnaire. Les références sans rapport, y compris celles d’une option mixte, sont conservées ; les options devenues vides sont retirées. Vérifier ensuite manuellement les exigences générales du questionnaire Discord et les rôles sélectionnables dans les autres intégrations.

## Application explicite

Arrêter l’instance active avant toute mutation CLI :

```sh
docker compose stop bot
pnpm backup --output backups/before-import.sqlite
pnpm admin apply --plan data/import-plan.json --apply
pnpm admin doctor
```

Ces commandes locales utilisent le `.env` local et sa base locale. Pour le volume Docker, utiliser la même image et **le même volume** via `docker compose run`, en montant le répertoire de travail :

```sh
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js inventory --output /work/inventory.json
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js plan --manifest /work/import-manifest.json --output /work/import-plan.json
docker compose run --rm bot node dist/cli.js backup --output /data/before-import.sqlite
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js apply --plan /work/import-plan.json --apply
```

Le conteneur utilise l’UID 1000 : rendre le répertoire de travail accessible à cet UID. La mutation est refusée si l’état structurel de Discord a changé depuis le plan. Les changements de détenteurs des rôles ne l’invalident pas : les abonnements sont relus lors de l’application. Ne pas modifier à la main le JSON du plan ; régénérer depuis le manifeste.

L’import conserve les salons et leurs messages et reprend les abonnés du rôle. Il peut déplacer les salons sélectionnés, réécrire leurs dérogations et rendre les rôles non mentionnables. Les rôles importés ne deviennent pas automatiquement recyclables. Il ne supprime aucun salon ni rôle.

## Après import

Vérifier depuis un compte Syndiqué : lecture des jeux actifs sans rôle de jeu, invisibilité des archives, parcours d’abonnement, absence de permissions inattendues. Vérifier les admins, le bot et le questionnaire. Publier ensuite le panneau avec `setup`, puis démarrer l’instance.

Si une étape échoue, le jeu et l’opération sont conservés en révision et les modifications déjà faites ne sont pas annulées automatiquement. Corriger les permissions ou rattacher les ressources avec `/nexus-admin repair`. Refaire un inventaire et un nouveau plan pour reprendre une importation partielle. Une réapplication du même plan intégralement terminé est sans effet supplémentaire.
