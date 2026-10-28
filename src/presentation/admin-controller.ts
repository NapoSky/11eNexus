import { setImmediate } from 'node:timers/promises';
import {
  ChannelType,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  Administration,
  fingerprint,
  entityVersion,
  type AdminAction,
} from '../application/administration.js';
import {
  DomainError,
  channelName,
  normalize,
  requireAdmin,
  type Actor,
  type Locale,
} from '../domain/model.js';
import type { Nexus } from '../application/nexus.js';
import type { Session } from '../application/ports.js';
import type { DiscordCommunity } from '../infrastructure/discord.js';
import { discordAttachment } from '../infrastructure/images.js';
import { logger, type AppLogger } from '../infrastructure/logger.js';
import { AdminViews, adminParent, type AdminDraft, type AdminRoute } from './admin-views.js';
import { editView, ownedSession, Views, type View } from './views.js';
import { locale, translator } from './i18n.js';

type AdminInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ModalSubmitInteraction
  | ChatInputCommandInteraction;
const home: AdminRoute = { page: 'home' };
const list = (page: 'requests' | 'catalogue'): AdminRoute => ({
  page,
  filter: page === 'requests' ? 'open' : 'all',
  query: '',
  index: 0,
});
function ancestor(
  route: AdminRoute,
  page: 'request' | 'catalogue' | 'game',
): AdminRoute | undefined {
  for (let depth = 0; depth < 20; depth++) {
    if (route.page === page) return route;
    if (route.page === 'home') return undefined;
    route = adminParent(route);
  }
  return undefined;
}
const terminal = (err: unknown) =>
  !!err &&
  typeof err === 'object' &&
  'code' in err &&
  ([10062, 10015, 40060, 50027].includes(Number(err.code)) ||
    err.code === 'InteractionAlreadyReplied');
interface ReplyState {
  token: symbol;
  expiresAt: number;
  abort: AbortController;
  writes: Promise<void>;
}
export class AdminController {
  readonly views: AdminViews;
  readonly service: Administration;
  private readonly replies = new Map<string, ReplyState>();
  constructor(
    readonly nexus: Nexus,
    readonly gateway: DiscordCommunity,
    readonly cachedActor: (i: Interaction) => Actor,
    readonly installMember: (channelId?: string) => Promise<void>,
    private readonly log: AppLogger = logger.child({ component: 'admin-interactions' }),
  ) {
    this.views = new AdminViews(nexus.repository, gateway.config.guildId, nexus.policy.maxGames);
    this.service = new Administration(nexus, () => Date.now(), gateway.config.guildId, {
      yield: () => setImmediate(),
    });
  }
  accepts(i: Interaction): boolean {
    return (
      (i.isChatInputCommand() && ['nexus-admin', 'nexus-status'].includes(i.commandName)) ||
      ('customId' in i && /^(na:|nam:|nx:admin(?::|$))/.test(i.customId))
    );
  }
  private replyKey(i: Interaction): string | undefined {
    if ('message' in i && i.message?.flags.has(MessageFlags.Ephemeral))
      return `${i.user.id}:${i.message.id}`;
    return undefined;
  }
  invalidateReply(i: Interaction): void {
    const key = this.replyKey(i);
    if (key) this.replies.get(key)?.abort.abort();
  }
  private beginReply(i: AdminInteraction) {
    const now = Date.now();
    for (const [key, state] of this.replies)
      if (state.expiresAt <= now) {
        state.abort.abort();
        this.replies.delete(key);
      }
    const key = this.replyKey(i),
      existing = key ? this.replies.get(key) : undefined;
    existing?.abort.abort();
    const token = Symbol(),
      abort = new AbortController(),
      state: ReplyState = existing || { token, abort, expiresAt: now, writes: Promise.resolve() };
    Object.assign(state, { token, abort, expiresAt: now + 15 * 60000 });
    if (key) this.replies.set(key, state);
    const current = () => state.token === token && !abort.signal.aborted;
    return {
      signal: abort.signal,
      current,
      write: (payload: View): Promise<void> => {
        const write = state.writes.then(async () => {
          if (current()) await i.editReply(editView(payload));
        });
        // A failed edit must not prevent a newer navigation from displaying its page.
        state.writes = write.catch(() => {});
        return write;
      },
    };
  }
  private draft(route: AdminRoute): AdminDraft {
    if ('draft' in route) return route.draft;
    throw new DomainError('invalidInput');
  }
  private modal(action: string, s: Session, route: AdminRoute, language: Locale): ModalBuilder {
    const t = translator(language),
      m = new ModalBuilder().setCustomId(`nam:${action}:${s.id}`);
    const fields = (
      title: string,
      help: string,
      items: {
        id: string;
        label: string;
        value?: string;
        max?: number;
        paragraph?: boolean;
        required?: boolean;
      }[],
    ) => {
      m.setTitle(t(title).slice(0, 45)).addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`${t(help)}\n\n${t('modalBackHint')}`),
      );
      for (const f of items) {
        const input = new TextInputBuilder()
          .setCustomId(f.id)
          .setStyle(f.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(f.required !== false)
          .setMaxLength(f.max || 100);
        if (f.value) input.setValue(f.value.slice(0, f.max || 100));
        m.addLabelComponents(
          new LabelBuilder().setLabel(t(f.label).slice(0, 45)).setTextInputComponent(input),
        );
      }
    };
    if (action === 'search')
      fields('search', 'a.searchHelp', [
        {
          id: 'query',
          label: 'query',
          value: 'query' in route ? route.query : '',
          required: false,
        },
      ]);
    else if (action === 'reject' || action === 'clarify') {
      if (route.page !== 'request') throw new DomainError('invalidInput');
      fields(`a.${action}`, 'a.reasonHelp', [
        { id: 'reason', label: 'a.reasonLabel', max: 500, paragraph: true },
      ]);
    } else if (action === 'edit') {
      if (route.page !== 'game') throw new DomainError('invalidInput');
      const g = this.nexus.repository.game(route.id);
      if (!g) throw new DomainError('notFound');
      fields('a.edit', 'a.editHelp', [
        { id: 'name', label: 'query', value: g.name },
        {
          id: 'aliases',
          label: 'a.aliases',
          value: g.aliases.join(', '),
          max: 1000,
          paragraph: true,
          required: false,
        },
      ]);
    } else {
      const draft = this.draft(route);
      if (action === 'rawg')
        fields('a.rawg', 'candidate', [
          {
            id: 'query',
            label: 'query',
            value: route.page === 'results' ? route.query : draft.name,
          },
        ]);
      else if (action === 'identity')
        fields('a.identity', 'a.prepareHelp', [
          { id: 'name', label: 'query', value: draft.name },
          { id: 'url', label: 'officialUrl', value: draft.url, max: 500 },
        ]);
      else if (action === 'upload') {
        fields('a.upload', 'a.imageHelp', []);
        m.addLabelComponents(
          new LabelBuilder()
            .setLabel(t('a.imageLabel'))
            .setDescription(t('a.imageFormats'))
            .setFileUploadComponent(
              new FileUploadBuilder()
                .setCustomId('image')
                .setMinValues(1)
                .setMaxValues(1)
                .setRequired(true),
            ),
        );
      } else throw new DomainError('invalidInput');
    }
    return m;
  }
  private async panelRoute(target: 'member' | 'staff'): Promise<AdminRoute> {
    const existing = this.nexus.repository.get<{ channelId: string }>(
      target === 'member' ? 'panel' : 'adminPanel',
    );
    const id =
      existing?.channelId ||
      (target === 'staff'
        ? this.gateway.config.adminChannelId
        : this.gateway.config.panelChannelId);
    if (!id) return { page: 'panels', target };
    const channel = await (await this.gateway.guild()).channels.fetch(id).catch((err: unknown) => {
      if (err && typeof err === 'object' && 'code' in err && Number(err.code) === 10003)
        return null;
      throw err;
    });
    return channel?.type === ChannelType.GuildText
      ? { page: 'panels', target, channelId: channel.id, channelName: channel.name }
      : { page: 'panels', target };
  }
  private async panelState(target: 'member' | 'staff', channelId: string): Promise<string> {
    const repo = this.nexus.repository;
    if (
      repo.games(true).some((g) => g.channelId === channelId) ||
      repo.get<string[]>('archiveCategories')?.includes(channelId) ||
      channelId === this.gateway.config.activeCategoryId
    )
      throw new DomainError('invalidInput');
    const other = repo.get<{ channelId: string }>(target === 'staff' ? 'panel' : 'adminPanel');
    if (other?.channelId === channelId) throw new DomainError('invalidInput');
    const channel =
      target === 'staff'
        ? await this.gateway.staffPanelChannel(channelId)
        : await (await this.gateway.guild()).channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) throw new DomainError('invalidInput');
    return fingerprint({
      id: channel.id,
      overwrites: [...channel.permissionOverwrites.cache.values()]
        .map((o) => ({
          id: o.id,
          type: o.type,
          allow: o.allow.bitfield.toString(),
          deny: o.deny.bitfield.toString(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  async installStaff(channelId?: string): Promise<void> {
    const repo = this.nexus.repository;
    const previous = repo.get<{ channelId: string; messageId: string }>('adminPanel');
    const channel = await this.gateway.staffPanelChannel(channelId || previous?.channelId);
    const payload = this.views.entry();
    let message: Message | undefined;
    if (previous?.channelId === channel.id) {
      try {
        const current = await channel.messages.fetch(previous.messageId);
        if (current.author.id !== this.gateway.client.user!.id)
          throw new DomainError('configuration');
        message = await current.edit(editView(payload));
      } catch (err) {
        if (!err || typeof err !== 'object' || !('code' in err) || Number(err.code) !== 10008)
          throw err;
      }
    }
    if (previous && previous.channelId !== channel.id) {
      try {
        const oldChannel = await (await this.gateway.guild()).channels.fetch(previous.channelId);
        if (oldChannel && 'messages' in oldChannel) {
          const old = await oldChannel.messages.fetch(previous.messageId);
          if (old.author.id !== this.gateway.client.user!.id)
            throw new DomainError('configuration');
          await old.edit(
            editView(new Views(repo, this.gateway.config.guildId).movedPanel(channel.id)),
          );
        }
      } catch (err) {
        if (
          !err ||
          typeof err !== 'object' ||
          !('code' in err) ||
          ![10003, 10008].includes(Number(err.code))
        )
          throw err;
      }
    }
    if (!message) message = await channel.send(payload);
    repo.set('adminPanel', { channelId: channel.id, messageId: message.id });
  }
  private async review(
    actor: Actor,
    route: AdminRoute,
    action: AdminAction,
    language: Locale,
  ): Promise<AdminRoute> {
    const t = translator(language),
      repo = this.nexus.repository;
    const preview = route.page === 'maintenance' ? route.preview : undefined;
    const plan = await this.service.plan(actor, action, preview);
    const details: string[] = [];
    if ('gameId' in action) {
      const g = repo.game(action.gameId);
      if (!g) throw new DomainError('notFound');
      details.push(`**${escapeMarkdown(g.name)}**`);
    }
    if ('proposalId' in action && action.proposalId) {
      const p = repo.proposal(action.proposalId);
      if (!p) throw new DomainError('notFound');
      details.push(`${escapeMarkdown(p.name)} · <@${p.actorId}>`);
    }
    if (action.kind === 'create')
      details.push(
        `**${escapeMarkdown(action.input.name)}**\n[${t('officialUrl')}](${action.input.url})`,
        t('a.createConsequences'),
        t('noMentions'),
        t('a.adminQuota'),
      );
    else if (action.kind === 'activate')
      details.push(t('archiveHint'), t('noMentions'), t('a.adminQuota'));
    else if (action.kind === 'archive') details.push(t('a.archiveConsequences'));
    else if (action.kind === 'retire') {
      if (repo.game(action.gameId)?.state === 'active') throw new DomainError('archiveFirst');
      details.push(t('a.retireConsequences'));
    } else if (action.kind === 'block' || action.kind === 'unblock')
      details.push(t(action.kind === 'block' ? 'a.suspendConsequences' : 'a.resumeConsequences'));
    else if (action.kind === 'edit')
      details.push(
        `${t('a.after')}: **${escapeMarkdown(action.name)}**`,
        `${t('a.aliases')}:`,
        ...action.aliases.map((alias) => `• ${escapeMarkdown(alias)}`),
        t(action.align ? 'a.align' : 'a.catalogueOnly'),
        ...(action.align
          ? [
              `${t('a.channel')}: ${escapeMarkdown(channelName(action.name))}\n${t('a.role')}: ${escapeMarkdown(action.name)}`,
            ]
          : []),
      );
    else if (action.kind === 'repair')
      details.push(
        `${t('a.current')}: ${repo.game(action.gameId)?.channelId ? `<#${repo.game(action.gameId)!.channelId}>` : t('a.missing')} · ${repo.game(action.gameId)?.roleId ? `<@&${repo.game(action.gameId)!.roleId}>` : t('a.missing')}`,
        t('a.after'),
        `${t('a.channel')}: <#${action.channelId}>\n${t('a.role')}: <@&${action.roleId}>`,
        t('a.repairPermissions'),
      );
    else if (action.kind === 'reject' || action.kind === 'clarify')
      details.push(t('a.reasonHelp'), escapeMarkdown(action.reason));
    else if (action.kind === 'attach') details.push(t('a.attachHelp'));
    else if (action.kind === 'reconcile' || action.kind === 'rotate') {
      details.push(
        t(action.kind === 'reconcile' ? 'a.reconcileConsequences' : 'a.rotateConsequences'),
      );
      if (preview) {
        details.push(
          t('a.rotationSummary', {
            count: action.kind === 'rotate' ? preview.candidates.length : 0,
            unverified: preview.unverified.length,
          }),
        );
        if (action.kind === 'rotate')
          details.push(
            ...preview.candidates.map((id) => `• ${escapeMarkdown(repo.game(id)?.name || '')}`),
          );
      }
    } else if (action.kind === 'panel')
      details.push(
        `<#${action.channelId}>`,
        t(action.target === 'member' ? 'a.memberPanelHelp' : 'a.staffPanelHelp'),
        t('a.panelConsequences'),
      );
    return { page: 'confirm', plan, details, back: route, index: 0 };
  }
  async handle(interaction: Interaction): Promise<void> {
    if (!this.accepts(interaction)) return;
    const i = interaction as AdminInteraction;
    const language = locale(i.locale),
      t = translator(language);
    const startedAt = Date.now();
    let phase = 'authorize',
      attempted = false,
      s: Session | undefined,
      route: AdminRoute = home,
      actor: Actor | undefined;
    let replyState: ReturnType<AdminController['beginReply']> | undefined;
    const action = 'customId' in i ? i.customId.split(':')[1] || '' : 'home';
    const context = () => ({
      interactionId: i.id,
      phase,
      elapsedMs: Date.now() - startedAt,
      action: [
        'home',
        'requests',
        'catalogue',
        'maintenance',
        'panels',
        'approve',
        'clarify',
        'reject',
        'confirm',
        'cancel',
        'back',
        'identity',
        'upload',
        'rawg',
        'preview',
        'edit',
        'repair',
        'diagnose',
        'reconcile',
        'rotate',
        'attach',
        'candidate',
        'previous',
        'next',
      ].includes(action)
        ? action
        : 'other',
      page: route.page,
      receivedAgeMs:
        typeof i.createdTimestamp === 'number'
          ? Math.max(0, startedAt - i.createdTimestamp)
          : undefined,
      interactionAgeMs:
        typeof i.createdTimestamp === 'number'
          ? Math.max(0, Date.now() - i.createdTimestamp)
          : undefined,
      gatewayPingMs: this.gateway.client.ws.ping >= 0 ? this.gateway.client.ws.ping : undefined,
      deferred: i.deferred,
      replied: i.replied,
    });
    const respond = async (payload: View) => {
      phase = 'edit_reply';
      if (replyState) await replyState.write(payload);
      else await i.editReply(editView(payload));
      phase = 'handle';
    };
    try {
      actor = this.cachedActor(i);
      requireAdmin(actor);
      const token = 'customId' in i ? i.customId.split(':')[2] : undefined;
      if (token) {
        s = ownedSession(this.nexus.repository, actor.id, token);
        if (s.kind === 'admin') route = s.data.route as AdminRoute;
        else if (!('customId' in i && i.customId.startsWith('nx:admin:')))
          throw new DomainError('expired');
      }
      const modalActions = ['search', 'reject', 'clarify', 'edit', 'rawg', 'identity', 'upload'];
      if (i.isButton() && modalActions.includes(action)) {
        if (s?.kind !== 'admin') throw new DomainError('expired');
        phase = 'show_modal';
        attempted = true;
        await i.showModal(this.modal(action, s, route, language));
        return;
      }
      replyState = this.beginReply(i);
      phase = 'acknowledge';
      attempted = true;
      if (
        (i.isModalSubmit() && i.isFromMessage() && i.message.flags.has(MessageFlags.Ephemeral)) ||
        (!i.isChatInputCommand() && !i.isModalSubmit() && s !== undefined)
      )
        await i.deferUpdate();
      else await i.deferReply({ flags: MessageFlags.Ephemeral });
      this.log.debug({ event: 'admin_interaction_acknowledged', ...context() });
      if (action === 'diagnose' && route.page === 'maintenance')
        await respond(
          this.views.render(actor, language, {
            page: 'maintenance',
            progress: { phase: 'waiting', current: 0, total: 0 },
          }),
        );
      phase = 'authorize_fresh';
      actor = await this.gateway.actor(i.user.id);
      requireAdmin(actor);
      phase = 'handle';
      if (
        s?.kind === 'admin' &&
        (route.page === 'game' || route.page === 'request') &&
        s.data.entity !==
          entityVersion(
            route.page === 'game'
              ? this.nexus.repository.game(route.id)
              : this.nexus.repository.proposal(route.id),
          )
      )
        throw new DomainError('staleAction');
      if (
        i.isChatInputCommand() ||
        ('customId' in i && i.customId.startsWith('nx:admin')) ||
        action === 'home'
      )
        route =
          i.isChatInputCommand() && i.commandName === 'nexus-status' ? { page: 'status' } : home;
      else if (!s) {
        if (action === 'requests') route = list('requests');
        else if (action === 'maintenance') route = { page: 'maintenance' };
        else throw new DomainError('expired');
      } else if (i.isModalSubmit()) {
        if (action === 'search') {
          if (!('query' in route) || !('index' in route)) throw new DomainError('invalidInput');
          route = { ...route, query: i.fields.getTextInputValue('query').trim(), index: 0 };
        } else if (action === 'rawg') {
          const draft = this.draft(route),
            query = i.fields.getTextInputValue('query').trim();
          route = {
            page: 'results',
            draft,
            query,
            items: (await this.nexus.catalogue.search(query)).slice(0, 10),
          };
        } else if (action === 'identity') {
          const draft = this.draft(route);
          const name = i.fields.getTextInputValue('name').trim();
          const url = this.nexus.validateIdentity(name, i.fields.getTextInputValue('url').trim());
          route = { page: 'prepare', draft: { ...draft, name, url, identityConfirmed: true } };
        } else if (action === 'upload') {
          const draft = this.draft(route),
            files = i.fields.getUploadedFiles('image', true);
          if (files.size !== 1 || files.first()!.size > 5_000_000)
            throw new DomainError('invalidImage');
          const asset = await discordAttachment(files.first()!.url);
          this.nexus.repository.saveAsset(asset);
          route = { page: 'prepare', draft: { ...draft, assetId: asset.id } };
        } else if (action === 'edit') {
          if (route.page !== 'game') throw new DomainError('invalidInput');
          route = await this.review(
            actor,
            route,
            {
              kind: 'edit',
              gameId: route.id,
              name: i.fields.getTextInputValue('name').trim(),
              aliases: i.fields
                .getTextInputValue('aliases')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              align: false,
            },
            language,
          );
        } else if (action === 'reject' || action === 'clarify') {
          if (route.page !== 'request') throw new DomainError('invalidInput');
          route = await this.review(
            actor,
            route,
            { kind: action, proposalId: route.id, reason: i.fields.getTextInputValue('reason') },
            language,
          );
        } else throw new DomainError('invalidInput');
      } else if (action === 'back' || action === 'cancel') route = adminParent(route);
      else if (action === 'requests' || action === 'catalogue') route = list(action);
      else if (action === 'maintenance') route = { page: 'maintenance' };
      else if (action === 'panels') route = await this.panelRoute('member');
      else if (action === 'clear') {
        if (!('query' in route) || !('index' in route)) throw new DomainError('invalidInput');
        route = { ...route, query: '', index: 0 };
      } else if (action.startsWith('filter-')) {
        if (route.page !== 'requests' && route.page !== 'catalogue')
          throw new DomainError('invalidInput');
        const filter = action.slice(7);
        if (
          !(
            route.page === 'requests'
              ? ['open', 'needs_info', 'all']
              : ['all', 'active', 'archived', 'unavailable', 'retired']
          ).includes(filter)
        )
          throw new DomainError('invalidInput');
        route = { ...route, filter, index: 0 };
      } else if (action === 'previous' || action === 'next') {
        if (route.page === 'maintenance')
          route = {
            ...route,
            index: Math.max(0, (route.index || 0) + (action === 'next' ? 1 : -1)),
          };
        else if ('index' in route)
          route = {
            ...route,
            index: Math.max(0, (route.index || 0) + (action === 'next' ? 1 : -1)),
          };
        else throw new DomainError('invalidInput');
      } else if (action === 'add') {
        if (route.page !== 'catalogue') throw new DomainError('invalidInput');
        route = {
          page: 'prepare',
          draft: { name: '', url: '', rawgId: null, assetId: null, back: route },
        };
      } else if (action === 'approve') {
        if (route.page !== 'request') throw new DomainError('invalidInput');
        const p = this.nexus.repository.proposal(route.id);
        if (!p || !['pending', 'needs_info'].includes(p.status))
          throw new DomainError('staleAction');
        route = {
          page: 'prepare',
          draft: {
            name: p.name,
            url: p.url,
            rawgId: null,
            assetId: null,
            proposalId: p.id,
            proposalVersion: fingerprint(p),
            back: route,
          },
        };
      } else if (action === 'parent')
        route = { page: 'parents', draft: this.draft(route), query: '', index: 0 };
      else if (action === 'manual') route = { page: 'prepare', draft: this.draft(route) };
      else if (action === 'attach') {
        if (route.page !== 'request') throw new DomainError('invalidInput');
        route = { page: 'attach', proposalId: route.id, query: '', index: 0, back: route };
      } else if (action === 'request-game') {
        if (route.page !== 'request') throw new DomainError('invalidInput');
        const p = this.nexus.repository.proposal(route.id);
        if (!p?.gameId) throw new DomainError('notFound');
        route = { page: 'game', id: p.gameId, back: route };
      } else if (action === 'repair') {
        if (route.page !== 'game') throw new DomainError('invalidInput');
        route = { page: 'repair', id: route.id, back: route };
      } else if (action === 'panel-member' || action === 'panel-staff') {
        if (route.page !== 'panels') throw new DomainError('invalidInput');
        route = await this.panelRoute(action === 'panel-member' ? 'member' : 'staff');
      } else if ('values' in i) {
        const value = i.values[0];
        if (!value) throw new DomainError('invalidInput');
        if (action === 'request' && route.page === 'requests') {
          const p = this.nexus.repository.proposal(value);
          if (!p) throw new DomainError('notFound');
          route = { page: 'request', id: value, back: route };
        } else if (action === 'game' && route.page === 'catalogue')
          route = { page: 'game', id: value, back: route };
        else if (action === 'problem-game' && route.page === 'maintenance')
          route = { page: 'repair', id: value, back: route };
        else if (action === 'candidate' && route.page === 'results') {
          const id = Number(value);
          if (!route.items.some((c) => c.id === id)) throw new DomainError('invalidInput');
          const candidate = await this.nexus.catalogue.get(id);
          const asset = await this.nexus.catalogue.image(candidate).catch(() => null);
          if (asset) this.nexus.repository.saveAsset(asset);
          route = {
            page: 'prepare',
            draft: {
              ...route.draft,
              name: candidate.name,
              url: candidate.url,
              rawgId: candidate.id,
              assetId: asset?.id || null,
              identityConfirmed: true,
            },
          };
        } else if (action === 'parent-game' && route.page === 'parents') {
          const parent = this.nexus.repository.game(value);
          if (!parent?.assetId || parent.retired) throw new DomainError('invalidImage');
          route = { page: 'prepare', draft: { ...route.draft, assetId: parent.assetId } };
        } else if (action === 'attach-game' && route.page === 'attach')
          route = await this.review(
            actor,
            route,
            { kind: 'attach', proposalId: route.proposalId, gameId: value },
            language,
          );
        else if (
          (action === 'repair-channel' || action === 'repair-role') &&
          route.page === 'repair'
        ) {
          const world = await this.nexus.community.snapshot();
          if (!world.complete) throw new DomainError('incomplete');
          if (action === 'repair-channel') {
            const channel = world.channels.find((c) => c.id === value);
            if (!channel || ![0, 5, 15, 16].includes(channel.type))
              throw new DomainError('invalidInput');
            route = { ...route, channelId: value, channelName: channel.name };
          } else {
            const role = world.roles.find((r) => r.id === value);
            if (!role) throw new DomainError('invalidInput');
            route = { ...route, roleId: value, roleName: role.name };
          }
        } else if (action === 'panel-channel' && route.page === 'panels') {
          const channel = await (await this.gateway.guild()).channels.fetch(value);
          if (channel?.type !== ChannelType.GuildText) throw new DomainError('invalidInput');
          route = { ...route, channelId: value, channelName: channel.name };
        } else throw new DomainError('invalidInput');
      } else if (action === 'diagnose') {
        if (route.page !== 'maintenance') throw new DomainError('invalidInput');
        route = { page: 'maintenance' };
        let lastPhase = 'waiting',
          lastProgressAt = Date.now();
        const preview = await this.service.inspect(
          actor,
          async (progress) => {
            replyState!.signal.throwIfAborted();
            if (
              progress.phase !== lastPhase ||
              (progress.phase === 'activity' && progress.current === progress.total) ||
              Date.now() - lastProgressAt >= 2000
            ) {
              lastPhase = progress.phase;
              lastProgressAt = Date.now();
              await respond(this.views.render(actor!, language, { page: 'maintenance', progress }));
            }
          },
          replyState.signal,
        );
        route = { page: 'maintenance', preview, index: 0 };
      } else if (action === 'reconcile' || action === 'rotate') {
        if (route.page !== 'maintenance' || !route.preview) throw new DomainError('invalidInput');
        route = await this.review(actor, route, { kind: action }, language);
      } else if (['activate', 'archive', 'block', 'unblock', 'retire'].includes(action)) {
        if (route.page !== 'game') throw new DomainError('invalidInput');
        route = await this.review(
          actor,
          route,
          {
            kind: action as 'activate' | 'archive' | 'block' | 'unblock' | 'retire',
            gameId: route.id,
          },
          language,
        );
      } else if (action === 'align' || action === 'unalign') {
        if (route.page !== 'confirm' || route.plan.action.kind !== 'edit')
          throw new DomainError('invalidInput');
        route = await this.review(
          actor,
          route.back,
          { ...route.plan.action, align: action === 'align' },
          language,
        );
      } else if (action === 'preview') {
        if (route.page === 'prepare') {
          const d = route.draft;
          if (
            d.proposalId &&
            d.proposalVersion !== fingerprint(this.nexus.repository.proposal(d.proposalId))
          )
            throw new DomainError('staleAction');
          if (!d.assetId) throw new DomainError('invalidImage');
          route = await this.review(
            actor,
            route,
            {
              kind: 'create',
              input: { name: d.name, url: d.url, assetId: d.assetId, rawgId: d.rawgId },
              proposalId: d.proposalId,
            },
            language,
          );
        } else if (route.page === 'repair') {
          if (!route.channelId || !route.roleId) throw new DomainError('invalidInput');
          route = await this.review(
            actor,
            route,
            { kind: 'repair', gameId: route.id, channelId: route.channelId, roleId: route.roleId },
            language,
          );
        } else if (route.page === 'panels') {
          if (!route.channelId) throw new DomainError('invalidInput');
          const permissions = await this.panelState(route.target, route.channelId);
          route = await this.review(
            actor,
            route,
            { kind: 'panel', target: route.target, channelId: route.channelId, permissions },
            language,
          );
        } else throw new DomainError('invalidInput');
      } else if (action === 'confirm') {
        if (route.page !== 'confirm') throw new DomainError('invalidInput');
        const review = route,
          plan = review.plan,
          a = plan.action;
        await respond(this.views.working(language));
        if (a.kind === 'panel')
          await this.nexus.mutex.run(async () => {
            if ((await this.panelState(a.target, a.channelId)) !== a.permissions)
              throw new DomainError('staleAction');
            await this.service.consume(actor!, plan);
            if (a.target === 'member') await this.installMember(a.channelId);
            else await this.installStaff(a.channelId);
            this.nexus.repository.audit('publish-panel', actor!.id, a.channelId, Date.now());
          });
        else {
          const p =
            a.kind === 'create' && a.proposalId
              ? this.nexus.repository.proposal(a.proposalId)
              : undefined;
          const requester = p ? await this.gateway.actor(p.actorId) : undefined;
          await this.service.execute(actor, plan, requester);
        }
        const originRequest = ancestor(review.back, 'request');
        const requestBack =
          originRequest?.page === 'request' ? originRequest.back : list('requests');
        const originGame = ancestor(review.back, 'game');
        const gameBack =
          originGame?.page === 'game'
            ? originGame.back
            : ancestor(review.back, 'catalogue') || list('catalogue');
        if (a.kind === 'create') {
          const g =
            a.input.rawgId !== null
              ? this.nexus.repository.byRawg(a.input.rawgId)
              : this.nexus.repository
                  .games()
                  .find((g) => normalize(g.name) === normalize(a.input.name));
          route = a.proposalId
            ? { page: 'request', id: a.proposalId, back: requestBack }
            : g
              ? { page: 'game', id: g.id, back: gameBack }
              : list('catalogue');
        } else if ('proposalId' in a && a.proposalId)
          route = { page: 'request', id: a.proposalId, back: requestBack };
        else if ('gameId' in a)
          route = {
            page: 'game',
            id: a.gameId,
            back: gameBack,
          };
        else if (a.kind === 'reconcile' || a.kind === 'rotate')
          route = { page: 'maintenance', preview: await this.service.inspect(actor), index: 0 };
        else route = review.back;
        const pending =
          route.page === 'maintenance' &&
          this.nexus.repository
            .operations()
            .some((op) => ['pending', 'review'].includes(op.status));
        await respond(
          this.views.render(
            actor,
            language,
            route,
            t(pending ? 'a.partialHelp' : 'a.done'),
            pending,
          ),
        );
        return;
      } else throw new DomainError('invalidInput');
      await respond(this.views.render(actor, language, route));
    } catch (err) {
      if (replyState?.signal.aborted && err === replyState.signal.reason) {
        this.log.debug({ event: 'admin_diagnostic_cancelled', ...context() });
        return;
      }
      const code = err instanceof DomainError ? err.code : 'unknownError';
      const details = {
        ...context(),
        event: 'admin_interaction_error',
        code,
        phase,
        interactionId: i.id,
        elapsedMs: Date.now() - startedAt,
        err,
      };
      if (code === 'expired') this.log.debug(details);
      else if (err instanceof DomainError || terminal(err)) this.log.warn(details);
      else this.log.error(details);
      if (
        replyState?.current() === false ||
        terminal(err) ||
        (attempted && !i.deferred && !i.replied)
      )
        return;
      try {
        const message =
          action === 'diagnose'
            ? `${t('a.diagnosticFailed')}${code === 'unknownError' ? '' : `\n${t(code, err instanceof DomainError ? err.values : {})}`}`
            : t(code, err instanceof DomainError ? err.values : {});
        const payload =
          actor?.admin && !['adminOnly', 'forbidden'].includes(code)
            ? this.views.render(
                actor,
                language,
                action === 'diagnose'
                  ? { page: 'maintenance' }
                  : route.page === 'confirm'
                    ? route.back
                    : route,
                message,
                true,
              )
            : new Views(this.nexus.repository, this.gateway.config.guildId).feedback(
                language,
                message,
                true,
                false,
              );
        if (i.deferred || i.replied) await respond(payload);
        else
          await i.reply({
            ...payload,
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
      } catch (error) {
        this.log.warn({ event: 'admin_error_response_failed', interactionId: i.id, err: error });
      }
    }
  }
}
