# 11eNexus

Bot Discord communautaire FR/EN : des salons de jeux visibles selon leur activité, des notifications facultatives et des archives cachées conservant l’historique.

Node 24 · TypeScript 7 · discord.js · i18next · SQLite intégré à Node · Jest/SWC. Hébergement personnel avec Docker Compose, déploiement manuel. Aucun service payant requis. [English quick start](docs/quickstart.en.md).

## Fonctionnement

- Un panneau public bilingue, en lecture seule pour les membres. Les boutons ouvrent un parcours personnel dans la langue de Discord : catalogue, recherche, création, relance, abonnements et propositions.
- Accès réservé aux Syndiqués (`948308796416098395`) et aux admins configurés. Publication et configuration du panneau réservées aux admins. Les membres créent les jeux eux-mêmes après sélection et confirmation d’une fiche RAWG.
- Un jeu créé ou relancé remonte dans « Jeux du moment ». Aucun abonnement ni ping automatique. Un premier message humain dans les 48 heures confirme son activité ; sinon il retourne aux archives.
- Ensuite : archivage après 30 jours sans message humain. Les quinze jeux établis les plus récemment actifs forment le socle protégé. Une relance provisoire ne chasse pas un jeu de ce socle. Les messages dans les fils et forums comptent aussi ; bots, webhooks et messages système sont ignorés. Les réactions ne comptent pas.
- Un membre peut créer **ou** relancer un jeu par période glissante de 24 heures. Relancer un jeu déjà actif ne consomme pas ce quota.
- Maximum 150 jeux au catalogue, une catégorie active de 50 salons et trois catégories d’archives de 50 salons chacune. Saturation : intervention admin, maintien du seuil de 30 jours. Les vocaux et évènements sont hors périmètre V1.
- Les abonnements suivent les rôles Discord existants. Le bot peut recycler un rôle de notification archivé et sans autre usage lorsque la réserve de rôles est atteinte. Son icône et les préférences sont conservées en SQLite ; la relance crée un nouveau rôle et réabonne les membres encore présents. Les rôles historiques importés ne sont pas recyclés automatiquement.

### Mentions des joueurs

Les rôles de notification sont **non mentionnables librement**. Depuis la fiche personnelle d’un jeu actif, « Prévenir les joueurs » ouvre un message puis le bot mentionne uniquement le rôle concerné, après vérification du rôle Syndiqué. Temporisation : 15 minutes par membre et jeu. Tout `@everyone`, autre rôle ou utilisateur inséré dans le texte est privé de notification par `allowedMentions`.

Discord ne propose pas de permission native « seul le rôle Syndiqué peut mentionner ce rôle précis ». Le bot utilise donc ce parcours contrôlé. Il lui faut `Mention Everyone`, sans accorder cette permission aux membres. Les notifications finales restent soumises aux préférences personnelles Discord. [Référence officielle](https://docs.discord.com/developers/resources/message#allowed-mentions-object).

## Installation

1. Utiliser Node **24.22.1 minimum, branche 24** et pnpm **12.14.0**, ou directement Docker Compose v2. Le Dockerfile suit `node:24-bookworm-slim`, avec récupération de la base récente au build.
2. Copier `.env.example` vers `.env`, renseigner `BOT_TOKEN`, `GUILD_ID`, `RAWG_API_KEY`, vérifier les rôles et catégories, puis protéger le fichier (`chmod 600 .env`). Un `.env` local déjà présent doit être conservé.
3. Dans le Developer Portal Discord, activer **Server Members Intent**. `Message Content Intent` n’est pas utilisé. Installer l’application avec les scopes `bot` et `applications.commands`.
4. Placer le rôle du bot **au-dessus des rôles de jeux à importer**. Permissions : gérer salons et rôles, voir les salons, lire l’historique, envoyer des messages, joindre fichiers, intégrer liens, gérer les fils pour inspecter les fils privés et mentionner les rôles. La modification du questionnaire nécessite aussi gérer le serveur et gérer les rôles. Le bot doit voir les archives et le salon admin.
5. Les icônes de rôles nécessitent la fonctionnalité Discord `ROLE_ICONS`. Si elle disparaît, les nouvelles créations/restaurations de rôles sont bloquées avec explication ; l’historique reste intact.

```sh
docker compose build --pull
docker compose run --rm bot node dist/cli.js doctor
```

`doctor` lit Discord sans publier de message. Le démarrage ne publie aucun panneau et n’adopte aucun salon existant. Pour installer les commandes et le panneau, exécuter explicitement, avant de démarrer le service :

```sh
docker compose run --rm bot node dist/cli.js setup
docker compose up -d
docker compose logs --tail 100 bot
```

`setup --channel ID` réutilise un salon textuel dédié et **remplace ses permissions** par celles du panneau en lecture seule. Sans ce paramètre, un salon Nexus est créé. Réexécuter `setup` répare le message connu plutôt que publier un doublon. `/nexus-admin setup` est ensuite disponible aux admins ; `/nexus` constitue un accès de secours aux parcours personnels.

Les commandes admin ont une permission Discord par défaut `Administrator`, en plus du contrôle du rôle admin configuré côté bot. Si ce rôle n’a pas `Administrator`, lui autoriser explicitement `/nexus-admin` dans les paramètres d’intégration Discord.

### Importer les anciens jeux

L’import conserve les IDs des salons et rôles et importe leurs détenteurs actuels. Il normalise leurs permissions pour les rendre visibles aux Syndiqués lorsqu’ils sont actifs et cachés lorsqu’ils sont archivés. Cela remplace les dérogations historiques sur ces salons. Les salons non sélectionnés restent hors gestion.

Préparer puis relire le manifeste et le plan selon [le guide de migration](docs/migration.md). L’application exige un plan cohérent avec l’état Discord courant, des rôles sous le bot et **sans permission globale**, et un `--apply` explicite. Un rôle donnant accès à autre chose doit être dissocié manuellement avant import. Les doublons ne sont jamais fusionnés ou supprimés automatiquement.

## Déploiement et maintenance

```sh
git pull --ff-only
docker compose exec bot node dist/cli.js backup --output /data/before-update.sqlite
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 bot
```

Compose demande une base récente au build. Les versions de dépendances restent verrouillées par `pnpm-lock.yaml`. Aucun port n’est exposé. Le conteneur s’exécute sans root, avec système de fichiers en lecture seule et volume SQLite persistant. **Ne pas exécuter `docker compose down -v`** sur les données à conserver.

Pour revenir à une version précédente : arrêter le bot, conserver une nouvelle sauvegarde, sélectionner le commit ou tag validé (`git checkout TAG`), puis reconstruire. Si cette version ne comprend pas les migrations déjà appliquées, restaurer également la sauvegarde prise avant la mise à jour. Ne pas modifier les migrations ni mélanger une ancienne base avec une version qui ne peut pas la lire.

Une seule instance écrit dans la base. Un bail SQLite renouvelé protège aussi contre une commande d’import ou de publication simultanée. Pour ces opérations CLI : arrêter le bot, lancer la commande, redémarrer. Une sauvegarde peut être faite à chaud.

Après une panne, le bot observe Discord avant toute rotation. Les changements manuels de catégorie, les abonnements et les suppressions gagnent. Un rôle supprimé manuellement n’est pas recréé automatiquement. Une opération partielle ou des permissions incertaines bloquent le jeu et demandent une vérification via `/nexus-admin repair`. Cette commande vérifie les ressources puis remet les permissions attendues. Les créations incomplètes ne déclenchent aucune suppression compensatoire.

`/nexus-admin status`, `proposals`, `approve`, `clarify`, `reject`, `reconcile`, `block`, `unblock`, `edit`, `retire` et `repair` assurent l’exploitation. `edit` corrige le titre et les alias du catalogue, sans renommer les ressources Discord. `retire` retire un jeu archivé ou indisponible du catalogue en conservant ses ressources ; cela ne libère pas de place dans les catégories Discord. Libérer des emplacements nécessite une décision admin sur les ressources, leur export ou leur déplacement.

Le contrôle de santé échoue si Discord n’est pas prêt ou si les réconciliations n’aboutissent plus. Docker marque alors le service `unhealthy` ; Compose ne redémarre pas automatiquement un processus seulement parce qu’il est `unhealthy`. Examiner les logs et les permissions.

### Sauvegarde et restauration

La sauvegarde utilise l’API SQLite et inclut les écritures du WAL : ne pas copier uniquement le fichier principal à chaud.

```sh
docker compose exec bot node dist/cli.js backup --output /data/nexus-backup.sqlite
mkdir -p backups
docker compose cp bot:/data/nexus-backup.sqlite ./backups/nexus-backup.sqlite
```

Conserver une copie hors de la machine. Pour restaurer :

```sh
docker compose stop bot
docker compose run --rm -v "$PWD/backups:/backups:ro" bot node scripts/verify-database.mjs /backups/nexus-backup.sqlite
docker compose run --rm -v "$PWD/backups:/backups:ro" bot node -e 'const fs=require("node:fs"); for(const suffix of ["-wal","-shm"])fs.rmSync("/data/nexus.sqlite"+suffix,{force:true}); fs.copyFileSync("/backups/nexus-backup.sqlite","/data/nexus.sqlite"); fs.chmodSync("/data/nexus.sqlite",0o600)'
docker compose up -d
```

La réconciliation après restauration observe l’état Discord actuel ; une ancienne sauvegarde ne force pas les abonnements ou catégories d’une ancienne date. Les migrations SQL appliquées sont protégées par checksum : ne pas réécrire leur historique.

## Développement

```sh
npm install --global pnpm@12.14.0
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm test:coverage
docker build --target test -t 11enexus:test .
```

Les tests utilisent des doubles Discord/RAWG et de vraies bases SQLite temporaires. Ils n’emploient aucun secret et n’envoient aucun message. `pnpm dev` construit puis démarre le vrai bot avec le `.env` local ; utiliser une guilde d’essai pour les essais interactifs.

L’architecture, les garanties et les limites sont décrites dans [docs/architecture.md](docs/architecture.md). Les arbitrages initiaux restent dans `drafts/`.

## Gratuité, données et GitHub

RAWG Free est destiné aux projets personnels non commerciaux, avec 20 000 requêtes mensuelles et liens de retour obligatoires : [conditions du fournisseur](https://rawg.io/apidocs). Nexus affiche ces liens, met en cache dix minutes et limite ses propres appels à **18 000/mois UTC**, avec cinq recherches par minute et par membre. Ce compteur ne voit pas les usages de la même clé par d’autres applications. Aucun appel Twitch, connexion Twitch ou service payant de secours.

Les jeux absents de RAWG, homonymes ou sans visuel passent par une proposition privée comportant un lien officiel. Un admin vérifie l’identité puis fournit une image Discord ou réutilise celle d’un jeu parent. Un admin peut demander une précision avec `clarify` ; le membre complète sa proposition depuis son suivi privé, sans nouveau doublon ni dépendance aux DM. Nexus ne télécharge pas les liens libres soumis par les membres. Une image de couverture RAWG est adaptée en icône de rôle et conservée en BLOB ; ce n’est pas un logo officiel garanti.

La base contient des IDs Discord, préférences de notification, propositions et opérations techniques. Aucun corps de message Discord n’est stocké. Les URLs de pagination RAWG contenant la clé sont exclues du cache. Les journaux ne contiennent pas les jetons ni les détails bruts d’erreurs API. Protéger le volume et ses sauvegardes.

Le dépôt est prêt pour GitHub privé : CI Linux sur push/PR, tests, format, audit des dépendances, build Docker et scan Trivy des vulnérabilités hautes/critiques ayant un correctif ; Dependabot hebdomadaire ; permissions CI en lecture seule ; aucun déploiement automatique. Les workflows consomment l’allocation Actions du compte. Pour rester strictement gratuit, conserver un budget GitHub payant à zéro ; aucun service Advanced Security payant n’est activé. La CI distante ne peut être validée qu’après création et push du dépôt.

Les `.env`, bases, exports de membres et anciens outils contenant des identifiants sont exclus de Git et du contexte Docker. Vérifier ce qui sera ajouté avant le premier commit ; ne jamais faire d’un ancien export ou script opérationnel un exemple public.

Dependabot regroupe les mises à jour mineures et correctives de `package.json`/`pnpm-lock.yaml` en deux ensembles, production et outils. Les correctifs de sécurité npm sont regroupés séparément. Les images du Dockerfile et de Compose ont leurs propres groupes ; `11enexus:local`, construite localement, est exclue du suivi des registres. Les mises à jour majeures restent individuelles. Ces règles utilisent les [options officielles de regroupement](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups--).

La CI complète s’exécute à l’ouverture, à chaque nouveau commit, à la réouverture et à la sortie du mode brouillon d’une PR, y compris celles de Dependabot. Aucun filtre sur l’auteur ni sur les fichiers modifiés ne les exclut. Elle peut aussi être relancée depuis GitHub Actions ou avec `gh workflow run ci.yml --repo NapoSky/11eNexus --ref NOM_DE_BRANCHE`.
