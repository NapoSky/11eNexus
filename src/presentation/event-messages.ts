import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
} from 'discord.js';
import type { CommunityEvent } from '../domain/community-event.js';
import { translator } from './i18n.js';
import type { View } from './views.js';

export function eventMessage(event: CommunityEvent): View {
  const fr = translator('fr'),
    en = translator('en');
  const closed = !['creating', 'active'].includes(event.state);
  const c = new ContainerBuilder()
    .setAccentColor(closed ? 0x747f8d : 0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${escapeMarkdown(event.name)}\n${escapeMarkdown(event.description)}\n-# ${fr('e.game')}: ${escapeMarkdown(event.gameName)}\n\n${fr(closed ? 'e.publicClosed' : 'e.publicHelp')}\n${en(closed ? 'e.publicClosed' : 'e.publicHelp')}`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ne:subscribe:${event.id}`)
          .setStyle(ButtonStyle.Success)
          .setLabel(fr('notifications'))
          .setDisabled(closed),
      ),
    );
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [c],
    files: [],
    attachments: [],
    allowedMentions: { parse: [] },
  };
}
export function eventAnnouncement(event: CommunityEvent, guildId: string): View {
  const fr = translator('fr'),
    en = translator('en');
  const c = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${escapeMarkdown(event.name)}\n${fr('e.announcement')}\n${en('e.announcement')}`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Voir / Open')
          .setURL(`https://discord.com/channels/${guildId}/${event.channelId}`),
      ),
    );
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [c],
    files: [],
    attachments: [],
    allowedMentions: { parse: [] },
  };
}
