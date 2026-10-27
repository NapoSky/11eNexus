# Import contrôlé des jeux existants

Ne pas démarrer la rotation sur les anciens salons avant d’avoir choisi les correspondances. L’inventaire et le plan sont privés : ils peuvent contenir les IDs des membres abonnés.

## Préparation locale

```sh
pnpm build
pnpm admin doctor
pnpm admin inventory --output data/inventory.json
pnpm admin prepare --inventory data/inventory.json --output data/import-preparation.json --rawg
```

Ouvrir **`data/import-preparation.html`** dans un navigateur. Cette page fonctionne localement, sans serveur et sans accès à Discord. Elle présente les correspondances proposées, le nombre d’abonnés, les éventuels doublons et les problèmes de rôle. Les IDs individuels des abonnés n’y figurent pas. Un tableau Markdown et un brouillon JSON sont également générés, pour consultation.

Le périmètre par défaut est strictement limité aux salons textuels des catégories actives `1163827775115890708` et standby `1163828069551845427`. Les autres catégories ne participent pas aux propositions. Les options `--active-category ID` et `--standby-category ID` permettent un autre périmètre explicite. Les vocaux ne sont pas importés.

Dans la page :

1. Cliquer sur **Inclure les correspondances simples** pour sélectionner ensemble les associations exactes sans ambiguïté métier. Les problèmes de hiérarchie restent signalés et seront bloquants au plan ; sélectionner une identité n’applique aucune modification.
2. Examiner les autres lignes : choisir le salon canonique et le rôle, corriger le titre si nécessaire, et sélectionner explicitement une fiche RAWG lorsqu’elle correspond au bon jeu. Les rôles existants sont affichés par ordre alphabétique, tout en conservant la proposition présélectionnée. Aucun homonyme RAWG n’est choisi automatiquement. `--rawg` propose des résultats dans la limite du quota gratuit ; sans cette option, la préparation fonctionne entièrement hors ligne à partir de l’inventaire.
3. S’il manque le rôle, choisir **Créer un rôle pour ce jeu** (proposé par défaut lorsqu’aucun rôle n’a été identifié), puis une fiche RAWG avec image ou un rôle parent dont reprendre l’icône. Le nouveau rôle sera créé pendant l’application du plan : le salon et ses messages restent les mêmes, les permissions globales du rôle sont nulles et aucun abonné n’est ajouté implicitement. Les abonnés d’un rôle parent ne sont pas copiés. Laisser décochés les doublons, campagnes et autres cas non résolus. Deux jeux exportés ne peuvent pas partager un rôle existant ou une identité RAWG.
4. Cliquer sur **Télécharger le manifeste**, puis enregistrer le fichier obtenu en **`data/import-manifest.json`**. Il contient directement les choix confirmés ; aucun JSON n’est à rédiger à la main. Le fichier `import-preparation.json` est un brouillon de revue, pas un manifeste applicable.

Le manifeste conserve aussi la décision de **réutiliser la catégorie standby comme première archive** : même ID, nom « Archives Nexus · 1 », accès caché aux membres. L’application normalise les permissions de cette catégorie et de **tous ses salons textuels**, y compris les historiques non retenus au catalogue. Les IDs et messages restent conservés. S’il y a plus de 50 salons, seul le surplus est réparti vers les archives suivantes, créées au besoin, dans la limite de trois catégories au total. Une catégorie contenant un espace non textuel empêche cette adoption pour éviter une modification implicite des vocaux.

Le [manifeste d’exemple](import-manifest.example.json) reste disponible pour une préparation avancée manuelle.

Un doublon ne doit pas apparaître comme un deuxième jeu pour la même identité. Conserver les salons secondaires et campagnes en dehors du manifeste ; aucun historique n’est déplacé ou effacé. Un rôle encore utilisé comme droit d’accès doit être dissocié avant import : par exemple, un accès à un forum privé ne doit pas devenir accidentellement un abonnement facultatif.

```sh
pnpm admin plan --manifest data/import-manifest.json --output data/import-plan.json
```

Lire `changes` et `errors`, les IDs, les états et le choix du salon. Le plan vérifie l’unicité des identités, les plafonds, la hiérarchie et les permissions globales des rôles. Il annonce l’adoption de la première archive et la normalisation de ses accès, celle des autres salons sélectionnés et la désactivation des mentions libres des rôles. Un plan avec des erreurs ne peut pas être appliqué.

Si la commande échoue avec `admin_command_failed`, lire `stage`, `errorCode`, `setting` et `hint` lorsqu’ils sont présents. Ces diagnostics distinguent notamment la connexion Discord, la lecture du manifeste et l’écriture du plan, sans afficher les jetons, les requêtes ni les données des membres. Avec Compose, `env_file: .env` injecte déjà les variables : aucun montage supplémentaire du `.env` n’est nécessaire. Les répertoires montés pour SQLite et la sortie du plan doivent être accessibles en écriture à l’UID 1000 ; le manifeste doit être lisible par cet UID.

Pour les nouveaux rôles, `plan` vérifie aussi la fonctionnalité d’icônes du serveur et la capacité disponible en conservant `ROLE_RESERVE` emplacements. Il récupère et valide les images **avant toute mutation Discord**, puis les conserve en SQLite pour l’application du même plan. Ces icônes en attente sont réservées pendant sept jours ; si elles ont été nettoyées, régénérer le plan. Une image absente ou inexploitable bloque le plan. Aucun rôle ou salon n’est créé par `prepare` ou `plan`, et l’import ne recycle pas d’autres rôles pour forcer sa capacité.

Si `removeGameOptions` est `true`, l’application retirera seulement les références aux jeux importés dans les options du questionnaire. Les références sans rapport, y compris celles d’une option mixte, sont conservées ; les options devenues vides sont retirées. Vérifier ensuite manuellement les exigences générales du questionnaire Discord et les rôles sélectionnables dans les autres intégrations.

## Application explicite

Arrêter l’instance active avant toute mutation CLI :

Désactiver aussi l’ancienne automatisation de rotation avant la bascule et la laisser arrêtée ensuite, afin qu’elle ne déplace pas les salons en parallèle de Nexus.

```sh
docker compose stop bot
pnpm backup --output backups/before-import.sqlite
pnpm admin apply --plan data/import-plan.json --apply
pnpm admin doctor
```

Ces commandes locales utilisent le `.env` local et sa base locale. Pour le volume Docker, utiliser la même image et **le même volume** via `docker compose run`, en montant le répertoire de travail :

```sh
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js inventory --output /work/inventory.json
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js prepare --inventory /work/inventory.json --output /work/import-preparation.json --rawg
```

Ouvrir la page HTML sur l’hôte, puis télécharger le manifeste dans `data/import-manifest.json`. Générer ensuite le plan, le relire et appliquer explicitement :

```sh
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js plan --manifest /work/import-manifest.json --output /work/import-plan.json
docker compose run --rm bot node dist/cli.js backup --output /data/before-import.sqlite
docker compose run --rm -v "$PWD/data:/work" bot node dist/cli.js apply --plan /work/import-plan.json --apply
```

Le conteneur utilise l’UID 1000 : rendre le répertoire de travail accessible à cet UID. La mutation est refusée si l’état structurel de Discord a changé depuis le plan. Les changements de détenteurs des rôles ne l’invalident pas : les abonnements sont relus lors de l’application. Ne pas modifier à la main le JSON du plan ; régénérer depuis le manifeste.

L’import conserve les salons et leurs messages et reprend les abonnés du rôle. Il peut déplacer les salons sélectionnés et les salons en dépassement dans les archives, réécrire leurs dérogations et rendre les rôles non mentionnables. Les rôles importés ne deviennent pas automatiquement recyclables. Il ne supprime aucun salon ni rôle.

## Après import

Vérifier depuis un compte Syndiqué : lecture des jeux actifs sans rôle de jeu, invisibilité des archives, parcours d’abonnement, absence de permissions inattendues. Vérifier les admins, le bot et le questionnaire. Publier ensuite le panneau avec `setup`, puis démarrer l’instance.

Si une étape échoue, le jeu et l’opération sont conservés en révision et les modifications déjà faites ne sont pas annulées automatiquement. Corriger les permissions ou rattacher les ressources avec `/nexus-admin repair`. Refaire un inventaire et un nouveau plan pour reprendre une importation partielle. Une réapplication du même plan intégralement terminé est sans effet supplémentaire.

Une adoption d’archives interrompue suspend la réconciliation et la rotation. Corriger la cause puis refaire un plan et appliquer l’adoption explicitement avant de reprendre le runtime ; une simple réparation de fiche de jeu ne suffit pas à confirmer les permissions de toute une catégorie.

Après une création de rôle interrompue, ne pas relancer aveuglément une nouvelle création. Vérifier le rôle réellement présent, puis le sélectionner explicitement dans un nouveau manifeste ou réparer la fiche. Une réimportation réussie avec ce rôle résout l’ancienne opération ; elle ne crée pas un second rôle ni un second salon.
