# Administration de 11eNexus

Depuis la 1.0.1, l’administration passe par un accueil Components V2. Les douze sous-commandes Discord de la 1.0 sont retirées lors de la mise à jour des commandes.

## Ouvrir l’administration

Le message permanent du salon staff ouvre un espace personnel. Le bouton **Administration** dans les menus privés et la commande **`/nexus-admin`**, sans option ni sous-commande, conduisent au même accueil.

Les menus sont en français ou en anglais selon la langue Discord de l’admin. Leur consultation et chaque confirmation nécessitent le rôle admin configuré ou la propriété du serveur. Les sessions appartiennent au membre qui les ouvre et expirent après quinze minutes. Une confirmation expire après cinq minutes et ne peut être utilisée qu’une fois. Le bot vérifie à nouveau les droits, les associations et l’état Discord avant l’application.

L’accueil présente les jeux actifs et archivés, les demandes à traiter, les opérations à vérifier, le résumé des événements et la dernière réconciliation réussie. Il propose cinq rubriques, dont **Événements**.

**`/nexus-status`** conserve un raccourci de consultation privé pour les admins : jeux actifs/archivés, demandes ouvertes, opérations à vérifier et dernière réconciliation réussie. Il affiche les données enregistrées, sans lancer de diagnostic ni de réconciliation. Le bouton **Accueil admin** permet ensuite d’ouvrir le panneau.

## Événements

Les parcours restent dans un message personnel Components V2, en français ou anglais selon Discord. Les consultations ne publient rien et les actions sont acquittées avant les appels réseau ou l’attente du verrou. Une réponse ancienne ne remplace pas une navigation plus récente.

1. **Créer un événement** : choisir un jeu connu (recherche et pagination), puis saisir son nom et sa présentation. Le jeu n’est pas relancé et ses abonnés ne sont pas copiés.
2. **Vérifier avant de confirmer** : relire les ressources à créer, les accès Syndiqué, le rôle de notification individuel, le message bilingue épinglé et l’annonce sans mention dans le jeu actif. Si le jeu est archivé ou son salon indisponible, l’annonce est omise. Dans un forum qui exige une étiquette, choisir celle-ci avant de pouvoir confirmer. **Actualiser l’aperçu** conserve la saisie si une ressource pertinente a changé ou si les cinq minutes sont écoulées.
3. **Confirmer** : création immédiate d’un nouveau salon et d’un rôle simple mentionnable, sans icône obligatoire. Les membres choisissent uniquement les mentions de cet événement depuis le message épinglé ; l’accès reste indépendant de cet abonnement. Aucun ancien salon n’est adopté.
4. **Modifier** : mettre à jour le nom du salon, le rôle et la présentation épinglée après un nouvel aperçu. Les messages et abonnés sont conservés.
5. **Fermer et archiver** : masquer l’accès membre, désactiver les contrôles et supprimer le rôle, puis ranger le salon dans **Archives Nexus · Events**. L’historique est conservé pour les admins ; aucun accès de consultation membre ni réouverture d’événement n’est prévu.

La catégorie **Évènements ╠════════════════** se place au-dessus des jeux du moment lorsqu’un événement est ouvert, puis rejoint les archives en étant masquée lorsqu’il n’y en a plus. Les salons actifs sont triés alphabétiquement. Les trois catégories d’archives des jeux restent indépendantes de l’unique archive événementielle de 50 salons. Plusieurs événements peuvent se rapporter au même jeu. Ni les seuils de 48 heures et 30 jours, ni le minimum de quinze jeux ne s’appliquent aux événements.

Si la catégorie gérée porte encore l’un des anciens noms « Événements » ou « Les événements du moment ╠════════════════ », la prochaine opération admin confirmée lui applique ce libellé. Un nom personnalisé manuellement est conservé.

À saturation, l’aperçu désigne l’événement géré dont la date d’archivage est la plus ancienne et annonce la suppression définitive de son salon et de son historique. **Supprimer et archiver** confirme cette cible précise ; Annuler ne supprime rien. **Fermer sans supprimer** ouvre un aperçu sans nettoyage : après confirmation, le salon reste masqué à son emplacement et son rangement attend une place libre. Cette clôture reste possible lorsque l’archive est occupée uniquement par des salons inconnus. Les salons inconnus ne sont jamais proposés au nettoyage. Un changement de cible, d’accès ou une nouvelle activité invalide la confirmation. Une suppression réussie suivie d’un rangement échoué est affichée comme résultat partiel et n’autorise aucune autre suppression.

### Reprise et changements manuels

Un salon fermé reste masqué si son déplacement échoue. Sa fiche indique **Fermé · rangement à terminer**, les étapes confirmées et l’action **Vérifier et reprendre**, avec nouvel aperçu. Un rôle impossible à supprimer ne provoque pas la réouverture du salon. Les contrôles sont aussi refusés côté serveur dès la clôture, même si leur modification visuelle a échoué.

Un épinglage interrompu reprend le message déjà créé. Si un modérateur a supprimé ce message, une réparation explicite peut en publier un nouveau, annoncé dans l’aperçu. Un rôle ou salon supprimé manuellement n’est pas recréé et un salon déplacé hors périmètre n’est pas ramené automatiquement. Une catégorie supprimée nécessite une vérification manuelle ; le bot n’adopte pas une catégorie homonyme.

Après un résultat de création inconnu, la reprise recherche les ressources confirmables grâce aux corrélations du salon, au journal d’audit Discord pour les catégories/rôles, ou aux cent messages/publications récents pour un envoi incertain. En cas de preuve absente ou ambiguë, elle s’arrête et conserve l’opération à vérifier ; elle ne crée pas de doublon. L’archive reste protégée et aucune ressource n’est supprimée pour compenser une création partielle.

Les événements et leurs corrélations sont conservés ; les reçus d’opérations terminées expirent après trente jours, les opérations non résolues restent conservées. La migration `003` s’applique au démarrage sans modifier les migrations précédentes. Aucun nouveau paramètre d’environnement ni réenregistrement des commandes n’est nécessaire pour ajouter cette rubrique ; le serveur doit exécuter la nouvelle image.

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

L’assistant de réparation refuse les rôles des événements et des alertes nouveautés, ainsi que les rôles réservés du serveur : les abonnements de ces fonctions restent séparés.

Un renommage Discord partiellement effectué reste journalisé et bloque le jeu pour vérification ; aucun salon n’est supprimé pour compenser une erreur.

## Maintenance

L’ouverture affiche une aide. **Vérifier maintenant** lit les ressources et l’activité, sans déplacer de salon, changer de rôle, réconcilier la base ou publier d’alerte. Les sessions de navigation restent enregistrées séparément.

Le clic affiche immédiatement la vérification en cours. Le diagnostic peut avancer pendant une réconciliation sans retenir les actions des membres. L’écran indique ensuite la lecture des ressources puis le nombre de jeux vérifiés, avec des mises à jour espacées pour limiter les appels Discord. Le bouton de vérification est désactivé pendant ce scan ; **Retour** et **Accueil admin** restent disponibles. Quitter cet écran arrête la suite du scan après l’appel réseau en cours. Une réponse ou une erreur tardive ne remplace pas le nouveau menu ; un autre menu personnel ouvert dans un message distinct reste indépendant. La fin du diagnostic et les échecs sont signalés explicitement, avec possibilité de réessayer.

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

`setup` remplace l’enregistrement Discord par les accès `/nexus`, `/nexus-admin` et le raccourci `/nexus-status`, actualise le panneau membre et installe le panneau staff. Aucun nouvel import et aucune migration de schéma SQLite ne sont nécessaires. Une ancienne commande encore affichée dans le client ouvre l’accueil admin au lieu d’exécuter ses anciens paramètres.

Le panneau staff utilise le salon déjà enregistré, sinon `ADMIN_CHANNEL_ID`. Pour en choisir un autre lors du premier déploiement, ajouter `--admin-channel ID` à `setup`. Si ce salon n’est pas privé, la publication staff est refusée sans changement de ses permissions. Les commandes déjà enregistrées et le bouton Administration du parcours membre permettent d’ouvrir l’espace privé et de choisir un salon approprié dans **Panneaux**.

Les commandes CLI de bootstrap, sauvegarde et import restent des outils de déploiement hors ligne ; elles ne sont pas nécessaires pour les opérations d’administration courantes.
