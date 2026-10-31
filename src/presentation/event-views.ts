import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  MessageFlags,
  escapeMarkdown,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { normalize, type Actor, type Locale } from '../domain/model.js';
import type { CommunityEvent } from '../domain/community-event.js';
import type { Repository } from '../application/ports.js';
import type { EventPlan } from '../application/events.js';
import { session, type View } from './views.js';
import { translator } from './i18n.js';

export type EventRoute =
  | { page: 'list'; filter: 'active' | 'archived' | 'all'; query: string; index: number }
  | { page: 'games'; query: string; index: number }
  | { page: 'detail'; id: string; back: EventRoute }
  | { page: 'confirm'; plan: EventPlan; back: EventRoute };
export const eventHome = (): EventRoute => ({
  page: 'list',
  filter: 'active',
  query: '',
  index: 0,
});
const row = (...items: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(items);
const text = (content: string) => new TextDisplayBuilder().setContent(content);
const payload = (c: ContainerBuilder): View => ({
  flags: MessageFlags.IsComponentsV2,
  components: [c],
  files: [],
  attachments: [],
  allowedMentions: { parse: [] },
});
export class EventViews {
  constructor(
    readonly repository: Repository,
    readonly guildId: string,
  ) {}
  feedback(_language: Locale, message: string, error = false): View {
    return payload(
      new ContainerBuilder()
        .setAccentColor(error ? 0xaa5c5c : 0x5865f2)
        .addTextDisplayComponents(text(message)),
    );
  }
  notifications(actor: Actor, language: Locale, event: CommunityEvent, enabled: boolean): View {
    const t = translator(language);
    const s = session(this.repository, actor.id, 'event-notifications', { eventId: event.id });
    return payload(
      new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(
          text(
            `## ${escapeMarkdown(event.name)}\n${t(enabled ? 'e.notificationsOn' : 'e.notificationsOff')}\n${t('e.notificationsHelp')}`,
          ),
        )
        .addActionRowComponents(
          row(
            new ButtonBuilder()
              .setCustomId(`ne:${enabled ? 'disable' : 'enable'}:${s.id}`)
              .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
              .setLabel(t(enabled ? 'unsubscribe' : 'subscribe')),
            new ButtonBuilder()
              .setCustomId(`nx:home:${s.id}`)
              .setStyle(ButtonStyle.Secondary)
              .setLabel(t('home')),
          ),
        ),
    );
  }
  admin(actor: Actor, language: Locale, route: EventRoute, notice?: string, error = false): View {
    const t = translator(language),
      repo = this.repository;
    const s = session(repo, actor.id, 'events-admin', { route });
    const c = new ContainerBuilder().setAccentColor(error ? 0xaa5c5c : 0x5865f2);
    const line = (value: string) => c.addTextDisplayComponents(text(value));
    const b = (key: string, action: string, style = ButtonStyle.Secondary) =>
      new ButtonBuilder().setCustomId(`ne:${action}:${s.id}`).setLabel(t(key)).setStyle(style);
    const controls = (...items: MessageActionRowComponentBuilder[]) =>
      c.addActionRowComponents(row(...items));
    const select = (
      action: string,
      options: { label: string; value: string; description?: string }[],
    ) =>
      controls(
        new StringSelectMenuBuilder()
          .setCustomId(`ne:${action}:${s.id}`)
          .setPlaceholder(t('e.choose'))
          .addOptions(
            options.map((o) => ({
              ...o,
              label: o.label.slice(0, 100),
              description: o.description?.slice(0, 100),
            })),
          ),
      );
    const paginate = (count: number, index: number) => {
      if (count > 20) {
        line(t('pageSummary', { page: index + 1, pages: Math.ceil(count / 20), count }));
        controls(
          b('previous', 'previous').setDisabled(index === 0),
          b('next', 'next').setDisabled((index + 1) * 20 >= count),
        );
      }
    };
    if (notice) line(`${error ? '⚠️' : '✅'} ${notice}`);
    line(`## ${t('e.title')}`);
    if (route.page === 'list') {
      line(t('e.listHelp'));
      const all = repo
        .events()
        .filter(
          (e) =>
            e.state !== 'deleted' &&
            (route.filter === 'all' ||
              (route.filter === 'active' ? e.state !== 'archived' : e.state === 'archived')) &&
            normalize(e.name).includes(normalize(route.query)),
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }));
      route.index = Math.max(0, Math.min(route.index, Math.max(0, Math.ceil(all.length / 20) - 1)));
      // Persist the clamped destination used by next/back controls.
      s.data.route = route;
      repo.saveSession(s);
      controls(b('e.create', 'create', ButtonStyle.Success), b('search', 'search'));
      controls(
        b('e.current', 'active').setDisabled(route.filter === 'active'),
        b('archives', 'archived').setDisabled(route.filter === 'archived'),
        b('e.all', 'all').setDisabled(route.filter === 'all'),
      );
      if (all.length)
        select(
          'event',
          all.slice(route.index * 20, route.index * 20 + 20).map((e) => ({
            label: e.name,
            value: e.id,
            description: `${t(`e.state_${e.state}`)} · ${e.gameName}${e.issue ? ' · ⚠️' : ''}`,
          })),
        );
      else line(t('e.empty'));
      paginate(all.length, route.index);
    } else if (route.page === 'games') {
      line(t('e.chooseGame'));
      const games = repo
        .games()
        .filter((g) =>
          [g.name, ...g.aliases].some((n) => normalize(n).includes(normalize(route.query))),
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }));
      route.index = Math.max(
        0,
        Math.min(route.index, Math.max(0, Math.ceil(games.length / 20) - 1)),
      );
      s.data.route = route;
      repo.saveSession(s);
      controls(b('search', 'search'));
      if (games.length)
        select(
          'game',
          games
            .slice(route.index * 20, route.index * 20 + 20)
            .map((g) => ({ label: g.name, value: g.id, description: t(g.state) })),
        );
      else line(t('e.noGames'));
      paginate(games.length, route.index);
    } else if (route.page === 'detail') {
      const event = repo.event(route.id);
      if (!event) return this.feedback(language, t('notFound'), true);
      this.details(c, event, language);
      if (event.state === 'active')
        controls(b('e.edit', 'edit'), b('e.close', 'close', ButtonStyle.Danger));
      else if (event.state === 'creating') controls(b('e.close', 'close', ButtonStyle.Danger));
      else if (event.state === 'closed')
        controls(b('e.finishArchive', 'close', ButtonStyle.Danger));
      if (event.issue) controls(b('e.repair', 'repair', ButtonStyle.Primary));
      if (event.channelId && event.state !== 'deleted')
        controls(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(t('e.openChannel'))
            .setURL(`https://discord.com/channels/${this.guildId}/${event.channelId}`),
        );
    } else {
      const plan = route.plan;
      line(`### ${t('e.preview')}`);
      if (plan.action.kind === 'create') {
        line(
          `**${escapeMarkdown(plan.action.draft.name)}**\n${escapeMarkdown(plan.action.draft.description)}\n${t('e.game')}: ${escapeMarkdown(repo.game(plan.action.draft.gameId)?.name || '')}`,
        );
        line(t('e.createPreview'));
        line(t(plan.announcementChannelId ? 'e.willAnnounce' : 'e.noAnnouncement'));
      } else {
        const event = repo.event(plan.action.eventId);
        if (event) this.details(c, event, language);
        if (plan.action.kind === 'edit')
          line(
            `**${escapeMarkdown(plan.action.name)}**\n${escapeMarkdown(plan.action.description)}`,
          );
        line(
          t(
            plan.action.kind === 'close'
              ? 'e.closePreview'
              : plan.action.kind === 'repair'
                ? 'e.repairPreview'
                : 'e.editPreview',
          ),
        );
      }
      if (plan.replaceMessage) line(t('e.replaceMessage'));
      if (plan.archiveBlocked) line(t('e.closeOnlyPreview'));
      if (plan.action.kind === 'create' && plan.announcementTags.length) {
        line(t('e.tagRequired'));
        select(
          'announcement-tag',
          plan.announcementTags.map((tag) => ({ label: tag.name, value: tag.id })),
        );
        const tagId = plan.action.draft.announcementTagId;
        if (tagId)
          line(
            t('e.selectedTag', {
              name: plan.announcementTags.find((tag) => tag.id === tagId)?.name || '',
            }),
          );
      }
      if (plan.cleanupId) {
        const target = repo.event(plan.cleanupId)!;
        line(
          t('e.cleanupWarning', {
            name: escapeMarkdown(target.name),
            channel: `<#${target.channelId}>`,
            date: `<t:${Math.floor(target.archivedAt! / 1000)}:D>`,
          }),
        );
      }
      line(`-# ${t('e.previewExpiry')}`);
      controls(
        b(
          plan.cleanupId ? 'e.confirmCleanup' : plan.archiveBlocked ? 'e.closeOnly' : 'confirm',
          'confirm',
          plan.cleanupId || plan.action.kind === 'close' ? ButtonStyle.Danger : ButtonStyle.Success,
        ).setDisabled(
          plan.action.kind === 'create' &&
            plan.announcementTags.length > 0 &&
            !plan.action.draft.announcementTagId,
        ),
        b('cancel', 'back'),
      );
      controls(b('e.refresh', 'refresh'));
      if (plan.cleanupId) controls(b('e.closeOnly', 'close-only'));
    }
    if (route.page !== 'confirm') controls(b('back', 'back'), b('e.title', 'home'));
    const adminSession = session(repo, actor.id, 'admin', { route: { page: 'home' } });
    controls(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel(t('a.home'))
        .setCustomId(`na:home:${adminSession.id}`),
    );
    return payload(c);
  }
  private details(c: ContainerBuilder, event: CommunityEvent, language: Locale): void {
    const t = translator(language);
    c.addTextDisplayComponents(
      text(
        `### ${escapeMarkdown(event.name)}\n${escapeMarkdown(event.description)}\n${t('e.game')}: ${escapeMarkdown(event.gameName)}\n${t(`e.state_${event.state}`)}`,
      ),
    );
    if (event.archivedAt)
      c.addTextDisplayComponents(
        text(t('e.archivedOn', { date: `<t:${Math.floor(event.archivedAt / 1000)}:D>` })),
      );
    if (event.state !== 'deleted') {
      const roleState = event.roleDeleted
        ? 'e.roleRemoved'
        : event.roleId
          ? event.state === 'closed' || event.state === 'archived'
            ? 'e.rolePending'
            : 'e.roleReady'
          : 'e.roleNotCreated';
      c.addTextDisplayComponents(text(t(roleState)));
      if (event.messageId && !event.pinned && event.state === 'active')
        c.addTextDisplayComponents(text(t('e.pinPending')));
      if (event.announcementChannelId && !event.announcementId)
        c.addTextDisplayComponents(text(t('e.announcementPending')));
    }
    if (event.issue)
      c.addTextDisplayComponents(text(`⚠️ ${t(event.issue)}\n${t('e.partialHelp')}`));
    const cleanup = this.repository
      .eventOperations()
      .find((o) => o.eventId === event.id && o.cleaned && o.status !== 'completed');
    if (cleanup) c.addTextDisplayComponents(text(t('e.cleanupDone')));
  }
}
