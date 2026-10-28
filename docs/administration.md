# Administration de 11eNexus

Depuis la 1.0.1, l’administration passe par un accueil Components V2. Les douze sous-commandes Discord de la 1.0 sont retirées lors de la mise à jour des commandes.

## Ouvrir l’administration

Le message permanent du salon staff ouvre un espace personnel. Le bouton **Administration** dans les menus privés et la commande **`/nexus-admin`**, sans option ni sous-commande, conduisent au même accueil.

Les menus sont en français ou en anglais selon la langue Discord de l’admin. Leur consultation et chaque confirmation nécessitent le rôle admin configuré ou la propriété du serveur. Les sessions appartiennent au membre qui les ouvre et expirent après quinze minutes. Une confirmation expire après cinq minutes et ne peut être utilisée qu’une fois. Le bot vérifie à nouveau les droits, les associations et l’état Discord avant l’application.

L’accueil présente les jeux actifs et archivés, les demandes à traiter, les opérations à vérifier et la dernière réconciliation réussie. Il propose quatre rubriques.

## Demandes

La liste affiche les demandes à traiter par défaut, avec recherche, pagination, filtre « À préciser » et historique des trente derniers jours.

Depuis une fiche :

- **Préparer l’acceptation** : vérifier le nom et le lien ; choisir un visuel RAWG, celui d’un jeu parent ou une image jointe ; relire le récapitulatif puis confirmer la création.
- **Demander une précision** ou **Refuser** : saisir le motif qui sera visible par le membre, puis confirmer la décision.
- **Rattacher à un jeu existant** : choisir sa fiche et confirmer. La demande est acceptée sans créer de salon ou de rôle, sans abonnement et sans relancer le jeu.

L’aperçu d’image est sauvegardé en SQLite avant confirmation. Les uploads acceptent PNG, JPEG et WebP jusqu’à 5 Mo ; une URL de pièce jointe éphémère n’est pas conservée comme seul exemplaire du visuel. Les abonnés d’un jeu parent ne sont pas copiés.

La préparation affiche l’état du nom, du lien et du visuel, puis la prochaine étape. Le récapitulatif reste indisponible tant qu’une information nécessaire manque ou est invalide. Enregistrer « Nom et lien » ne crée aucun salon ni rôle.

Une demande modifiée par son auteur ou déjà traitée par un autre admin oblige à préparer un nouveau récapitulatif.

## Rétention

Une demande ouverte expire après **30 jours sans mise à jour**. Une demande de précision ou une réponse de l’auteur relance ce délai. Après acceptation, refus ou expiration, sa fiche reste consultable **30 jours à partir de sa clôture**, puis est supprimée de SQLite.

Les entrées d’audit et les opérations terminées ou échouées sont également supprimées après 30 jours. Les opérations en attente ou à vérifier restent conservées jusqu’à leur résolution, même au-delà de ce délai. Cette rétention ne plafonne pas le nombre de demandes administratives créées dans les trente jours ; l’exemption des quotas Admin reste applicable.

Le nettoyage s’exécute au démarrage puis à chaque cycle périodique, avant la réconciliation Discord. Les anciens dossiers sans date de mise à jour ou de clôture bénéficient d’un délai de trente jours à compter du premier nettoyage de cette version. Les jeux, leurs associations, visuels et abonnements, les justificatifs d’import et les messages Discord ne sont pas supprimés par cette rétention. Les sauvegardes existantes ne sont pas modifiées.

## Catalogue

Rechercher un titre ou un alias, puis choisir une fiche. Les filtres distinguent les jeux actifs, archivés, indisponibles et retirés. Une fiche affiche le salon, le rôle, le visuel et le nombre d’abonnés.

- **Ajouter un jeu** : recherche RAWG ou saisie manuelle, choix du visuel, aperçu et confirmation.
- **Modifier la fiche** : titre et alias. Au récapitulatif, choisir explicitement si les noms Discord du salon et du rôle doivent également être alignés.
- **Archiver / Relancer** : confirmer le changement de visibilité. L’archivage manuel est une décision administrative ; il ne modifie pas les protections de la rotation automatique.
- **Suspendre / Reprendre la gestion** : bloquer ou rétablir les actions Nexus pour ce jeu. Une opération inachevée doit d’abord être réparée avant une reprise.
- **Retirer du catalogue** : réservé à un jeu archivé ou indisponible. Le salon, les messages et le rôle restent conservés. Cela libère une place au catalogue, pas un emplacement physique dans les catégories Discord.
- **Réparer les associations** : choisir un salon et un rôle existants par leurs noms, puis confirmer leurs associations et la normalisation des permissions. Les ressources manquantes ne sont pas recréées automatiquement.

Le rôle Admin est exempt des quotas membres d’ajout, de relance, de demande et de recherche, y compris depuis le parcours membre. Les anciens compteurs ne désactivent pas ses boutons. La limite anti-abus de cinquante demandes ouvertes ne bloque pas les demandes administratives. Les plafonds de catalogue, de salons, de rôles et les contrôles de permissions restent applicables. L’admin qui décide et le bénéficiaire d’une demande sont distingués dans le journal. Ajouter ou relancer ne produit aucun abonnement ou ping implicite.

Un renommage Discord partiellement effectué reste journalisé et bloque le jeu pour vérification ; aucun salon n’est supprimé pour compenser une erreur.

## Maintenance

L’ouverture affiche une aide. **Vérifier maintenant** lit les ressources et l’activité, sans déplacer de salon, changer de rôle, réconcilier la base ou publier d’alerte. Les sessions de navigation restent enregistrées séparément.

Le clic affiche immédiatement la vérification en cours, même lorsqu’elle attend la fin d’une réconciliation. L’écran indique ensuite la lecture des ressources puis le nombre de jeux vérifiés, avec des mises à jour espacées pour limiter les appels Discord. Le bouton de vérification est désactivé pendant ce scan ; **Retour** et **Accueil admin** restent disponibles. Quitter cet écran arrête la suite du scan après l’appel réseau en cours. Une réponse ou une erreur tardive ne remplace pas le nouveau menu ; un autre menu personnel ouvert dans un message distinct reste indépendant. La fin du diagnostic et les échecs sont signalés explicitement, avec possibilité de réessayer.

Le diagnostic présente les écarts, ressources manquantes ou non suivies, noms à réaligner, jeux proposés à l’archivage et historiques incomplets. Les opérations à vérifier donnent accès à l’assistant de réparation. Un audit incomplet n’est pas présenté comme un inventaire exhaustif.

Deux actions distinctes sont proposées :

- **Préparer la réconciliation** : actualiser SQLite depuis Discord et vérifier les opérations interrompues, sans appliquer l’archivage par inactivité.
- **Préparer la rotation** : appliquer la réconciliation puis l’archivage selon les règles habituelles, en protégeant le socle des quinze jeux établis et les historiques non vérifiables. Les jeux concernés apparaissent dans le récapitulatif paginé.

Chaque action demande confirmation après un aperçu en lecture seule. L’état est revérifié avant application ; si des données pertinentes ont changé, il faut refaire le récapitulatif. Le résultat recharge le diagnostic et signale les opérations qui demandent encore une intervention.

## Panneaux

Choisir le panneau membre ou staff, sélectionner un salon textuel, puis relire et confirmer. Le salon enregistré est proposé lorsqu’il existe encore. Le message connu est actualisé sur place ou déplacé ; un ancien message déplacé conserve un lien vers son nouvel emplacement.

**Panneau membre** : le récapitulatif indique que les dérogations du salon cible seront remplacées par les permissions Nexus de lecture seule pour les membres. Un salon déjà associé à un jeu ou à l’autre panneau n’est pas accepté.

**Panneau staff** : Nexus vérifie que le salon est déjà privé pour les admins configurés. Il ne remplace pas ses permissions. Un accès connu par un rôle ordinaire ou un membre hors périmètre, ou un inventaire incomplet des membres, empêche la publication. Les détails d’administration restent dans les réponses personnelles.

## Navigation

Gris pour naviguer, vert pour valider ou ajouter, bleu pour une action technique et rouge pour refuser ou retirer. Le texte indique toujours l’effet de l’action. **Retour**, **Accueil admin** et **Annuler** sont disponibles selon le contexte. Retour conserve les recherches, filtres et pages. Fermer une modale retrouve son écran d’origine.

Les appels longs sont acquittés immédiatement ; la confirmation affiche ensuite une progression puis le résultat dans le même message privé. Un échec d’acquittement Discord ne déclenche pas de second callback.

## Passer de la 1.0.0 à la 1.0.1

Après validation et publication de la version :

```sh
git pull --ff-only
docker compose exec bot node dist/cli.js backup --output /data/before-1.0.1.sqlite
docker compose build --pull bot
docker compose stop bot
docker compose run --rm bot node dist/cli.js setup
docker compose up -d
```

`setup` remplace l’enregistrement Discord par les deux accès `/nexus` et `/nexus-admin`, actualise le panneau membre et installe le panneau staff. Aucun nouvel import et aucune migration de schéma SQLite ne sont nécessaires. Une ancienne commande encore affichée dans le client ouvre l’accueil admin au lieu d’exécuter ses anciens paramètres.

Le panneau staff utilise le salon déjà enregistré, sinon `ADMIN_CHANNEL_ID`. Pour en choisir un autre lors du premier déploiement, ajouter `--admin-channel ID` à `setup`. Si ce salon n’est pas privé, la publication staff est refusée sans changement de ses permissions. Les commandes déjà enregistrées et le bouton Administration du parcours membre permettent d’ouvrir l’espace privé et de choisir un salon approprié dans **Panneaux**.

Les commandes CLI de bootstrap, sauvegarde et import restent des outils de déploiement hors ligne ; elles ne sont pas nécessaires pour les opérations d’administration courantes.
