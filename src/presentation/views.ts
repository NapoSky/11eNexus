import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  escapeMarkdown,
  type InteractionEditReplyOptions,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  DomainError,
  normalize,
  type Actor,
  type Candidate,
  type Locale,
  type Proposal,
} from '../domain/model.js';
import type { Repository, Session } from '../application/ports.js';
import { translator } from './i18n.js';

export type View = InteractionEditReplyOptions;
export type Mode = 'active' | 'archived' | 'all' | 'subscribed';
const row = (...items: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(items);
const button = (label: string, action: string, token: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder()
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setCustomId(`nx:${action}:${token}`);
export function session(
  repository: Repository,
  actorId: string,
  kind: string,
  data: Record<string, unknown>,
): Session {
  const value: Session = {
    id: randomUUID(),
    userId: actorId,
    kind,
    data,
    expiresAt: Date.now() + 15 * 60000,
  };
  repository.saveSession(value);
  return value;
}
export function ownedSession(repository: Repository, actorId: string, token: string): Session {
  const value = repository.session(token);
  if (!value || value.expiresAt <= Date.now() || value.userId !== actorId)
    throw new DomainError('expired');
  return value;
}
export class Views {
  constructor(
    private readonly repository: Repository,
    private readonly guildId: string,
  ) {}
  browse(actor: Actor, language: Locale, mode: Mode = 'active', page = 0, query = ''): View {
    const t = translator(language);
    const catalogue = this.repository.games();
    const games = catalogue
      .filter((g) =>
        mode === 'subscribed'
          ? this.repository.subscribed(g.id, actor.id)
          : mode === 'all' || g.state === mode,
      )
      .filter(
        (g) =>
          !query || [g.name, ...g.aliases].some((s) => normalize(s).includes(normalize(query))),
      )
      .sort((a, b) => a.name.localeCompare(b.name, language));
    const maximum = Math.max(0, Math.ceil(games.length / 20) - 1);
    page = Math.max(0, Math.min(page, maximum));
    const slice = games.slice(page * 20, page * 20 + 20);
    const s = session(this.repository, actor.id, 'browse', {
      mode,
      page,
      query,
      ids: slice.map((g) => g.id),
    });
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (slice.length)
      components.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`nx:game:${s.id}`)
            .setPlaceholder(t('chooseGame'))
            .addOptions(
              slice.map((g) => ({
                label: g.name.slice(0, 100),
                value: g.id,
                description: t(g.state),
              })),
            ),
        ),
      );
    components.push(
      row(
        new StringSelectMenuBuilder().setCustomId(`nx:filter:${s.id}`).addOptions(
          (['active', 'archived', 'all', 'subscribed'] as const).map((value) => ({
            label: value === 'subscribed' ? t('notifications') : t(value),
            value,
            default: value === mode,
          })),
        ),
      ),
    );
    components.push(
      row(
        button(t('previous'), 'previous', s.id).setDisabled(page === 0),
        button(t('next'), 'next', s.id).setDisabled(page === maximum),
        button(t('search'), 'search', s.id),
        button(t('myRequests'), 'requests', s.id),
      ),
    );
    if (actor.admin) components.push(row(button(t('admin'), 'admin', s.id)));
    return {
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor(0x557c5b)
          .setTitle(
            t(
              mode === 'subscribed'
                ? 'notifications'
                : mode === 'archived'
                  ? 'archivedGames'
                  : mode === 'all'
                    ? 'games'
                    : 'activeGames',
            ),
          )
          .setDescription(
            [
              t('catalogueSummary', {
                total: catalogue.length,
                active: catalogue.filter((g) => g.state === 'active').length,
                archived: catalogue.filter((g) => g.state === 'archived').length,
              }),
              catalogue.some((g) => g.state === 'unavailable')
                ? t('unavailableCount', {
                    count: catalogue.filter((g) => g.state === 'unavailable').length,
                  })
                : '',
              mode === 'active' ? t('catalogueFilterHint') : '',
              slice.length
                ? slice.map((g) => `**${escapeMarkdown(g.name)}** · ${t(g.state)}`).join('\n')
                : t('empty'),
            ]
              .filter(Boolean)
              .join('\n\n'),
          )
          .setFooter({ text: `${page + 1}/${maximum + 1} · ${games.length}` }),
      ],
      components,
      attachments: [],
      files: [],
      allowedMentions: { parse: [] },
    };
  }
  game(actor: Actor, language: Locale, id: string, notice?: string): View {
    const game = this.repository.game(id);
    if (!game || game.retired) throw new DomainError('notFound');
    const t = translator(language);
    const subscribed = this.repository.subscribed(id, actor.id);
    const s = session(this.repository, actor.id, 'game', { gameId: id });
    const controls: MessageActionRowComponentBuilder[] = [];
    if (game.state === 'active' && game.channelId)
      controls.push(
        new ButtonBuilder()
          .setLabel(t('open'))
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${this.guildId}/${game.channelId}`),
      );
    if (game.state === 'archived')
      controls.push(
        button(t('activate'), 'activate', s.id, ButtonStyle.Primary).setDisabled(game.blocked),
      );
    controls.push(
      button(
        t(subscribed ? 'unsubscribe' : 'subscribe'),
        subscribed ? 'unsubscribe' : 'subscribe',
        s.id,
      ).setDisabled(game.blocked || game.roleState === 'missing'),
    );
    const embed = new EmbedBuilder()
      .setColor(0x557c5b)
      .setTitle(game.name.slice(0, 256))
      .setDescription(
        [
          t(game.state),
          t(subscribed ? 'subscribed' : 'unsubscribed'),
          game.roleState === 'present' && game.roleId && !game.blocked
            ? t('mentionHint', { role: `<@&${game.roleId}>` })
            : '',
          game.state === 'archived' ? t('archiveHint') : '',
          game.roleState === 'recycled' ? t('recycledHint') : '',
          game.blocked ? t('blocked') : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    const asset = game.assetId ? this.repository.asset(game.assetId) : null;
    if (asset) embed.setThumbnail('attachment://game.png');
    if (game.rawgId)
      embed.setURL(`https://rawg.io/games/${game.rawgId}`).setFooter({ text: 'Source: RAWG' });
    const components = [row(...controls)];
    if (game.state === 'active')
      components.push(
        row(
          button(t('notify'), 'notify', s.id).setDisabled(
            game.blocked || game.roleState !== 'present',
          ),
          button(t('back'), 'back', s.id),
        ),
      );
    else components.push(row(button(t('back'), 'back', s.id)));
    return {
      content: notice || null,
      embeds: [embed],
      components,
      attachments: [],
      files: asset ? [new AttachmentBuilder(Buffer.from(asset.bytes), { name: 'game.png' })] : [],
      allowedMentions: { parse: [] },
    };
  }
  candidates(
    actor: Actor,
    language: Locale,
    query: string,
    candidates: Candidate[],
    error?: string,
  ): View {
    const t = translator(language);
    const list = candidates.slice(0, 10);
    const s = session(this.repository, actor.id, 'candidates', {
      query,
      ids: list.map((c) => c.id),
    });
    const controls: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (list.length)
      controls.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`nx:candidate:${s.id}`)
            .setPlaceholder(t('selectCandidate'))
            .addOptions(
              list.map((c) => ({
                label: c.name.slice(0, 100),
                description:
                  [c.studio, c.released].filter(Boolean).join(' · ').slice(0, 100) || 'RAWG',
                value: String(c.id),
              })),
            ),
        ),
      );
    controls.push(row(button(t('notFoundGame'), 'manual', s.id), button(t('back'), 'back', s.id)));
    return {
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor(0x557c5b)
          .setTitle(t('suggest'))
          .setURL('https://rawg.io')
          .setDescription(error || t(list.length ? 'candidate' : 'empty'))
          .setFooter({ text: 'Source: RAWG' }),
      ],
      components: controls,
      attachments: [],
      files: [],
      allowedMentions: { parse: [] },
    };
  }
  candidate(
    actor: Actor,
    language: Locale,
    candidate: Candidate,
    assetId: string | null,
    query = candidate.name,
  ): View {
    const t = translator(language);
    const s = session(this.repository, actor.id, 'candidate', {
      rawgId: candidate.id,
      assetId,
      query,
      name: candidate.name,
    });
    const asset = assetId ? this.repository.asset(assetId) : null;
    const embed = new EmbedBuilder()
      .setColor(0x557c5b)
      .setTitle(candidate.name.slice(0, 256))
      .setURL(candidate.url)
      .setDescription(
        [
          t('confirmCreate', { game: candidate.name }),
          candidate.studio,
          candidate.released,
          t('quotaHint'),
          t('noMentions'),
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
      .setFooter({ text: 'Source: RAWG' });
    if (asset) embed.setThumbnail('attachment://game.png');
    return {
      content: null,
      embeds: [embed],
      components: [
        row(
          button(t('create'), 'create', s.id, ButtonStyle.Success).setDisabled(!asset),
          button(t('different'), 'results', s.id),
          button(t('notFoundGame'), 'manual', s.id),
          button(t('back'), 'back', s.id),
        ),
      ],
      attachments: [],
      files: asset ? [new AttachmentBuilder(Buffer.from(asset.bytes), { name: 'game.png' })] : [],
      allowedMentions: { parse: [] },
    };
  }
  proposals(actor: Actor, language: Locale, admin = false, page = 0): View {
    if (admin && !actor.admin) throw new DomainError('adminOnly');
    const t = translator(language);
    const all = this.repository.proposals(admin ? undefined : actor.id);
    const maximum = Math.max(0, Math.ceil(all.length / 20) - 1);
    page = Math.max(0, Math.min(page, maximum));
    const proposals = all.slice(page * 20, page * 20 + 20);
    const s = session(this.repository, actor.id, 'proposals', {
      admin,
      page,
      ids: proposals.map((p) => p.id),
    });
    const components = [
      row(
        button(t('previous'), 'previous', s.id).setDisabled(page === 0),
        button(t('next'), 'next', s.id).setDisabled(page === maximum),
        button(t('back'), 'back', s.id),
      ),
    ];
    if (proposals.length)
      components.unshift(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`nx:proposal:${s.id}`)
            .setPlaceholder(t('myRequests'))
            .addOptions(
              proposals.map((p) => ({
                label: p.name.slice(0, 100),
                value: p.id,
                description: t(p.status),
              })),
            ),
        ),
      );
    return {
      content: null,
      embeds: [
        new EmbedBuilder()
          .setTitle(t(admin ? 'admin' : 'myRequests'))
          .setDescription(
            proposals.length
              ? proposals.map((p) => `${escapeMarkdown(p.name)} · ${t(p.status)}`).join('\n')
              : t('noProposals'),
          )
          .setFooter({ text: `${page + 1}/${maximum + 1} · ${all.length}` })
          .setColor(0x557c5b),
      ],
      components,
      attachments: [],
      files: [],
      allowedMentions: { parse: [] },
    };
  }
  proposal(actor: Actor, language: Locale, p: Proposal): View {
    if (p.actorId !== actor.id && !actor.admin) throw new DomainError('forbidden');
    const t = translator(language);
    const s = session(this.repository, actor.id, 'proposal', { proposalId: p.id });
    const controls: MessageActionRowComponentBuilder[] = [button(t('back'), 'requests', s.id)];
    if (p.status === 'needs_info' && p.actorId === actor.id)
      controls.unshift(button(t('amend'), 'amend', s.id, ButtonStyle.Primary));
    const game = p.gameId ? this.repository.game(p.gameId) : undefined;
    if (game?.state === 'active' && game.channelId && !game.retired)
      controls.unshift(
        new ButtonBuilder()
          .setLabel(t('open'))
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${this.guildId}/${game.channelId}`),
      );
    return {
      content: null,
      embeds: [
        new EmbedBuilder()
          .setTitle(p.name.slice(0, 256))
          .setDescription(
            [
              t(p.status),
              p.reason ? `${t('reason')}: ${escapeMarkdown(p.reason)}` : '',
              p.url,
              actor.admin && p.status === 'pending' ? t('approveHint') : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
      ],
      components: [row(...controls)],
      attachments: [],
      files: [],
      allowedMentions: { parse: [] },
    };
  }
}
