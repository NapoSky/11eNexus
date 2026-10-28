import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
export function commands() {
  return [
    new SlashCommandBuilder()
      .setName('nexus')
      .setDescription('Open 11eNexus')
      .setDescriptionLocalizations({ fr: 'Ouvrir 11eNexus' }),
    new SlashCommandBuilder()
      .setName('nexus-admin')
      .setDescription('Open the private administration panel')
      .setDescriptionLocalizations({ fr: 'Ouvrir le panneau privé d’administration' })
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('nexus-status')
      .setDescription('Show 11eNexus status')
      .setDescriptionLocalizations({ fr: 'Afficher l’état de 11eNexus' })
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((command) => command.toJSON());
}
