import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown,
} from 'discord.js';
import type { Asset, Game } from '../domain/model.js';
import { DomainError } from '../domain/model.js';
import { translator } from './i18n.js';
import type { View } from './views.js';

export function gameNotificationMessage(game: Game, asset: Asset | null = null): View {
  if (!game.channelId) throw new DomainError('invalidInput');
  const fr = translator('fr'),
    en = translator('en');
  const text = new TextDisplayBuilder().setContent(
    `## ${escapeMarkdown(game.name)}\n${fr('gameNotificationHelp')}\n${en('gameNotificationHelp')}`,
  );
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  if (asset)
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text)
        .setThumbnailAccessory(
          new ThumbnailBuilder()
            .setURL('attachment://game.png')
            .setDescription(
              `${fr('gameNotificationImage', { game: game.name })} / ${en('gameNotificationImage', { game: game.name })}`,
            ),
        ),
    );
  else container.addTextDisplayComponents(text);
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`nx:game-notifications:${game.channelId}`)
        .setStyle(ButtonStyle.Success)
        .setLabel(`${fr('gameNotificationButton')} / ${en('gameNotificationButton')}`),
    ),
  );
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
    attachments: [],
    files: asset ? [new AttachmentBuilder(Buffer.from(asset.bytes), { name: 'game.png' })] : [],
  };
}
