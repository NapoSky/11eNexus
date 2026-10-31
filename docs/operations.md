# Exploitation / Operations

Les commandes hôte ci-dessous demandent Node 26 et l’accès au démon Docker. Elles ne publient aucun message Discord. Le déploiement reste manuel.

## Arrêt et ressources

À réception de SIGTERM ou SIGINT, le bot refuse les nouvelles interactions, arrête ses minuteries et annule les lectures de fond. Les actions déjà acceptées terminent avec l’accès Discord et le verrou SQLite encore disponibles. Le client Discord est ensuite déconnecté, puis le verrou libéré et la base fermée. Une limite interne de 55 secondes précède les 60 secondes de grâce du Compose. En cas de dépassement, le processus sort en erreur ; une opération partielle reste dans le journal pour vérification à la reprise.

Après SIGKILL ou OOM, le verrou reste valide jusqu’à soixante secondes depuis son dernier renouvellement. Les tentatives de relance Docker peuvent ajouter un délai : le test local hors ligne après SIGKILL a retrouvé le service en 107 secondes, sans effacer le verrou ni perdre le témoin SQLite. Cette mesure n’est pas un délai garanti sur tout hôte. Ne pas supprimer le verrou pour accélérer la reprise ; il protège contre deux instances actives. L’arrêt gracieux libère immédiatement ce verrou.

Le Compose réserve au maximum 1 Gio de mémoire et 32 Mio de tmpfs. Les messages Discord ne sont pas conservés dans le cache local ; leur historique reste sur Discord. Les fils archivés inactifs sont retirés du cache après quinze minutes, avec un passage toutes les cinq minutes. Le traitement des images partage deux places actives et huit places d’attente, avant téléchargement. Une file pleine produit une invitation localisée à réessayer.

`interaction_completed` mesure jusqu’à la dernière réponse locale, avec le résultat et les navigations remplacées. `runtime_health` publie toutes les minutes la mémoire, la file d’images et l’âge de la dernière réconciliation. Surveiller une hausse durable de ces mesures, `event_loop_blocked`, `shutdown_timeout` et les opérations à vérifier. Ces logs ne contiennent ni textes saisis ni jetons.

Les lectures de messages et les inventaires de la synchronisation événementielle se font hors du verrou des actions membre. Un inventaire final et une comparaison des données empêchent une lecture ancienne d’annuler une fermeture, une réparation ou un déplacement intervenu pendant le scan. Les annonces de nouveaux jeux disposent d’une file distincte : la réservation est atomique, les appels concurrents partagent le même envoi et un envoi incertain reste à vérifier sans rejeu automatique.

Les copies de permissions sont purgées avec leur opération terminée après trente jours. Les anciennes copies sans opération disposent d’un nouveau délai de grâce de trente jours au premier nettoyage suivant cette mise à jour. Les opérations non résolues et les justificatifs d’import/adoption sont conservés. Cette purge est transactionnelle ; elle ne modifie aucune permission Discord.

Les recherches RAWG identiques en cours partagent une seule requête et une seule réservation du budget fournisseur. Un échec libère cette réservation en mémoire pour permettre une nouvelle tentative ; il compte toujours comme appel fournisseur. Le cache de réponses réussies reste limité à dix minutes. Quitter une fiche arrête ses étapes suivantes et empêche de conserver un visuel tardif ; une requête RAWG déjà partie peut terminer et alimenter le cache commun. Les flux d’images refusés sont explicitement fermés.

Les boutons de création/relance affichent la même fenêtre de blocage que l’application : une opération encore en cours bloque, une opération à vérifier bloque ce quota pendant vingt-quatre heures. Le jeu concerné conserve ses protections tant qu’il n’est pas réparé. « Retour » et « Accueil » restent utilisables si un autre administrateur a modifié la fiche ; les actions sensibles exigent toujours une nouvelle vérification. Le tri et les dates du catalogue réutilisent leurs formateurs pendant le rendu d’une page.

Les clics d’abonnement déjà appliqués ne renvoient plus de requête d’ajout/retrait de rôle : le membre est toujours relu via REST et ses droits sont vérifiés avant de constater que son état correspond déjà au choix. L’écran privé des notifications d’événement propose aussi « Accueil », qui ouvre le menu membre dans le même message privé, avec les traductions FR/EN existantes et une session liée à son propriétaire.

## Santé du service

```sh
node scripts/check-service.mjs
```

Ce contrôle lit seulement l’état Docker : santé, arrêt, redémarrages et OOM. Il renvoie un objet JSON et un code non nul si le service est absent, arrêté, unhealthy ou impossible à contrôler. L’état de démarrage reste distinct d’un service prêt. `--container ID` permet un contrôle ciblé.

Les exemples dans `deploy/systemd/` proposent un passage chaque minute et une sauvegarde quotidienne. Avant installation, remplacer `YOUR_DOCKER_USER`, `/opt/11eNexus` et le chemin de Node par ceux de l’hôte. Un Node installé par nvm n’est pas nécessairement dans le PATH de systemd : utiliser son chemin absolu dans `ExecStart`. Relier les échecs à la supervision existante de l’hôte. Aucun timer, destinataire d’alerte ou service n’est installé automatiquement. Compose ne redémarre pas seul un conteneur unhealthy.

## Sauvegarde vérifiée

```sh
node scripts/backup.mjs --directory ./backups
```

Le script demande un dossier privé (mode 0700), crée une sauvegarde SQLite en ligne, puis contrôle son intégrité et ses clés étrangères dans l’image exacte du conteneur actif, sans réseau. Il publie le fichier final en mode 0600 uniquement après validation et supprime ses fichiers temporaires. Une erreur renvoie un code non nul sans afficher les données de la base. `--container ID` permet une cible explicite.

Conserver une copie chiffrée hors de l’hôte via le dispositif de sauvegarde existant. Le script ne choisit pas de destination distante et ne purge aucune sauvegarde. Vérifier régulièrement une restauration sur une copie indépendante ; la CI couvre aussi ce parcours avec une base et une image synthétiques. Pour restaurer les données réelles, suivre la procédure du [guide principal](../README.md#sauvegarde-et-restauration), bot arrêté.

## English

Node 26 is required on the host for these optional tools. `node scripts/check-service.mjs` checks Docker health without accessing Discord. `node scripts/backup.mjs --directory ./backups` creates an online SQLite backup, verifies integrity and foreign keys offline using the running image, and publishes a private file only after success. Both emit JSON and return a nonzero status on failure. Systemd examples require host-specific user, repository and Node paths; they are not installed automatically. Connect failures to existing host monitoring and copy encrypted backups off the host separately.

SIGTERM/SIGINT stops intake and background reads, drains accepted work before disconnecting Discord, then releases the database lease and closes SQLite. The internal deadline is 55 seconds within Compose’s 60-second grace period. Resource controls bound image work and local Discord caches while preserving server history. Structured completion timings and minute-by-minute memory/queue/reconciliation logs support ongoing monitoring.

Background event reads run outside the member-action mutex and apply only to unchanged event records after a fresh inventory. Discovery announcements use a separate serial queue and join concurrent deliveries without replaying uncertain sends. Permission snapshots expire with terminal operations after thirty days; legacy orphans receive a thirty-day rollout grace period, while unresolved operations and import/adoption evidence remain preserved.

After SIGKILL/OOM, the lease can remain valid for sixty seconds from its last renewal, and Docker restart delays may extend recovery. The isolated SIGKILL test recovered automatically in 107 seconds with its SQLite data intact; this is an observed result, not a universal recovery deadline. Graceful shutdown releases the lease immediately.

Identical in-flight RAWG reads share one provider request and budget reservation; failures permit retry while still counting the attempted provider call. Leaving a preview stops later image work and persistence, while an already started metadata request may finish into the shared cache. Rejected image streams are closed. Creation/revival buttons use the same pending/review time window as the application; safety checks for the affected game remain in force. Admin Back/Home navigation stays available after another admin changes a record, while sensitive actions still require a fresh review. Catalogue pages reuse their sorting/date formatters.

Subscription clicks that already match the freshly fetched role state skip the role write while retaining fresh REST permission checks. Private event notification settings include the existing localized Home button, opening the member hub in the same private message through an owner-bound session.
