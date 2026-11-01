# Le 11e — site communautaire

Landing page statique FR/EN pour **https://fo.11e-foxhole.com**, indépendante du runtime de Nexus. Aucun accès à Discord, SQLite ou aux secrets du bot. Aucun cookie, outil de mesure d’audience, contenu intégré ni appel d’API côté visiteur. Images et polices servies localement.

## Construire et prévisualiser

Node 26, sans installation de dépendances :

```sh
node site/scripts/build.mjs
node site/scripts/check.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory site/dist
```

Ouvrir `http://localhost:4173`. `site/dist/` est généré et ignoré par Git. Le catalogue est disponible sans JavaScript ; JavaScript ajoute les filtres et le changement de visuel, sans requête réseau.

Les textes sont dans `locales/fr.json` et `locales/en.json`. Les deux langues ont les mêmes rubriques. Les traductions du bot dans `src/locales/` restent indépendantes : une modification du bot ne doit pas déclencher la publication du site.

## Catalogue et visuels

`content/games.json` contient uniquement les titres publics, slugs éditoriaux, genres et choix « du moment ». La photographie initiale du 31 octobre 2026 couvre 58 jeux. Eco est présenté parmi les jeux du moment, car son forum communautaire actif existe indépendamment du salon historique archivé. Aucun identifiant Discord, effectif ni abonnement n’est publié.

Mettre à jour la sélection et sa date dans les deux langues si les jeux changent. Le site ne prétend pas montrer l’activité en direct. Les liens des jeux ouvrent l’invitation permanente `https://discord.com/invite/11efo`, fournie par l’opérateur et vérifiée en lecture seule pour le serveur multigaming ; le site ne publie aucun lien vers un salon privé. L’invitation `11e` du site du régiment mène à un autre serveur et n’est pas utilisée pour ces boutons.

Les images promotionnelles des jeux proviennent de leurs bibliothèques Steam publiques (`store_item_assets/steam/apps/<appid>/library_hero.jpg`) et le visuel Foxhole de `https://11e-foxhole.com/images/header-background-fr-2560.webp`. Les fichiers sont optimisés en WebP. Les crédits, liens sources et licences des polices figurent sur `/nexus/credits/`. Les visuels restent la propriété des ayants droit et sont exclus de la licence du code. Leur disponibilité publique n’équivaut pas à une licence libre.

## Publication par GitHub Actions

Le workflow `.github/workflows/site.yml` est déclenché **uniquement** par un push sur `main` ou une pull request touchant `site/**`. Une modification de workflow seule, des traductions du bot, du README racine ou des fichiers du bot ne le déclenche pas. Il n’y a pas de déclenchement manuel. Les PR construisent et vérifient ; seuls les pushes sur `main` publient.

La CI utilise Node 26, sans installer les dépendances du bot, vérifie les routes FR/EN, les liens internes et les limites de publication, puis téléverse exclusivement `site/dist/`. Le job de publication est le seul à recevoir `pages: write` et `id-token: write`. Aucun jeton personnel, secret de bot ou déploiement de conteneur n’est nécessaire.

Configuration initiale à effectuer avant le premier déploiement :

1. Dans **Settings → Pages → Build and deployment**, choisir **GitHub Actions**. Vérifier que le plan du dépôt autorise Pages pendant qu’il est privé ; Pages est disponible sur les dépôts publics du plan gratuit.
2. Vérifier le domaine dans les paramètres Pages du compte GitHub si nécessaire, puis définir le domaine personnalisé **fo.11e-foxhole.com** dans les paramètres Pages du dépôt.
3. Chez le fournisseur DNS, créer le **CNAME `fo` → `naposky.github.io`**. Le nom du dépôt n’entre pas dans la cible DNS. Ne pas modifier les enregistrements du domaine principal `11e-foxhole.com`.
4. Pousser les fichiers approuvés sur `main`, attendre le succès de **Community site**, puis activer **Enforce HTTPS** dès que le certificat est prêt.
5. Vérifier publiquement l’accueil, `/en/`, `/nexus/terms/` et `/nexus/privacy/` et leur réponse HTTP avant de renseigner Discord.

Le fichier `CNAME` de l’artefact documente la cible ; il ne configure pas à lui seul le domaine personnalisé d’un déploiement Actions. Les paramètres GitHub et le DNS sont indispensables. Cette contribution ne rend pas le dépôt public et ne configure pas le DNS.

Références : [workflows Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [domaine personnalisé](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

## Liens à renseigner pour Nexus

Après vérification du déploiement HTTPS :

| Champ Discord        | URL                                          |
| -------------------- | -------------------------------------------- |
| Site                 | `https://fo.11e-foxhole.com/`                |
| Terms of Service URL | `https://fo.11e-foxhole.com/nexus/terms/`    |
| Privacy Policy URL   | `https://fo.11e-foxhole.com/nexus/privacy/`  |
| Support / contact    | `https://github.com/NapoSky/11eNexus/issues` |

Les variantes anglaises sont dans `/en/nexus/terms/` et `/en/nexus/privacy/`. Les documents décrivent l’instance officielle et son code actuel. Contact choisi : **NapoSky**, via les issues publiques, avec orientation vers un échange privé pour les données personnelles et la sécurité. Ils ne prétendent pas que Discord a déjà vérifié l’application.

Avant publication, l’opérateur doit relire les textes et confirmer les pratiques d’exploitation, en particulier la rotation des sauvegardes et des journaux et la procédure de traitement privé des demandes. Les durées de rétention du bot suivent son implémentation ; le site ne promet pas de purge des sauvegardes qui n’est pas configurée dans le code.
