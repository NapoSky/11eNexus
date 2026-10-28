import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import {
  validateGameIdentity,
  DomainError,
  normalize,
  requireAdmin,
  type Actor,
  type Locale,
} from '../domain/model.js';
import type { Repository } from '../application/ports.js';
import {
  entityVersion,
  type AdminPlan,
  type MaintenancePreview,
  type MaintenanceProgress,
} from '../application/administration.js';
import { session, type View } from './views.js';
import { translator, proposalStatusKey } from './i18n.js';

export interface AdminDraft {
  name: string;
  url: string;
  assetId: string | null;
  rawgId: number | null;
  proposalId?: string;
  proposalVersion?: string;
  identityConfirmed?: boolean;
  back: AdminRoute;
}
export type AdminRoute =
  | { page: 'home' }
  | { page: 'status' }
  | { page: 'requests' | 'catalogue'; filter: string; query: string; index: number }
  | { page: 'request' | 'game'; id: string; back: AdminRoute }
  | { page: 'prepare'; draft: AdminDraft }
  | {
      page: 'results';
      draft: AdminDraft;
      query: string;
      items: { id: number; name: string; studio: string; released: string | null }[];
    }
  | { page: 'parents'; draft: AdminDraft; query: string; index: number }
  | { page: 'attach'; proposalId: string; query: string; index: number; back: AdminRoute }
  | {
      page: 'repair';
      id: string;
      channelId?: string;
      roleId?: string;
      channelName?: string;
      roleName?: string;
      back: AdminRoute;
    }
  | {
      page: 'maintenance';
      preview?: MaintenancePreview;
      index?: number;
      progress?: MaintenanceProgress;
    }
  | { page: 'panels'; target: 'member' | 'staff'; channelId?: string; channelName?: string }
  | { page: 'confirm'; plan: AdminPlan; details: string[]; back: AdminRoute; index?: number };
const home: AdminRoute = { page: 'home' };
const text = (value: string) => new TextDisplayBuilder().setContent(value);
const row = (...items: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(items);
const button = (label: string, action: string, id?: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder()
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setCustomId(`na:${action}${id ? `:${id}` : ''}`);
export function adminParent(route: AdminRoute): AdminRoute {
  if ('back' in route) return route.back;
  if ('draft' in route)
    return route.page === 'prepare' ? route.draft.back : { page: 'prepare', draft: route.draft };
  return home;
}
export class AdminViews {
  constructor(
    readonly repository: Repository,
    readonly guildId: string,
    readonly maxGames = 150,
  ) {}
  working(language: Locale): View {
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [
        new ContainerBuilder()
          .setAccentColor(0x5865f2)
          .addTextDisplayComponents(text(translator(language)('a.applying'))),
      ],
      files: [],
      attachments: [],
      allowedMentions: { parse: [] },
    };
  }
  entry(): View {
    const fr = translator('fr'),
      en = translator('en');
    const c = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        text(`## 11eNexus · Administration\n${fr('a.entryHelp')}\n${en('a.entryHelp')}`),
      )
      .addActionRowComponents(row(button('Administration / Admin', 'home')));
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [c],
      files: [],
      attachments: [],
      allowedMentions: { parse: [] },
    };
  }
  private clamp(route: AdminRoute): AdminRoute {
    const repo = this.repository;
    if ('index' in route && route.page !== 'maintenance' && route.page !== 'confirm') {
      let length = 0;
      if (route.page === 'requests')
        length = repo
          .proposals()
          .filter(
            (p) =>
              (route.filter === 'all' ||
                (route.filter === 'open' && ['pending', 'needs_info'].includes(p.status)) ||
                p.status === route.filter) &&
              (!route.query || normalize(p.name).includes(normalize(route.query))),
          ).length;
      else if (route.page === 'parents')
        length = repo
          .games()
          .filter(
            (g) =>
              g.assetId &&
              repo.asset(g.assetId) &&
              (!route.query || normalize(g.name).includes(normalize(route.query))),
          ).length;
      else
        length = repo
          .games(true)
          .filter((g) =>
            route.page === 'attach'
              ? !g.retired && !g.blocked
              : route.filter === 'all'
                ? !g.retired
                : route.filter === 'retired'
                  ? g.retired
                  : !g.retired && g.state === route.filter,
          )
          .filter(
            (g) =>
              !route.query ||
              [g.name, ...g.aliases].some((n) => normalize(n).includes(normalize(route.query))),
          ).length;
      return {
        ...route,
        index: Math.max(0, Math.min(route.index, Math.max(0, Math.ceil(length / 20) - 1))),
      };
    }
    return route;
  }
  render(
    actor: Actor,
    language: Locale,
    requestedRoute: AdminRoute = home,
    notice?: string,
    error = false,
  ): View {
    requireAdmin(actor);
    const route = this.clamp(requestedRoute);
    const t = translator(language),
      repo = this.repository;
    // Asset IDs stay at the session root so normal asset maintenance protects form previews.
    const assetId =
      'draft' in route
        ? route.draft.assetId
        : route.page === 'confirm' && route.plan.action.kind === 'create'
          ? route.plan.action.input.assetId
          : undefined;
    const s = session(repo, actor.id, 'admin', {
      route,
      assetId,
      entity:
        route.page === 'game'
          ? entityVersion(repo.game(route.id))
          : route.page === 'request'
            ? entityVersion(repo.proposal(route.id))
            : undefined,
    });
    const b = (key: string, action: string, style = ButtonStyle.Secondary) =>
      button(t(key), action, s.id, style);
    const c = new ContainerBuilder().setAccentColor(error ? 0xaa5c5c : 0x5865f2);
    const line = (value: string) => c.addTextDisplayComponents(text(value));
    const title = (key: string, help: string) => line(`## ${t(key)}\n${t(help)}`);
    const controls = (...items: MessageActionRowComponentBuilder[]) =>
      c.addActionRowComponents(row(...items));
    const select = (
      action: string,
      placeholder: string,
      options: { label: string; value: string; description?: string }[],
    ) =>
      controls(
        new StringSelectMenuBuilder()
          .setCustomId(`na:${action}:${s.id}`)
          .setPlaceholder(t(placeholder))
          .addOptions(
            options.map((o) => ({
              ...o,
              label: o.label.slice(0, 100),
              description: o.description?.slice(0, 100),
            })),
          ),
      );
    const paginate = (length: number, index: number, size = 20) => {
      if (length > size) {
        line(
          `-# ${t('pageSummary', { page: index + 1, pages: Math.ceil(length / size), count: length })}`,
        );
        controls(
          b('previous', 'previous').setDisabled(index === 0),
          b('next', 'next').setDisabled((index + 1) * size >= length),
        );
      }
    };
    const slice = <T>(items: T[], index: number) => items.slice(index * 20, index * 20 + 20);
    if (notice) line(`${error ? '⚠️' : '✅'} ${notice}`);
    if (route.page === 'home' || route.page === 'status') {
      title(
        route.page === 'status' ? 'a.statusTitle' : 'a.title',
        route.page === 'status' ? 'a.statusHelp' : 'a.homeHelp',
      );
      const games = repo.games(),
        last = repo.get<{ at: number; rotation: boolean }>('lastReconciliation');
      line(
        t('catalogueSummary', {
          total: games.length,
          active: games.filter((g) => g.state === 'active').length,
          archived: games.filter((g) => g.state === 'archived').length,
        }),
      );
      line(
        t('a.pendingSummary', {
          requests: repo.proposals().filter((p) => ['pending', 'needs_info'].includes(p.status))
            .length,
          operations: repo.operations().filter((o) => ['pending', 'review'].includes(o.status))
            .length,
        }),
      );
      line(last ? t('a.lastSync', { date: `<t:${Math.floor(last.at / 1000)}:R>` }) : t('a.noSync'));
      if (route.page === 'home')
        for (const [key, help, action] of [
          ['a.requests', 'a.requestsHelp', 'requests'],
          ['a.catalogue', 'a.catalogueHelp', 'catalogue'],
          ['a.maintenance', 'a.maintenanceHelp', 'maintenance'],
          ['a.panels', 'a.panelsHelp', 'panels'],
        ]) {
          line(`### ${t(key!)}\n${t(help!)}`);
          controls(b(key!, action!));
        }
    } else if (route.page === 'requests') {
      title('a.requests', 'a.requestsHelp');
      line(`-# ${t('a.historyRetention')}`);
      const all = repo
        .proposals()
        .filter(
          (p) =>
            (route.filter === 'all' ||
              (route.filter === 'open' && ['pending', 'needs_info'].includes(p.status)) ||
              p.status === route.filter) &&
            (!route.query || normalize(p.name).includes(normalize(route.query))),
        );
      controls(
        ...['open', 'needs_info', 'all'].map((filter) =>
          b(`a.filter_${filter}`, `filter-${filter}`).setDisabled(filter === route.filter),
        ),
      );
      if (all.length)
        select(
          'request',
          'chooseRequest',
          slice(all, route.index).map((p) => ({
            label: p.name,
            value: p.id,
            description: t(proposalStatusKey(p.status)),
          })),
        );
      else line(t('noAdminRequests'));
      paginate(all.length, route.index);
      controls(b('search', 'search'), b('clearSearch', 'clear').setDisabled(!route.query));
    } else if (route.page === 'catalogue' || route.page === 'attach') {
      title(
        route.page === 'attach' ? 'a.attach' : 'a.catalogue',
        route.page === 'attach' ? 'a.attachHelp' : 'a.catalogueHelp',
      );
      const all = repo
        .games(true)
        .filter((g) =>
          route.page === 'attach'
            ? !g.retired && !g.blocked
            : route.filter === 'all' || route.filter === 'retired'
              ? route.filter === 'all'
                ? !g.retired
                : g.retired
              : !g.retired && g.state === route.filter,
        )
        .filter(
          (g) =>
            !route.query ||
            [g.name, ...g.aliases].some((n) => normalize(n).includes(normalize(route.query))),
        )
        .sort((a, b) => a.name.localeCompare(b.name, language));
      if (route.page === 'catalogue')
        controls(
          ...['all', 'active', 'archived', 'unavailable', 'retired'].map((filter) =>
            b(
              filter === 'all' ? 'all' : filter === 'retired' ? 'a.retired' : filter,
              `filter-${filter}`,
            ).setDisabled(route.filter === filter),
          ),
        );
      if (all.length)
        select(
          route.page === 'attach' ? 'attach-game' : 'game',
          'chooseGame',
          slice(all, route.index).map((g) => ({
            label: g.name,
            value: g.id,
            description: t(g.retired ? 'a.retired' : g.state),
          })),
        );
      else line(t('empty'));
      paginate(all.length, route.index);
      controls(
        b('search', 'search'),
        b('clearSearch', 'clear').setDisabled(!route.query),
        ...(route.page === 'catalogue' ? [b('addGame', 'add', ButtonStyle.Success)] : []),
      );
    } else if (route.page === 'request') {
      const p = repo.proposal(route.id);
      if (!p) throw new DomainError('notFound');
      line(`## ${escapeMarkdown(p.name)}\n**${t(proposalStatusKey(p.status))}** · <@${p.actorId}>`);
      line(t('a.requestHelp'));
      line(`[${t('officialUrl')}](${p.url})`);
      if (p.reason) line(`${t('reason')}: ${escapeMarkdown(p.reason)}`);
      if (['pending', 'needs_info'].includes(p.status))
        controls(
          b('a.approve', 'approve', ButtonStyle.Success),
          b('a.clarify', 'clarify', ButtonStyle.Primary),
          b('a.reject', 'reject', ButtonStyle.Danger),
        );
      if (['pending', 'needs_info'].includes(p.status))
        controls(b('a.attach', 'attach', ButtonStyle.Primary));
      if (p.gameId) controls(b('viewGame', 'request-game', ButtonStyle.Primary));
    } else if (route.page === 'game') {
      const g = repo.game(route.id);
      if (!g) throw new DomainError('notFound');
      line(
        `## ${escapeMarkdown(g.name)}\n**${t(g.retired ? 'a.retired' : g.state)}${g.blocked ? ` · ${t('a.suspended')}` : ''}**`,
      );
      line(t('a.gameHelp'));
      line(
        `${t('a.channel')}: ${g.channelId ? `<#${g.channelId}>` : t('a.missing')}\n${t('a.role')}: ${g.roleId ? `<@&${g.roleId}>` : t('a.missing')}\n${t('a.subscribers', { count: repo.subscribers(g.id).length })}`,
      );
      if (g.assetId && repo.asset(g.assetId))
        c.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(text(t('a.currentIcon')))
            .setThumbnailAccessory(
              new ThumbnailBuilder().setURL('attachment://game.png').setDescription(g.name),
            ),
        );
      if (g.roleState === 'missing') line(t('a.missingRole'));
      if (g.roleState === 'recycled') line(t('recycledHint'));
      if (g.aliases.length)
        line(
          `${t('a.aliases')}: ${g.aliases
            .slice(0, 5)
            .map((a) => escapeMarkdown(a))
            .join(', ')}`,
        );
      if (g.aliases.length > 5) line(t('a.moreAliases', { count: g.aliases.length - 5 }));
      const pending = repo
        .operations()
        .filter((o) => o.gameId === g.id && ['pending', 'review'].includes(o.status));
      if (pending.length) line(t('a.gamePending', { count: pending.length }));
      if (!g.retired) {
        controls(
          b('a.edit', 'edit', ButtonStyle.Primary),
          b(
            g.state === 'active' ? 'a.archive' : 'activate',
            g.state === 'active' ? 'archive' : 'activate',
            ButtonStyle.Primary,
          ).setDisabled(g.blocked || g.state === 'unavailable' || pending.length > 0),
          b(
            g.blocked ? 'a.resume' : 'a.suspend',
            g.blocked ? 'unblock' : 'block',
            ButtonStyle.Primary,
          ),
        );
        controls(
          b('a.repair', 'repair', ButtonStyle.Primary),
          b('a.retire', 'retire', ButtonStyle.Danger),
        );
      } else line(t('a.retiredHelp'));
    } else if (route.page === 'prepare') {
      const draft = route.draft;
      title(draft.proposalId ? 'a.approve' : 'addGame', 'a.prepareHelp');
      line(
        `**${escapeMarkdown(draft.name || t('a.unnamed'))}**${draft.url ? `\n[${t('officialUrl')}](${draft.url})` : ''}`,
      );
      const asset = draft.assetId ? repo.asset(draft.assetId) : null;
      let identityValid = false;
      try {
        validateGameIdentity(draft.name, draft.url);
        identityValid = true;
      } catch {
        /* The progress below explains the missing or invalid identity. */
      }
      line(
        `### ${t('a.progressTitle')}\n${t(identityValid ? (draft.identityConfirmed ? 'a.identityConfirmed' : 'a.identityFilled') : 'a.identityMissing')}\n${t(asset ? 'a.visualReady' : 'a.visualMissing')}`,
      );
      line(t(!identityValid ? 'a.nextIdentity' : !asset ? 'a.nextVisual' : 'a.nextReview'));
      if (asset)
        c.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(text(t('a.iconReady')))
            .setThumbnailAccessory(
              new ThumbnailBuilder()
                .setURL('attachment://game.png')
                .setDescription(draft.name || 'Game'),
            ),
        );
      controls(
        b('a.identity', 'identity', ButtonStyle.Primary),
        b('a.rawg', 'rawg'),
        b('a.parent', 'parent'),
        b('a.upload', 'upload', ButtonStyle.Primary),
      );
      const full = repo.games().length >= this.maxGames;
      if (full) line(t('capacity'));
      controls(
        b('a.preview', 'preview', ButtonStyle.Success).setDisabled(
          !asset || !identityValid || full,
        ),
      );
      line(`-# ${t('a.adminQuota')} ${t('noMentions')}`);
    } else if (route.page === 'results') {
      title('a.rawg', 'candidate');
      line(t('searchSummary', { query: escapeMarkdown(route.query) }));
      if (route.items.length)
        select(
          'candidate',
          'selectCandidate',
          route.items.slice(0, 10).map((i) => ({
            label: i.name,
            value: String(i.id),
            description: [i.studio, i.released].filter(Boolean).join(' · ') || 'RAWG',
          })),
        );
      else line(t('a.noRawgResults'));
      controls(b('changeSearch', 'rawg'), b('a.manual', 'manual', ButtonStyle.Primary));
      line('-# [Source: RAWG](https://rawg.io)');
    } else if (route.page === 'parents') {
      title('a.parent', 'a.parentHelp');
      const games = repo
        .games()
        .filter(
          (g) =>
            g.assetId &&
            repo.asset(g.assetId) &&
            (!route.query || normalize(g.name).includes(normalize(route.query))),
        )
        .sort((a, b) => a.name.localeCompare(b.name, language));
      if (games.length)
        select(
          'parent-game',
          'chooseGame',
          slice(games, route.index).map((g) => ({ label: g.name, value: g.id })),
        );
      else line(t('empty'));
      paginate(games.length, route.index);
      controls(b('search', 'search'), b('clearSearch', 'clear').setDisabled(!route.query));
    } else if (route.page === 'repair') {
      title('a.repair', 'a.repairHelp');
      line(
        `**${escapeMarkdown(repo.game(route.id)?.name || '')}**\n${t('a.channel')}: ${escapeMarkdown(route.channelName || t('a.choose'))}\n${t('a.role')}: ${escapeMarkdown(route.roleName || t('a.choose'))}`,
      );
      controls(
        new ChannelSelectMenuBuilder()
          .setCustomId(`na:repair-channel:${s.id}`)
          .setPlaceholder(t('a.chooseChannel'))
          .setChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildForum,
            ChannelType.GuildMedia,
          ),
      );
      controls(
        new RoleSelectMenuBuilder()
          .setCustomId(`na:repair-role:${s.id}`)
          .setPlaceholder(t('a.chooseRole')),
      );
      line(t('a.repairPermissions'));
      controls(
        b('a.preview', 'preview', ButtonStyle.Primary).setDisabled(
          !route.channelId || !route.roleId,
        ),
      );
    } else if (route.page === 'maintenance') {
      title('a.maintenance', 'a.maintenanceHelp');
      const preview = route.preview;
      if (route.progress) {
        line(`### ${t('a.diagnosticRunning')}`);
        line(t(`a.diagnostic_${route.progress.phase}`, { ...route.progress }));
        line(t('a.diagnosticLeave'));
      } else if (preview) {
        line(t('a.diagnosticComplete'));
        const report = preview.report;
        if (!report.complete) line(t('a.auditIncomplete'));
        line(
          t('a.diagnostic', {
            changes: preview.changes.length,
            missing: report.missing.length,
            roles: report.roles.filter((r) => r.status === 'untracked').length,
            channels: report.channels.filter((r) => r.status === 'untracked').length,
          }),
        );
        line(
          t('a.capacity', {
            games: report.catalogueGames,
            roles: report.roles.length,
            archives: report.categories.length - 1,
          }),
        );
        const entries = [
          ...report.nameDifferences.map(
            (d) => `${escapeMarkdown(d.game.slice(0, 60))} · ${t('a.nameDifference')}`,
          ),
          ...preview.candidates.map(
            (id) => `${escapeMarkdown(repo.game(id)?.name || '')} · ${t('a.rotationCandidate')}`,
          ),
          ...preview.unverified.map(
            (name) => `${escapeMarkdown(name)} · ${t('a.unverifiedActivity')}`,
          ),
          ...preview.changes.map(
            (d) =>
              `${escapeMarkdown(d.name)} · ${t(`a.change_${d.kind}`, { count: d.count || 0 })}`,
          ),
          ...report.missing.map(
            (m) =>
              `${escapeMarkdown(m.game)} · ${t(m.kind === 'role' ? 'a.missingRole' : 'a.missingChannel')}`,
          ),
          ...report.roles
            .filter((r) => r.status === 'untracked')
            .map((r) => `${t('a.untrackedRole')} · ${escapeMarkdown(r.name)}`),
          ...report.channels
            .filter((r) => r.status === 'untracked')
            .map((r) => `${t('a.untrackedChannel')} · ${escapeMarkdown(r.name)}`),
        ];
        const index = Math.max(
          0,
          Math.min(route.index || 0, Math.max(0, Math.ceil(entries.length / 10) - 1)),
        );
        line(entries.slice(index * 10, index * 10 + 10).join('\n') || t('a.noChanges'));
        paginate(entries.length, index, 10);
        line(
          t('a.rotationSummary', {
            count: preview.candidates.length,
            unverified: preview.unverified.length,
          }),
        );
        const pending = repo.operations().filter((o) => ['pending', 'review'].includes(o.status));
        if (pending.length) {
          line(t('a.pendingHelp'));
          select(
            'problem-game',
            'chooseGame',
            [...new Set(pending.map((o) => o.gameId))]
              .slice(0, 20)
              .map((id) => ({ label: repo.game(id)?.name || t('a.missing'), value: id })),
          );
        }
        controls(
          b('a.reconcile', 'reconcile', ButtonStyle.Primary),
          b('a.rotate', 'rotate', ButtonStyle.Primary),
        );
      } else line(t('a.diagnosticHelp'));
      controls(b('a.diagnose', 'diagnose', ButtonStyle.Primary).setDisabled(!!route.progress));
    } else if (route.page === 'panels') {
      title('a.panels', 'a.panelsHelp');
      controls(
        b('a.memberPanel', 'panel-member').setDisabled(route.target === 'member'),
        b('a.staffPanel', 'panel-staff').setDisabled(route.target === 'staff'),
      );
      line(t(route.target === 'member' ? 'a.memberPanelHelp' : 'a.staffPanelHelp'));
      if (route.channelName) line(`${t('a.channel')}: ${escapeMarkdown(route.channelName)}`);
      controls(
        new ChannelSelectMenuBuilder()
          .setCustomId(`na:panel-channel:${s.id}`)
          .setPlaceholder(t('a.chooseChannel'))
          .setChannelTypes(ChannelType.GuildText),
      );
      controls(b('a.preview', 'preview', ButtonStyle.Primary).setDisabled(!route.channelId));
    } else if (route.page === 'confirm') {
      title('a.confirmTitle', 'a.confirmHelp');
      line(`**${t(`a.action_${route.plan.action.kind}`)}**`);
      const index = Math.max(
        0,
        Math.min(route.index || 0, Math.max(0, Math.ceil(route.details.length / 10) - 1)),
      );
      for (const detail of route.details.slice(index * 10, index * 10 + 10)) line(detail);
      paginate(route.details.length, index, 10);
      if (route.plan.action.kind === 'create') {
        const asset = repo.asset(route.plan.action.input.assetId);
        if (asset)
          c.addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(text(t('a.iconReady')))
              .setThumbnailAccessory(
                new ThumbnailBuilder()
                  .setURL('attachment://game.png')
                  .setDescription(route.plan.action.input.name),
              ),
          );
      }
      if (route.plan.action.kind === 'edit')
        controls(
          b(
            route.plan.action.align ? 'a.catalogueOnly' : 'a.align',
            route.plan.action.align ? 'unalign' : 'align',
            ButtonStyle.Primary,
          ),
        );
      controls(
        b(
          'a.confirm',
          'confirm',
          ['retire', 'reject'].includes(route.plan.action.kind)
            ? ButtonStyle.Danger
            : ButtonStyle.Success,
        ),
        b('a.cancel', 'cancel'),
      );
      line(t('a.confirmExpiry'));
    }
    if (route.page !== 'home') {
      c.addSeparatorComponents(new SeparatorBuilder());
      controls(b('back', 'back'), b('a.home', 'home'));
    } else controls(b('a.refresh', 'home'));
    const imageId =
      route.page === 'prepare'
        ? route.draft.assetId
        : route.page === 'confirm' && route.plan.action.kind === 'create'
          ? route.plan.action.input.assetId
          : route.page === 'game'
            ? repo.game(route.id)?.assetId
            : null;
    const image = imageId ? repo.asset(imageId) : null;
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [c],
      files: image ? [new AttachmentBuilder(Buffer.from(image.bytes), { name: 'game.png' })] : [],
      attachments: [],
      allowedMentions: { parse: [] },
    };
  }
}
