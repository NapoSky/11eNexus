import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown,
  type InteractionEditReplyOptions,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DAY,
  DomainError,
  normalize,
  type Actor,
  type Candidate,
  type Locale,
  type Proposal,
} from '../domain/model.js';
import type { Repository, Session } from '../application/ports.js';
import { translator } from './i18n.js';

export interface View {
  flags: MessageFlags.IsComponentsV2;
  components: ContainerBuilder[];
  attachments: [];
  files: AttachmentBuilder[];
  allowedMentions: { parse: [] };
}
export type Mode = 'active' | 'archived' | 'all' | 'subscribed';
export type Destination =
  | { kind: 'home' }
  | { kind: 'browse'; mode: Mode; page: number; query: string }
  | { kind: 'proposals'; admin: boolean; page: number }
  | { kind: 'proposal'; id: string; admin: boolean; page: number };
const modes: Mode[] = ['active', 'archived', 'all', 'subscribed'];
const start: Destination = { kind: 'browse', mode: 'active', page: 0, query: '' };
const text = (content: string) => new TextDisplayBuilder().setContent(content);
const separator = () => new SeparatorBuilder().setDivider(true);
const row = (...items: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(items);
const button = (label: string, action: string, token?: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder()
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setCustomId(`nx:${action}${token ? `:${token}` : ''}`);
const link = (label: string, url: string) =>
  new ButtonBuilder().setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(url);
const view = (container: ContainerBuilder, files: AttachmentBuilder[] = []): View => ({
  flags: MessageFlags.IsComponentsV2,
  components: [container],
  files,
  attachments: [],
  allowedMentions: { parse: [] },
});
const heading = (container: ContainerBuilder, title: string, helper: string, image?: string) => {
  const content = text(`## ${escapeMarkdown(title)}\n${helper}`);
  if (image)
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(content)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(image).setDescription(title)),
    );
  else container.addTextDisplayComponents(content);
  return container;
};
export const editView = (payload: View): InteractionEditReplyOptions => ({
  content: null,
  embeds: [],
  ...payload,
});
export function session(
  repository: Repository,
  actorId: string,
  kind: string,
  data: Record<string, unknown>,
): Session {
  const value = {
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
export function destination(s?: Session): Destination {
  if (!s) return start;
  if (s.kind === 'browse')
    return {
      kind: 'browse',
      mode: modes.includes(s.data.mode as Mode) ? (s.data.mode as Mode) : 'active',
      page: Number(s.data.page) || 0,
      query: typeof s.data.query === 'string' ? s.data.query : '',
    };
  if (s.kind === 'proposals')
    return { kind: 'proposals', admin: s.data.admin === true, page: Number(s.data.page) || 0 };
  const saved = s.data.returnTo;
  if (!saved || typeof saved !== 'object') return start;
  const r = saved as Record<string, unknown>;
  if (r.kind === 'home') return { kind: 'home' };
  if (r.kind === 'browse' && modes.includes(r.mode as Mode))
    return {
      kind: 'browse',
      mode: r.mode as Mode,
      page: Number(r.page) || 0,
      query: typeof r.query === 'string' ? r.query.slice(0, 100) : '',
    };
  if (r.kind === 'proposals')
    return { kind: 'proposals', admin: r.admin === true, page: Number(r.page) || 0 };
  if (r.kind === 'proposal' && typeof r.id === 'string')
    return { kind: 'proposal', id: r.id, admin: r.admin === true, page: Number(r.page) || 0 };
  return start;
}

export class Views {
  constructor(
    private readonly repository: Repository,
    private readonly guildId: string,
  ) {}
  private navigation(language: Locale, token: string) {
    const t = translator(language);
    return row(button(t('back'), 'back', token), button(t('home'), 'home', token));
  }
  private quota(actor: Actor, language: Locale): { blocked: boolean; hint: string } {
    const t = translator(language);
    if (actor.admin) return { blocked: false, hint: t('a.adminQuota') };
    if (
      this.repository
        .operations()
        .some((op) => op.actorId === actor.id && ['pending', 'review'].includes(op.status))
    )
      return { blocked: true, hint: t('quotaPending') };
    const at = this.repository.cooldown(actor.id);
    const remaining = at === null ? 0 : at + DAY - Date.now();
    return remaining > 0
      ? { blocked: true, hint: t('cooldown', { minutes: Math.ceil(remaining / 60000) }) }
      : { blocked: false, hint: t('quotaHint') };
  }
  panel(): View {
    const fr = translator('fr'),
      en = translator('en');
    const c = heading(
      new ContainerBuilder().setAccentColor(0x557c5b),
      '11eNexus',
      `${fr('panelIntro')}\n${en('panelIntro')}`,
      'attachment://logo_nexus.png',
    );
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL('attachment://banner_nexus.png')
          .setDescription('11eNexus'),
      ),
    );
    c.addSeparatorComponents(separator()).addTextDisplayComponents(
      text(`### ${fr('play')} / ${en('play')}\n${fr('panelPlayHelp')}\n${en('panelPlayHelp')}`),
    );
    c.addActionRowComponents(
      row(button('Jeux actifs / Active games', 'games'), button('Archives', 'archives')),
    );
    c.addSeparatorComponents(separator()).addTextDisplayComponents(
      text(`### Notifications\n${fr('panelNotificationsHelp')}\n${en('panelNotificationsHelp')}`),
    );
    c.addActionRowComponents(row(button('Mes notifications / My notifications', 'notifications')));
    c.addSeparatorComponents(separator()).addTextDisplayComponents(
      text(`### ${fr('addGame')} / ${en('addGame')}\n${fr('panelAddHelp')}\n${en('panelAddHelp')}`),
    );
    c.addActionRowComponents(
      row(button('Ajouter / Add', 'propose', undefined, ButtonStyle.Success)),
    );
    c.addTextDisplayComponents(text(`-# ${fr('personalMenuHint')}\n-# ${en('personalMenuHint')}`));
    return view(c, [
      new AttachmentBuilder(resolve('logo_nexus.png')),
      new AttachmentBuilder(resolve('banner_nexus.png')),
    ]);
  }
  movedPanel(channelId: string): View {
    const fr = translator('fr'),
      en = translator('en');
    return view(
      new ContainerBuilder()
        .setAccentColor(0x557c5b)
        .addTextDisplayComponents(text(`## 11eNexus\n${fr('panelMoved')}\n${en('panelMoved')}`))
        .addActionRowComponents(
          row(link('Ouvrir / Open', `https://discord.com/channels/${this.guildId}/${channelId}`)),
        ),
    );
  }
  home(actor: Actor, language: Locale): View {
    const t = translator(language);
    const s = session(this.repository, actor.id, 'home', { returnTo: { kind: 'home' } });
    const games = this.repository.games();
    const c = heading(new ContainerBuilder().setAccentColor(0x557c5b), '11eNexus', t('homeHelp'));
    c.addTextDisplayComponents(
      text(
        t('catalogueSummary', {
          total: games.length,
          active: games.filter((g) => g.state === 'active').length,
          archived: games.filter((g) => g.state === 'archived').length,
        }),
      ),
    );
    c.addSeparatorComponents(separator()).addTextDisplayComponents(
      text(`### ${t('play')}\n${t('panelPlayHelp')}`),
    );
    c.addActionRowComponents(
      row(button(t('activeGames'), 'games', s.id), button(t('archivedGames'), 'archives', s.id)),
    );
    c.addTextDisplayComponents(text(`### ${t('notifications')}\n${t('panelNotificationsHelp')}`));
    c.addActionRowComponents(row(button(t('myNotifications'), 'notifications', s.id)));
    c.addTextDisplayComponents(text(`### ${t('addGame')}\n${t('panelAddHelp')}`));
    c.addActionRowComponents(
      row(
        button(t('addGame'), 'propose', s.id, ButtonStyle.Success),
        button(t('myRequests'), 'requests', s.id),
      ),
    );
    if (actor.admin) c.addActionRowComponents(row(button(t('admin'), 'admin', s.id)));
    return view(c);
  }
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
          !query ||
          [g.name, ...g.aliases].some((name) => normalize(name).includes(normalize(query))),
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
      returnTo: { kind: 'home' },
    });
    const c = heading(
      new ContainerBuilder().setAccentColor(0x557c5b),
      t(
        mode === 'subscribed'
          ? 'myNotifications'
          : mode === 'archived'
            ? 'archivedGames'
            : mode === 'all'
              ? 'games'
              : 'activeGames',
      ),
      t(`browseHelp_${mode}`),
    );
    c.addTextDisplayComponents(
      text(
        t('catalogueSummary', {
          total: catalogue.length,
          active: catalogue.filter((g) => g.state === 'active').length,
          archived: catalogue.filter((g) => g.state === 'archived').length,
        }),
      ),
    );
    if (catalogue.some((g) => g.state === 'unavailable'))
      c.addTextDisplayComponents(
        text(
          t('unavailableCount', {
            count: catalogue.filter((g) => g.state === 'unavailable').length,
          }),
        ),
      );
    c.addActionRowComponents(
      row(
        ...modes.map((value) =>
          button(
            t(
              value === 'subscribed'
                ? 'myNotifications'
                : value === 'active'
                  ? 'activeGames'
                  : value === 'archived'
                    ? 'archivedGames'
                    : 'all',
            ),
            `browse-${value}`,
            s.id,
          ).setDisabled(value === mode),
        ),
      ),
    );
    c.addSeparatorComponents(separator());
    if (query)
      c.addTextDisplayComponents(text(t('searchSummary', { query: escapeMarkdown(query) })));
    if (slice.length) {
      c.addTextDisplayComponents(text(t('chooseGameHelp'))).addActionRowComponents(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`nx:game:${s.id}`)
            .setPlaceholder(t('chooseGame'))
            .addOptions(
              slice.map((g) => ({
                label: g.name.slice(0, 100),
                value: g.id,
                description:
                  `${t(g.state)}${this.repository.subscribed(g.id, actor.id) ? ` · ${t('notificationsOnShort')}` : ''}`.slice(
                    0,
                    100,
                  ),
              })),
            ),
        ),
      );
      c.addTextDisplayComponents(
        text(`-# ${t('pageSummary', { page: page + 1, pages: maximum + 1, count: games.length })}`),
      );
      if (maximum)
        c.addActionRowComponents(
          row(
            button(t('previous'), 'previous', s.id).setDisabled(page === 0),
            button(t('next'), 'next', s.id).setDisabled(page === maximum),
          ),
        );
    } else c.addTextDisplayComponents(text(t(query ? 'emptySearchHelp' : `emptyHelp_${mode}`)));
    const controls = [
      button(t('search'), 'search', s.id),
      button(t('addGame'), 'propose', s.id, ButtonStyle.Success),
    ];
    if (query) controls.push(button(t('clearSearch'), 'clear', s.id));
    controls.push(button(t('myRequests'), 'requests', s.id), button(t('home'), 'home', s.id));
    c.addSeparatorComponents(separator()).addActionRowComponents(row(...controls));
    if (actor.admin) c.addActionRowComponents(row(button(t('admin'), 'admin', s.id)));
    return view(c);
  }
  game(
    actor: Actor,
    language: Locale,
    id: string,
    notice?: string,
    returnTo: Destination = start,
  ): View {
    const game = this.repository.game(id);
    if (!game || game.retired) throw new DomainError('notFound');
    const t = translator(language),
      subscribed = this.repository.subscribed(id, actor.id);
    const s = session(this.repository, actor.id, 'game', { gameId: id, returnTo });
    const asset = game.assetId ? this.repository.asset(game.assetId) : null;
    const unavailable =
      game.blocked || game.state === 'unavailable' || game.roleState === 'missing';
    const c = heading(
      new ContainerBuilder().setAccentColor(unavailable ? 0xaa5c5c : 0x557c5b),
      game.name,
      t(`gameHelp_${game.state}`),
      asset ? 'attachment://game.png' : undefined,
    );
    if (notice) c.addTextDisplayComponents(text(`✅ ${notice}`));
    c.addTextDisplayComponents(text(`**${t(game.state)}**`));
    if (unavailable) c.addTextDisplayComponents(text(t('gameNeedsHelp')));
    if (game.state === 'active' && game.channelId)
      c.addActionRowComponents(
        row(link(t('open'), `https://discord.com/channels/${this.guildId}/${game.channelId}`)),
      );
    if (game.state === 'archived') {
      const quota = this.quota(actor, language);
      c.addTextDisplayComponents(text(`${t('archiveHint')}\n-# ${quota.hint}`));
      c.addActionRowComponents(
        row(
          button(t('activate'), 'activate', s.id, ButtonStyle.Primary).setDisabled(
            unavailable || quota.blocked,
          ),
        ),
      );
    }
    c.addSeparatorComponents(separator()).addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(
            `### ${t('notifications')}\n${t(subscribed ? 'subscribed' : 'unsubscribed')}\n${t('subscriptionHelp')}`,
          ),
        )
        .setButtonAccessory(
          button(
            t(subscribed ? 'unsubscribe' : 'subscribe'),
            subscribed ? 'unsubscribe' : 'subscribe',
            s.id,
            subscribed ? ButtonStyle.Danger : ButtonStyle.Success,
          ).setDisabled(game.blocked || game.roleState === 'missing'),
        ),
    );
    if (game.roleState === 'recycled') c.addTextDisplayComponents(text(t('recycledHint')));
    if (game.state === 'active' && game.roleState === 'present' && game.roleId && !game.blocked) {
      c.addTextDisplayComponents(text(t('mentionHint', { role: `<@&${game.roleId}>` })));
      c.addActionRowComponents(row(button(t('notify'), 'notify', s.id, ButtonStyle.Primary)));
    }
    c.addSeparatorComponents(separator()).addActionRowComponents(this.navigation(language, s.id));
    if (game.rawgId)
      c.addTextDisplayComponents(text(`-# [Source: RAWG](https://rawg.io/games/${game.rawgId})`));
    return view(
      c,
      asset ? [new AttachmentBuilder(Buffer.from(asset.bytes), { name: 'game.png' })] : [],
    );
  }
  candidates(
    actor: Actor,
    language: Locale,
    query: string,
    candidates: Candidate[],
    error?: string,
    returnTo: Destination = start,
  ): View {
    const t = translator(language),
      list = candidates.slice(0, 10);
    const s = session(this.repository, actor.id, 'candidates', {
      query,
      ids: list.map((c) => c.id),
      returnTo,
    });
    const c = heading(
      new ContainerBuilder().setAccentColor(0x557c5b),
      t('addGame'),
      t('candidate'),
    );
    c.addTextDisplayComponents(text(t('searchSummary', { query: escapeMarkdown(query) })));
    if (error) c.addTextDisplayComponents(text(error));
    if (list.length)
      c.addActionRowComponents(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`nx:candidate:${s.id}`)
            .setPlaceholder(t('selectCandidate'))
            .addOptions(
              list.map((candidate) => ({
                label: candidate.name.slice(0, 100),
                value: String(candidate.id),
                description:
                  [candidate.studio, candidate.released]
                    .filter(Boolean)
                    .join(' · ')
                    .slice(0, 100) || 'RAWG',
              })),
            ),
        ),
      );
    else c.addTextDisplayComponents(text(t('noCandidateHelp')));
    c.addTextDisplayComponents(text(t('manualRequestHelp')));
    c.addActionRowComponents(
      row(
        button(t('changeSearch'), 'propose', s.id),
        button(t('notFoundGame'), 'manual', s.id, ButtonStyle.Success),
      ),
    );
    c.addActionRowComponents(this.navigation(language, s.id)).addTextDisplayComponents(
      text('-# [Source: RAWG](https://rawg.io)'),
    );
    return view(c);
  }
  candidate(
    actor: Actor,
    language: Locale,
    candidate: Candidate,
    assetId: string | null,
    query = candidate.name,
    returnTo: Destination = start,
  ): View {
    const t = translator(language),
      asset = assetId ? this.repository.asset(assetId) : null;
    const s = session(this.repository, actor.id, 'candidate', {
      rawgId: candidate.id,
      assetId,
      query,
      name: candidate.name,
      returnTo,
    });
    const c = heading(
      new ContainerBuilder().setAccentColor(0x557c5b),
      candidate.name,
      t('candidateConfirmHelp'),
      asset ? 'attachment://game.png' : undefined,
    );
    const details = [
      candidate.studio ? `${t('studio')}: ${escapeMarkdown(candidate.studio.slice(0, 500))}` : '',
      candidate.released
        ? `${t('releaseDate')}: ${escapeMarkdown(candidate.released.slice(0, 30))}`
        : '',
    ].filter(Boolean);
    if (details.length) c.addTextDisplayComponents(text(details.join('\n')));
    c.addTextDisplayComponents(text(t('confirmCreate', { game: escapeMarkdown(candidate.name) })));
    const quota = this.quota(actor, language);
    c.addTextDisplayComponents(text(`-# ${quota.hint}\n-# ${t('noMentions')}`));
    if (!asset) c.addTextDisplayComponents(text(t('candidateImageHelp')));
    c.addActionRowComponents(
      row(
        button(t('create'), 'create', s.id, ButtonStyle.Success).setDisabled(
          !asset || quota.blocked,
        ),
        button(t('different'), 'results', s.id),
        button(t('notFoundGame'), 'manual', s.id, ButtonStyle.Success),
      ),
    );
    c.addActionRowComponents(this.navigation(language, s.id)).addTextDisplayComponents(
      text(`-# [Source: RAWG](https://rawg.io/games/${candidate.id})`),
    );
    return view(
      c,
      asset ? [new AttachmentBuilder(Buffer.from(asset.bytes), { name: 'game.png' })] : [],
    );
  }
  proposals(actor: Actor, language: Locale, admin = false, page = 0): View {
    if (admin && !actor.admin) throw new DomainError('adminOnly');
    const t = translator(language),
      all = this.repository.proposals(admin ? undefined : actor.id);
    const maximum = Math.max(0, Math.ceil(all.length / 20) - 1);
    page = Math.max(0, Math.min(page, maximum));
    const proposals = all.slice(page * 20, page * 20 + 20);
    const s = session(this.repository, actor.id, 'proposals', {
      admin,
      page,
      ids: proposals.map((p) => p.id),
      returnTo: { kind: 'home' },
    });
    const c = heading(
      new ContainerBuilder().setAccentColor(0x557c5b),
      t(admin ? 'adminRequests' : 'myRequests'),
      t(admin ? 'adminRequestsHelp' : 'requestsHelp'),
    );
    if (proposals.length) {
      c.addActionRowComponents(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(`nx:proposal:${s.id}`)
            .setPlaceholder(t('chooseRequest'))
            .addOptions(
              proposals.map((p) => ({
                label: p.name.slice(0, 100),
                value: p.id,
                description: t(p.status),
              })),
            ),
        ),
      );
      c.addTextDisplayComponents(
        text(`-# ${t('pageSummary', { page: page + 1, pages: maximum + 1, count: all.length })}`),
      );
      if (maximum)
        c.addActionRowComponents(
          row(
            button(t('previous'), 'previous', s.id).setDisabled(page === 0),
            button(t('next'), 'next', s.id).setDisabled(page === maximum),
          ),
        );
    } else c.addTextDisplayComponents(text(t(admin ? 'noAdminRequests' : 'noRequestsHelp')));
    if (!admin)
      c.addActionRowComponents(row(button(t('addGame'), 'propose', s.id, ButtonStyle.Success)));
    c.addActionRowComponents(this.navigation(language, s.id));
    return view(c);
  }
  proposal(
    actor: Actor,
    language: Locale,
    p: Proposal,
    returnTo: Destination = { kind: 'proposals', admin: false, page: 0 },
    notice?: string,
  ): View {
    if (p.actorId !== actor.id && !actor.admin) throw new DomainError('forbidden');
    const t = translator(language);
    const s = session(this.repository, actor.id, 'proposal', { proposalId: p.id, returnTo });
    const c = heading(
      new ContainerBuilder().setAccentColor(0x557c5b),
      p.name,
      t(`requestHelp_${p.status}`),
    );
    if (notice) c.addTextDisplayComponents(text(`✅ ${notice}`));
    c.addTextDisplayComponents(text(`**${t(p.status)}**`));
    if (p.reason)
      c.addTextDisplayComponents(text(`**${t('reason')}**\n${escapeMarkdown(p.reason)}`));
    if (actor.admin && ['pending', 'needs_info'].includes(p.status))
      c.addTextDisplayComponents(text(t('approveHint')));
    const controls = [link(t('officialUrl'), p.url)];
    if (p.status === 'needs_info' && p.actorId === actor.id)
      controls.push(button(t('amend'), 'amend', s.id, ButtonStyle.Primary));
    const game = p.gameId ? this.repository.game(p.gameId) : undefined;
    if (game && !game.retired) {
      controls.push(button(t('viewGame'), 'proposal-game', s.id, ButtonStyle.Primary));
      if (game.state === 'active' && game.channelId)
        controls.push(
          link(t('open'), `https://discord.com/channels/${this.guildId}/${game.channelId}`),
        );
    }
    c.addActionRowComponents(row(...controls))
      .addSeparatorComponents(separator())
      .addActionRowComponents(this.navigation(language, s.id));
    return view(c);
  }
  feedback(
    language: Locale,
    message: string,
    error = false,
    recoverable = true,
    s?: Session,
  ): View {
    const t = translator(language);
    const c = heading(
      new ContainerBuilder().setAccentColor(error ? 0xaa5c5c : 0x557c5b),
      t(error ? 'helpTitle' : 'doneTitle'),
      message,
    );
    if (recoverable) {
      if (s) {
        const next = session(this.repository, s.userId, 'feedback', { returnTo: destination(s) });
        c.addActionRowComponents(this.navigation(language, next.id));
      } else c.addActionRowComponents(row(button(t('home'), 'home')));
    }
    return view(c);
  }
}
