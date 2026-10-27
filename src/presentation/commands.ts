import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
export function commands() {
  return [
    new SlashCommandBuilder()
      .setName('nexus')
      .setDescription('Open 11eNexus')
      .setDescriptionLocalizations({ fr: 'Ouvrir 11eNexus' }),
    new SlashCommandBuilder()
      .setName('nexus-admin')
      .setDescription('Administer 11eNexus')
      .setDescriptionLocalizations({ fr: 'Administrer 11eNexus' })
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((c) =>
        c
          .setName('setup')
          .setDescription('Publish or repair the bilingual panel')
          .setDescriptionLocalizations({ fr: 'Publier ou réparer le panneau bilingue' })
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Dedicated panel channel')
              .setDescriptionLocalizations({ fr: 'Salon dédié au panneau' })
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('status')
          .setDescription('Show service state')
          .setDescriptionLocalizations({ fr: 'Afficher l’état du service' }),
      )
      .addSubcommand((c) =>
        c
          .setName('proposals')
          .setDescription('Review game proposals')
          .setDescriptionLocalizations({ fr: 'Consulter les propositions de jeux' }),
      )
      .addSubcommand((c) =>
        c
          .setName('approve')
          .setDescription('Approve a manually verified game')
          .setDescriptionLocalizations({ fr: 'Accepter un jeu vérifié manuellement' })
          .addStringOption((o) =>
            o
              .setName('proposal')
              .setDescription('Proposal')
              .setDescriptionLocalizations({ fr: 'Proposition' })
              .setAutocomplete(true)
              .setRequired(true),
          )
          .addAttachmentOption((o) =>
            o
              .setName('icon')
              .setDescription('Verified game icon')
              .setDescriptionLocalizations({ fr: 'Icône du jeu vérifiée' }),
          )
          .addStringOption((o) =>
            o
              .setName('parent')
              .setDescription('Reuse an existing parent game icon')
              .setDescriptionLocalizations({ fr: 'Réutiliser l’icône d’un jeu parent existant' })
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('clarify')
          .setDescription('Ask the requester to complete their proposal')
          .setDescriptionLocalizations({
            fr: 'Demander des précisions au membre sur sa proposition',
          })
          .addStringOption((o) =>
            o
              .setName('proposal')
              .setDescription('Proposal')
              .setDescriptionLocalizations({ fr: 'Proposition' })
              .setAutocomplete(true)
              .setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Information required from the member')
              .setDescriptionLocalizations({ fr: 'Précisions attendues du membre' })
              .setRequired(true)
              .setMaxLength(500),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('reject')
          .setDescription('Reject a proposal with a reason')
          .setDescriptionLocalizations({ fr: 'Refuser une proposition avec un motif' })
          .addStringOption((o) =>
            o
              .setName('proposal')
              .setDescription('Proposal')
              .setDescriptionLocalizations({ fr: 'Proposition' })
              .setAutocomplete(true)
              .setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('reason')
              .setDescription('Reason visible to the member')
              .setDescriptionLocalizations({ fr: 'Motif visible par le membre' })
              .setRequired(true)
              .setMaxLength(500),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('reconcile')
          .setDescription('Observe Discord and run rotation')
          .setDescriptionLocalizations({ fr: 'Réconcilier Discord et appliquer la rotation' }),
      )
      .addSubcommand((c) =>
        c
          .setName('edit')
          .setDescription('Correct a catalogue title and search aliases')
          .setDescriptionLocalizations({
            fr: 'Corriger le titre et les alias de recherche du catalogue',
          })
          .addStringOption((o) =>
            o
              .setName('game')
              .setDescription('Game')
              .setDescriptionLocalizations({ fr: 'Jeu' })
              .setAutocomplete(true)
              .setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName('name')
              .setDescription('Canonical title')
              .setDescriptionLocalizations({ fr: 'Titre canonique' })
              .setRequired(true)
              .setMaxLength(100),
          )
          .addStringOption((o) =>
            o
              .setName('aliases')
              .setDescription('Comma-separated search aliases')
              .setDescriptionLocalizations({ fr: 'Alias de recherche séparés par des virgules' })
              .setMaxLength(1000),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('block')
          .setDescription('Suspend management of a game')
          .setDescriptionLocalizations({ fr: 'Suspendre la gestion d’un jeu' })
          .addStringOption((o) =>
            o
              .setName('game')
              .setDescription('Game')
              .setDescriptionLocalizations({ fr: 'Jeu' })
              .setAutocomplete(true)
              .setRequired(true),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('unblock')
          .setDescription('Resume management of a game')
          .setDescriptionLocalizations({ fr: 'Reprendre la gestion d’un jeu' })
          .addStringOption((o) =>
            o
              .setName('game')
              .setDescription('Game')
              .setDescriptionLocalizations({ fr: 'Jeu' })
              .setAutocomplete(true)
              .setRequired(true),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('retire')
          .setDescription('Remove an archived game from the catalogue; keep its history')
          .setDescriptionLocalizations({
            fr: 'Retirer un jeu archivé du catalogue, en conservant son historique',
          })
          .addStringOption((o) =>
            o
              .setName('game')
              .setDescription('Game')
              .setDescriptionLocalizations({ fr: 'Jeu' })
              .setAutocomplete(true)
              .setRequired(true),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('repair')
          .setDescription('Explicitly reattach a game after a partial operation')
          .setDescriptionLocalizations({
            fr: 'Rattacher explicitement un jeu après une opération partielle',
          })
          .addStringOption((o) =>
            o
              .setName('game')
              .setDescription('Game')
              .setDescriptionLocalizations({ fr: 'Jeu' })
              .setAutocomplete(true)
              .setRequired(true),
          )
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Verified main game channel')
              .setDescriptionLocalizations({ fr: 'Salon principal du jeu vérifié' })
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)
              .setRequired(true),
          )
          .addRoleOption((o) =>
            o
              .setName('role')
              .setDescription('Verified notification role')
              .setDescriptionLocalizations({ fr: 'Rôle de notifications vérifié' })
              .setRequired(true),
          ),
      ),
  ].map((c) => c.toJSON());
}
