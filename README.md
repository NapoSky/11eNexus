# 11eNexus

Bot Discord communautaire FR/EN : des salons de jeux visibles selon leur activité, des notifications facultatives et des archives cachées conservant l’historique.

Node 24 / Docker Node 26 · TypeScript 7 · discord.js · i18next · SQLite intégré à Node · Jest/SWC. Hébergement personnel avec Docker Compose, déploiement manuel. Aucun service payant requis. [English quick start](docs/quickstart.en.md).

## Fonctionnement

- Un panneau public bilingue, en lecture seule pour les membres. Les boutons ouvrent un parcours personnel dans la langue de Discord : catalogue, recherche, création, relance, abonnements et propositions.
- Le bouton « Jeux » ouvre les jeux actifs ; « Archives » ouvre directement les jeux archivés, même si leurs salons sont cachés. Le catalogue personnel affiche le total et les comptes actifs/archivés ; le filtre permet aussi de tout afficher.
- Accès réservé aux Syndiqués (`948308796416098395`) et aux admins configurés. Publication et configuration du panneau réservées aux admins. Les membres créent les jeux eux-mêmes après sélection et confirmation d’une fiche RAWG.
- Un jeu créé ou relancé remonte dans « Jeux du moment », sans abonnement automatique. Les nouveaux jeux sont annoncés dans « 🔎suggestions-de-greves » avec la seule mention du rôle « Nouveau Jeu » ; les relances et imports historiques ne déclenchent pas d’annonce. Un premier message humain dans les 48 heures confirme son activité ; sinon il retourne aux archives.
- Ensuite : archivage après 30 jours sans message humain. Les quinze jeux établis les plus récemment actifs forment le socle protégé. Une relance provisoire ne chasse pas un jeu de ce socle. Les messages dans les fils et forums comptent aussi ; bots, webhooks et messages système sont ignorés. Les réactions ne comptent pas.
- Un membre peut créer **ou** relancer un jeu par période glissante de 24 heures. Relancer un jeu déjà actif ne consomme pas ce quota.
- Maximum 150 jeux au catalogue, une catégorie active de 50 salons et trois catégories d’archives de 50 salons chacune. Saturation : intervention admin, maintien du seuil de 30 jours. Les vocaux et évènements sont hors périmètre V1.
- Les abonnements suivent les rôles Discord existants. Le bot peut recycler un rôle de notification archivé et sans autre usage lorsque la réserve de rôles est atteinte. Son icône et les préférences sont conservées en SQLite ; la relance crée un nouveau rôle et réabonne les membres encore présents. Les rôles historiques importés ne sont pas recyclés automatiquement.

### Nouveautés et alertes

« Nouveautés / Recently added », dans le panneau public et `/nexus`, ouvre une page privée avec les cinq premiers ajouts de la page et leur date relative, puis une liste de vingt jeux, du plus récent au plus ancien. La recherche, la pagination et le retour depuis une fiche conservent ce classement. Les autres filtres restent alphabétiques. La date d’ajout ne change pas à la relance. La migration `002` conserve les dates des créations réussies encore présentes dans le journal ; les jeux historiques sans date fiable restent dans « Tous », sans annonce rétroactive.

« Alertes nouveautés / New game alerts » affiche l’état réel du rôle Discord et permet de le prendre ou de le retirer en privé. Ce réglage ne modifie ni la visibilité des salons ni les abonnements aux jeux. Un retrait manuel dans Discord est respecté.

`NEW_GAME_ROLE_ID` désigne le rôle existant « Nouveau Jeu » (`1450484079228227674`), et `NEW_GAME_CHANNEL_ID` le salon des annonces (`389733957890998294`). Le bot doit pouvoir attribuer ce rôle sans permissions globales et écrire dans ce salon. Une création membre ou admin réussie publie une courte annonce bilingue et un lien vers le salon du jeu. Seul le rôle d’alertes peut être mentionné. Les réglages personnels Discord continuent de s’appliquer.

L’annonce est journalisée séparément de la création : un échec ne remet pas le jeu en échec. Un envoi interrompu ou incertain exige une vérification de l’équipe, signalée en staff ; aucun renvoi automatique ne risque de doubler une annonce reçue ou supprimée manuellement. Les envois confirmés sont conservés trente jours, les envois non résolus sont préservés. Le déploiement nécessite une reconstruction de l’image et une mise à jour du panneau via `setup` ; aucune commande de test ne doit publier une annonce réelle.

### Mentions des joueurs

Les rôles de notification sont **mentionnables par les membres** : chacun peut utiliser `@NomDuRôle` dans une discussion pour prévenir les abonnés du jeu. Cette propriété est activée lors de la création, de l’import ou d’une réparation explicite du rôle. Les notifications restent soumises aux préférences personnelles Discord.

L’action facultative « Prévenir les joueurs », depuis la fiche personnelle d’un jeu actif, reste disponible : le bot mentionne uniquement le rôle concerné après vérification du rôle Syndiqué. Sa temporisation de 15 minutes par membre et jeu concerne uniquement ce bouton, pas les mentions manuelles. Tout `@everyone`, autre rôle ou utilisateur inséré dans son texte est privé de notification par `allowedMentions`. Les annonces de nouveaux jeux mentionnent uniquement le rôle « Nouveau Jeu ». Les autres messages du bot ne déclenchent aucune mention automatique. [Référence officielle](https://docs.discord.com/developers/resources/message#allowed-mentions-object).

Pour une instance déjà importée, arrêter le bot puis activer les mentions sur les seuls rôles du catalogue, sans refaire l’import :

```sh
docker compose stop bot
docker compose run --rm bot node dist/cli.js role-mentions --apply
docker compose run --rm bot node dist/cli.js doctor
docker compose up -d
```

Sans `--apply`, `role-mentions` affiche uniquement les changements prévus. Tous les rôles sont vérifiés avant la première modification ; les rôles supprimés ne sont pas recréés et les rôles hors catalogue ne sont pas modifiés. La commande peut être relancée après une interruption. `doctor` liste les éventuels rôles de jeux encore non mentionnables dans `unmentionableImportedRoles`. La réconciliation habituelle continue de respecter les changements manuels faits dans Discord.

## Installation

1. Utiliser Node **24.22.1 minimum sur la branche 24**, ou **Node 26**, avec pnpm **12.14.0** ; Docker Compose v2 est également disponible. La CI utilise Node 24 ; le Dockerfile suit `node:26-bookworm-slim`, avec récupération de la base récente au build.
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

`setup --channel ID` réutilise un salon textuel dédié et **remplace ses permissions** par celles du panneau en lecture seule. Sans ce paramètre, un salon Nexus est créé. Réexécuter `setup` répare le message connu plutôt que publier un doublon. `setup` installe aussi le point d’entrée dans le salon staff déjà privé, sans en modifier les permissions ; `--admin-channel ID` permet de choisir ce salon. `/nexus-admin`, sans sous-commande, ouvre l’accueil admin personnel ; `/nexus` ouvre le parcours membre. `/nexus-status` conserve le raccourci de statut privé réservé aux admins (catalogue, demandes, opérations à vérifier et dernière réconciliation).

Le panneau et les écrans personnels utilisent les **Components V2** : logo et bannière, rubriques courtes, aide au choix et fiches de jeu. Le panneau reste unique et bilingue ; la suite s’affiche en privé, en FR ou EN selon Discord. Les modales indiquent quoi saisir et l’effet de la validation ; les fermer ramène au menu précédent.

Les boutons gris servent à naviguer (filtres, recherche, pages, Retour, Accueil), les bleus à relancer ou prévenir les joueurs, les verts à ajouter un jeu ou activer ses notifications. Couper les notifications utilise un bouton rouge. Retour conserve le filtre, la recherche et la page du catalogue ; une demande acceptée permet aussi d’ouvrir la fiche d’un jeu archivé pour le relancer. `/nexus` ouvre l’accueil personnel.

Pour passer un panneau existant en V2 après reconstruction de l’image : arrêter le bot, exécuter `docker compose run --rm bot node dist/cli.js setup`, puis `docker compose up -d`. Le même message est mis à jour. Aucun nouvel import n’est nécessaire. La conversion d’un message en V2 est définitive côté Discord ; les mises à jour et déplacements du panneau conservent ce format. Les anciens boutons publics restent utilisables pendant la transition.

Les commandes admin ont une permission Discord par défaut `Administrator`, en plus du contrôle du rôle admin configuré côté bot. Si ce rôle n’a pas `Administrator`, lui autoriser explicitement `/nexus-admin` et `/nexus-status` dans les paramètres d’intégration Discord.

### Importer les anciens jeux

L’import conserve les IDs des salons et rôles et importe leurs détenteurs actuels. Il normalise leurs permissions pour les rendre visibles aux Syndiqués lorsqu’ils sont actifs et cachés lorsqu’ils sont archivés. Cela remplace les dérogations historiques sur ces salons. Les salons non sélectionnés restent hors gestion.

Après l’inventaire, `pnpm admin prepare --inventory data/inventory.json --output data/import-preparation.json --rawg` génère une page locale **`data/import-preparation.html`** : sélectionner les correspondances proposées et télécharger le manifeste, sans écrire de JSON à la main. Seules les deux catégories de jeux configurées pour cette préparation sont ciblées. L’ancienne catégorie « Les jeux en pause » devient la première archive cachée en conservant son ID ; les deux suivantes sont créées au besoin.

Les rôles de notification sont proposés dans l’ordre alphabétique. Lorsqu’il manque un rôle, choisir **Créer un rôle pour ce jeu** avec une image RAWG ou l’icône d’un rôle parent : le plan vérifie le visuel et la capacité, puis l’application crée seulement le rôle manquant, sans recréer le salon ni abonner automatiquement les membres.

Préparer puis relire le plan selon [le guide de migration](docs/migration.md). L’application exige un plan cohérent avec l’état Discord courant, des rôles sous le bot et **sans permission globale**, et un `--apply` explicite. Un rôle donnant accès à autre chose doit être dissocié manuellement avant import. Les doublons ne sont jamais fusionnés ou supprimés automatiquement.

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

Après une panne, le bot observe Discord avant toute rotation. Les changements manuels de catégorie, les abonnements et les suppressions gagnent. Un rôle supprimé manuellement n’est pas recréé automatiquement. Une opération partielle ou des permissions incertaines bloquent le jeu et demandent une vérification dans **Administration → Maintenance → Réparer les associations**. Cet assistant vérifie les ressources puis remet les permissions attendues. Les créations incomplètes ne déclenchent aucune suppression compensatoire.

L’administration est centralisée dans un panneau Components V2 : **Demandes**, **Catalogue**, **Maintenance** et **Panneaux**. Le message staff, le bouton Administration des menus privés et `/nexus-admin` ouvrent le même accueil. Les anciennes sous-commandes sont retirées à la réinstallation des commandes. Aucun identifiant ni commande n’est à recopier pour accepter/refuser une demande, choisir une image, ajouter/archiver/relancer/retirer un jeu ou réparer ses associations. Voir [le guide d’administration](docs/administration.md).

Les consultations n’appliquent pas de mutation Discord. Réconciliation et rotation sont distinctes et demandent une confirmation après aperçu. Une modification du titre peut aussi aligner les noms Discord du salon et du rôle, sur choix explicite. Retirer un jeu conserve son salon, son historique et son rôle ; cela ne libère pas de place dans les catégories Discord. Le rôle Admin est exempt des quotas membres d’ajout, de relance, de demande et de recherche, dans les deux parcours ; les capacités du serveur et le quota global RAWG restent applicables.

Les demandes ouvertes expirent après trente jours sans mise à jour, puis restent dans l’historique trente jours après leur clôture. Le journal d’audit et les opérations terminées sont conservés trente jours ; les opérations à réparer restent conservées. Le nettoyage automatique préserve le catalogue, les abonnements et les messages Discord. Voir la [politique de rétention](docs/administration.md#rétention).

Pour lister les ressources suivies et strictement non suivies, utiliser la base de production :

```sh
docker compose run --rm bot node dist/cli.js audit --output /data/resource-audit.json
```

Le rapport est disponible sur l’hôte dans `data/resource-audit.json` et `data/resource-audit.md`. Les rôles ordinaires sous « Jeux réguliers » (`811274814841028611`) sont comparés par ID aux fiches SQLite ; les bots, intégrations et `@everyone` sont exclus. Côté salons, le périmètre par défaut couvre les espaces textuels de la catégorie active et des archives enregistrées. `--role-marker ID`, `--categories ID,ID` et `--locale en` permettent un autre périmètre ou une autre langue. La commande fonctionne pendant que le bot tourne et ne modifie pas Discord.

Les fiches retirées et les opérations inachevées sont distinguées des ressources sans aucune association connue. Le rapport inclut les compteurs d’abonnés, les usages dans les permissions de salons et le questionnaire, les ressources liées hors périmètre, les IDs introuvables et les écarts entre noms Discord et noms du catalogue. Les propositions de noms signalent les noms déjà utilisés ; elles peuvent être examinées puis appliquées depuis la fiche admin du jeu, sans renommage automatique lors de l’audit. Aucun ID individuel d’abonné n’est exporté. Un inventaire incomplet, une base vide, un repère absent ou un changement de catalogue pendant la lecture bloque une conclusion fiable ; relancer l’audit après stabilisation.

Le contrôle de santé échoue si Discord n’est pas prêt ou si les réconciliations n’aboutissent plus. Docker marque alors le service `unhealthy` ; Compose ne redémarre pas automatiquement un processus seulement parce qu’il est `unhealthy`. Examiner les logs et les permissions.

Les logs de service utilisent Pino sur stderr, avec date, niveau, évènement et diagnostics d’erreur. `LOG_FORMAT=json` est le format structuré par défaut ; `LOG_FORMAT=pretty` donne un affichage lisible dans `docker compose logs`. `LOG_LEVEL=debug` ajoute les délais d’acquittement des interactions. Les jetons, corps de requête, textes saisis et messages bruts d’exception ne sont pas journalisés. Les résultats des commandes administratives restent disponibles sur stdout.

La réconciliation compare les abonnés et applique uniquement les différences en une transaction SQLite, sans réécrire les abonnés inchangés. Elle rend la main aux entrées/sorties entre chaque jeu pour laisser passer les clics pendant le traitement de fond. Les évènements `reconciliation_started` et `reconciled.elapsedMs` permettent de suivre ce traitement ; `event_loop_blocked` signale un blocage de la boucle Node d’au moins une seconde. Les erreurs d’interaction indiquent aussi `receivedAgeMs` (âge calculé à l’entrée du handler), `elapsedMs` (traitement local) et `gatewayPingMs` lorsqu’il est connu. Un âge calculé dépend également de l’horloge de l’hôte ; il ne prouve pas à lui seul une latence réseau.

Un menu personnel expire après quinze minutes ; le bouton « Accueil » permet alors de repartir. Cette expiration est distincte de celle du jeton Discord : une interaction doit être acquittée sous trois secondes. Un échec d’acquittement n’est jamais suivi d’un deuxième callback. Les erreurs inattendues indiquent le code Discord, l’étape, l’âge de l’interaction et les emplacements du code utiles, sans journaliser le jeton. [Délais Discord](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback).

Après une mise à jour ajoutant des boutons au panneau, arrêter le bot, exécuter `docker compose run --rm bot node dist/cli.js setup`, puis le redémarrer. Le message du panneau existant est mis à jour, sans créer un second panneau dans le même salon. `doctor` expose les comptes du catalogue sous `catalogue.active`, `catalogue.archived` et `catalogue.unavailable` ; les salons historiques hors catalogue peuvent faire varier le nombre de salons physiques des archives.

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
