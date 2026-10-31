import {
  LabelBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
  Events,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type Message,
} from 'discord.js';
import {
  DomainError,
  normalize,
  requireAdmin,
  requireMember,
  type Actor,
} from '../domain/model.js';
import type { Nexus } from '../application/nexus.js';
import type { Session } from '../application/ports.js';
import type { DiscordCommunity } from '../infrastructure/discord.js';
import { AdminController } from './admin-controller.js';
import { commands } from './commands.js';
import { locale, translator } from './i18n.js';
import {
  ownedSession,
  session,
  destination,
  editView,
  Views,
  type View,
  type Destination,
  type Mode,
} from './views.js';
import { logger, type AppLogger } from '../infrastructure/logger.js';
import { interactionFailure } from './interaction-failure.js';

const actions = new Set([
  'home',
  'clear',
  'browse-active',
  'browse-archived',
  'browse-all',
  'browse-subscribed',
  'browse-recent',
  'recent',
  'new-game-alerts',
  'new-game-alerts-on',
  'new-game-alerts-off',
  'proposal-game',
  'games',
  'archives',
  'notifications',
  'propose',
  'search',
  'manual',
  'notify',
  'amend',
  'catalogue',
  'filter',
  'game',
  'candidate',
  'proposal',
  'results',
  'back',
  'requests',
  'admin',
  'next',
  'previous',
  'create',
  'activate',
  'subscribe',
  'unsubscribe',
]);
const unavailableResponse = (error: unknown): boolean => {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return (
    [10062, 10015, 40060, 50027].includes(Number(error.code)) ||
    error.code === 'InteractionAlreadyReplied'
  );
};

const string = (s: Session, key: string): string => {
  const value = s.data[key];
  if (typeof value !== 'string') throw new DomainError('invalidInput');
  return value;
};
export class Controller {
  readonly views: Views;
  readonly administration: AdminController;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    readonly nexus: Nexus,
    readonly gateway: DiscordCommunity,
    private readonly log: AppLogger = logger.child({ component: 'interactions' }),
  ) {
    this.views = new Views(nexus.repository, gateway.config.guildId);
    this.administration = new AdminController(
      nexus,
      gateway,
      (i) => this.actor(i),
      (id) => this.installPanel(id),
      log,
    );
  }
  listen(): void {
    this.gateway.client.on(Events.InteractionCreate, (i) => {
      const task = this.handle(i).catch((err) =>
        this.log.error({ event: 'interaction_handler_failed', err }),
      );
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
  }
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  private actor(i: Interaction): Actor {
    if (i.guildId !== this.gateway.config.guildId || !i.member) throw new DomainError('forbidden');
    const roles =
      i.member instanceof GuildMember ? [...i.member.roles.cache.keys()] : i.member.roles;
    return {
      id: i.user.id,
      member: roles.includes(this.gateway.config.memberRoleId),
      admin: roles.includes(this.gateway.config.adminRoleId) || i.guild?.ownerId === i.user.id,
    };
  }
  private modal(
    id: string,
    title: string,
    fields: {
      id: string;
      label: string;
      description?: string;
      value?: string;
      max?: number;
      paragraph?: boolean;
    }[],
    helper: string,
  ): ModalBuilder {
    const modal = new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45));
    modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(helper));
    for (const field of fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(field.max || 100);
      if (field.value) input.setValue(field.value.slice(0, field.max || 100));
      const label = new LabelBuilder()
        .setLabel(field.label.slice(0, 45))
        .setTextInputComponent(input);
      if (field.description) label.setDescription(field.description.slice(0, 100));
      modal.addLabelComponents(label);
    }
    return modal;
  }
  async installPanel(channelId?: string): Promise<void> {
    const channel = await this.gateway.panelChannel(channelId);
    await this.gateway.securePanel(channel);
    const payload = this.views.panel();
    const previous = this.nexus.repository.get<{ channelId: string; messageId: string }>('panel');
    if (previous && previous.channelId !== channel.id) {
      try {
        const oldChannel = await (await this.gateway.guild()).channels.fetch(previous.channelId);
        if (oldChannel && 'messages' in oldChannel) {
          const old = await oldChannel.messages.fetch(previous.messageId);
          if (old.author.id !== this.gateway.client.user!.id)
            throw new DomainError('configuration');
          await old.edit(editView(this.views.movedPanel(channel.id)));
        }
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          ![10003, 10008].includes(Number(error.code))
        )
          throw error;
      }
    }
    let message: Message | undefined;
    if (previous?.channelId === channel.id) {
      try {
        const existing = await channel.messages.fetch(previous.messageId);
        if (existing.author.id !== this.gateway.client.user!.id)
          throw new DomainError('configuration');
        message = await existing.edit(editView(payload));
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10008)
          throw error;
      }
    }
    if (!message) message = await channel.send(payload);
    this.nexus.repository.set('panel', { channelId: channel.id, messageId: message.id });
    this.nexus.repository.set('panelChannel', channel.id);
  }
  async installCommands(): Promise<void> {
    await (await this.gateway.guild()).commands.set(commands());
  }
  async handle(interaction: Interaction): Promise<void> {
    if (this.administration.accepts(interaction)) {
      await this.administration.handle(interaction);
      return;
    }
    this.administration.invalidateReply(interaction);
    if (interaction.isAutocomplete()) {
      let attempted = false;
      try {
        const actor = this.actor(interaction);
        requireAdmin(actor);
        const focused = interaction.options.getFocused(true);
        const query = normalize(String(focused.value));
        const options =
          focused.name === 'proposal'
            ? this.nexus.repository
                .proposals()
                .filter((p) => p.status === 'pending' || p.status === 'needs_info')
                .map((p) => ({ name: p.name, value: p.id }))
            : this.nexus.repository.games().map((g) => ({ name: g.name, value: g.id }));
        attempted = true;
        await interaction.respond(
          options
            .filter((o) => normalize(o.name).includes(query))
            .slice(0, 25)
            .map((o) => ({ ...o, name: o.name.slice(0, 100) })),
        );
      } catch (err) {
        if (attempted) {
          this.log.warn({
            event: 'autocomplete_response_failed',
            interactionId: interaction.id,
            err,
          });
          return;
        }
        await interaction.respond([]).catch((error) =>
          this.log.warn({
            event: 'autocomplete_response_failed',
            interactionId: interaction.id,
            err: error,
          }),
        );
      }
      return;
    }
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isButton() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isModalSubmit()
    )
      return;
    const i = interaction;
    const language = locale(i.locale);
    const t = translator(language);
    const startedAt = Date.now();
    const receivedAgeMs =
      typeof i.createdTimestamp === 'number'
        ? Math.max(0, startedAt - i.createdTimestamp)
        : undefined;
    const actionName = 'customId' in i ? i.customId.split(':')[1] || '' : '';
    let phase = 'authorize';
    let acknowledgementAttempted = false;
    const context = () => ({
      interactionId: i.id,
      action: actions.has(actionName)
        ? actionName
        : i.isChatInputCommand()
          ? i.commandName
          : 'unknown',
      phase,
      elapsedMs: Date.now() - startedAt,
      receivedAgeMs,
      gatewayPingMs: this.gateway.client.ws.ping >= 0 ? this.gateway.client.ws.ping : undefined,
      interactionAgeMs:
        typeof i.createdTimestamp === 'number'
          ? Math.max(0, Date.now() - i.createdTimestamp)
          : undefined,
      deferred: i.deferred,
      replied: i.replied,
    });
    let s: Session | undefined;
    const respond = async (payload: View) => {
      phase = 'edit_reply';
      await i.editReply(editView(payload));
      phase = 'handle';
    };
    try {
      let actor = this.actor(i);
      requireMember(actor);
      if (i.isChatInputCommand() && i.commandName === 'nexus-admin') requireAdmin(actor);
      const parts = ('customId' in i ? i.customId : '').split(':');
      if ('customId' in i && parts[0] !== 'nx' && parts[0] !== 'nxm') return;
      const action = parts[1] || '';
      const token = parts[2];
      if (token) s = ownedSession(this.nexus.repository, actor.id, token);
      if (i.isButton() && ['propose', 'search', 'manual', 'notify', 'amend'].includes(action)) {
        const data = s || session(this.nexus.repository, actor.id, 'entry', {});
        if (action === 'amend') {
          const p = this.nexus.repository.proposal(string(data, 'proposalId'));
          if (!p || p.actorId !== actor.id || p.status !== 'needs_info')
            throw new DomainError('forbidden');
          phase = 'show_modal';
          acknowledgementAttempted = true;
          await i.showModal(
            this.modal(
              `nxm:amend:${data.id}`,
              t('amend'),
              [
                { id: 'name', label: t('query'), description: t('gameNameHint'), value: p.name },
                {
                  id: 'url',
                  label: t('officialUrl'),
                  description: t('officialLinkHint'),
                  value: p.url,
                  max: 500,
                },
              ],
              `${t('amendModalHelp')}\n\n${t('modalBackHint')}`,
            ),
          );
          return;
        }
        if (action === 'manual') {
          phase = 'show_modal';
          acknowledgementAttempted = true;
          await i.showModal(
            this.modal(
              `nxm:manual:${data.id}`,
              t('request'),
              [
                {
                  id: 'name',
                  label: t('query'),
                  description: t('gameNameHint'),
                  value:
                    typeof data.data.name === 'string'
                      ? data.data.name
                      : typeof data.data.query === 'string'
                        ? data.data.query
                        : undefined,
                },
                {
                  id: 'url',
                  label: t('officialUrl'),
                  description: t('officialLinkHint'),
                  max: 500,
                },
              ],
              `${t('requestModalHelp')}\n\n${t('modalBackHint')}`,
            ),
          );
          return;
        }
        if (action === 'notify') {
          if (data.kind !== 'game') throw new DomainError('invalidInput');
          phase = 'show_modal';
          acknowledgementAttempted = true;
          await i.showModal(
            this.modal(
              `nxm:notify:${data.id}`,
              t('notify'),
              [
                {
                  id: 'message',
                  label: t('notificationText'),
                  description: t('notifyFieldHint'),
                  max: 1000,
                  paragraph: true,
                },
              ],
              `${t('notifyModalHelp')}\n\n${t('modalBackHint')}`,
            ),
          );
          return;
        }
        phase = 'show_modal';
        acknowledgementAttempted = true;
        await i.showModal(
          this.modal(
            `nxm:${action === 'propose' ? 'catalogue' : 'search'}:${data.id}`,
            t(action === 'propose' ? 'addGame' : 'search'),
            [
              {
                id: 'query',
                label: t('query'),
                description: t('gameNameHint'),
                value: typeof data.data.query === 'string' ? data.data.query : undefined,
              },
            ],
            `${t(action === 'propose' ? 'addSearchModalHelp' : data.kind === 'browse' && data.data.mode === 'recent' ? 'recentSearchModalHelp' : 'searchModalHelp')}\n\n${t('modalBackHint')}`,
          ),
        );
        return;
      }
      phase = 'acknowledge';
      acknowledgementAttempted = true;
      if (i.isButton() || i.isStringSelectMenu()) {
        if (s) await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
      } else if (
        i.isModalSubmit() &&
        i.isFromMessage() &&
        i.message.flags.has(MessageFlags.Ephemeral)
      ) {
        await i.deferUpdate();
      } else await i.deferReply({ flags: MessageFlags.Ephemeral });
      this.log.debug({ event: 'interaction_acknowledged', ...context() });
      phase = 'handle';
      // Fresh REST role observation for every state-changing operation after acknowledgement.
      if (
        i.isChatInputCommand() ||
        i.isModalSubmit() ||
        [
          'activate',
          'create',
          'subscribe',
          'unsubscribe',
          'new-game-alerts-on',
          'new-game-alerts-off',
        ].includes(action)
      ) {
        actor = await this.gateway.actor(i.user.id);
        requireMember(actor);
      }
      if (i.isChatInputCommand()) {
        if (i.commandName === 'nexus') {
          await respond(this.views.home(actor, language));
          return;
        }
        throw new DomainError('notFound');
      }
      if (i.isModalSubmit()) {
        if (!s) throw new DomainError('expired');
        if (action === 'amend') {
          const p = await this.nexus.amendProposal(
            actor,
            string(s, 'proposalId'),
            i.fields.getTextInputValue('name'),
            i.fields.getTextInputValue('url'),
          );
          await respond(
            this.views.proposal(actor, language, p, destination(s), t('requestUpdated')),
          );
          return;
        }
        if (action === 'manual') {
          const proposal = await this.nexus.propose(
            actor,
            i.fields.getTextInputValue('name'),
            i.fields.getTextInputValue('url'),
            language,
          );
          await respond(
            this.views.proposal(
              actor,
              language,
              proposal,
              { kind: 'proposals', admin: false, page: 0 },
              t('requestRecorded', { game: escapeMarkdown(proposal.name) }),
            ),
          );
          return;
        }
        if (action === 'notify') {
          await this.nexus.notify(
            actor,
            string(s, 'gameId'),
            i.fields.getTextInputValue('message'),
          );
          await respond(
            this.views.game(
              actor,
              language,
              string(s, 'gameId'),
              t('notificationSent'),
              destination(s),
            ),
          );
          return;
        }
        const query = i.fields.getTextInputValue('query').trim();
        if (action === 'search') {
          const source = destination(s);
          await respond(
            this.views.browse(
              actor,
              language,
              source.kind === 'browse' && source.mode === 'recent' ? 'recent' : 'all',
              0,
              query,
            ),
          );
          return;
        }
        if (action === 'catalogue') {
          const local = this.nexus.repository
            .games()
            .filter(
              (g) =>
                normalize(g.name) === normalize(query) ||
                g.aliases.some((a) => normalize(a) === normalize(query)),
            );
          if (local.length === 1) {
            await respond(
              this.views.game(actor, language, local[0]!.id, t('gameAlreadyHere'), destination(s)),
            );
            return;
          }
          if (!actor.admin) {
            const key = `search:${actor.id}`;
            const recent = this.nexus.repository.get<number[]>(key) || [];
            const active = recent.filter((at) => at + 60000 > Date.now());
            if (active.length >= 5) throw new DomainError('searchLimited');
            this.nexus.repository.set(key, [...active, Date.now()]);
          }
          try {
            const candidates = await this.nexus.catalogue.search(query);
            await respond(
              this.views.candidates(actor, language, query, candidates, undefined, destination(s)),
            );
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            await respond(
              this.views.candidates(actor, language, query, [], t(error.code), destination(s)),
            );
          }
          return;
        }
        throw new DomainError('invalidInput');
      }
      if (action === 'home') {
        await respond(this.views.home(actor, language));
        return;
      }
      if (
        action === 'new-game-alerts' ||
        action === 'new-game-alerts-on' ||
        action === 'new-game-alerts-off'
      ) {
        if (action !== 'new-game-alerts' && s?.kind !== 'new-game-alerts')
          throw new DomainError('invalidInput');
        const enabled =
          action === 'new-game-alerts'
            ? await this.nexus.newGameAlerts(actor)
            : await this.nexus.setNewGameAlerts(actor, action === 'new-game-alerts-on');
        await respond(
          this.views.newGameAlerts(actor, language, enabled, this.gateway.config.newGameChannelId),
        );
        return;
      }
      if (['games', 'archives', 'notifications', 'recent'].includes(action)) {
        await respond(
          this.views.browse(
            actor,
            language,
            action === 'recent'
              ? 'recent'
              : action === 'archives'
                ? 'archived'
                : action === 'games'
                  ? 'active'
                  : 'subscribed',
          ),
        );
        return;
      }
      if (!s) throw new DomainError('invalidInput');
      if (action.startsWith('browse-') || action === 'clear') {
        if (s.kind !== 'browse') throw new DomainError('invalidInput');
        const mode = action === 'clear' ? (s.data.mode as Mode) : (action.slice(7) as Mode);
        if (!['active', 'archived', 'all', 'subscribed', 'recent'].includes(mode))
          throw new DomainError('invalidInput');
        await respond(
          this.views.browse(
            actor,
            language,
            mode,
            0,
            action === 'clear' ? '' : String(s.data.query || ''),
          ),
        );
        return;
      }
      if (i.isStringSelectMenu()) {
        const selected = i.values[0];
        if (!selected) throw new DomainError('invalidInput');
        if (
          action === 'filter' &&
          ['active', 'archived', 'all', 'subscribed', 'recent'].includes(selected)
        ) {
          await respond(
            this.views.browse(actor, language, selected as Mode, 0, String(s.data.query || '')),
          );
          return;
        }
        if (action === 'game') {
          if (s.kind !== 'browse' || !(s.data.ids as string[]).includes(selected))
            throw new DomainError('invalidInput');
          await respond(this.views.game(actor, language, selected, undefined, destination(s)));
          return;
        }
        if (action === 'candidate') {
          const id = Number(selected);
          if (s.kind !== 'candidates' || !(s.data.ids as number[]).includes(id))
            throw new DomainError('invalidInput');
          const existing = this.nexus.repository.byRawg(id);
          if (existing) {
            await respond(
              this.views.game(actor, language, existing.id, t('gameAlreadyHere'), destination(s)),
            );
            return;
          }
          const candidate = await this.nexus.catalogue.get(id);
          const asset = await this.nexus.catalogue.image(candidate).catch(() => null);
          if (asset) this.nexus.repository.saveAsset(asset);
          await respond(
            this.views.candidate(
              actor,
              language,
              candidate,
              asset?.id || null,
              string(s, 'query'),
              destination(s),
            ),
          );
          return;
        }
        if (action === 'proposal') {
          if (s.kind !== 'proposals' || !(s.data.ids as string[]).includes(selected))
            throw new DomainError('invalidInput');
          const p = this.nexus.repository.proposal(selected);
          if (!p) throw new DomainError('notFound');
          await respond(this.views.proposal(actor, language, p, destination(s)));
          return;
        }
        throw new DomainError('invalidInput');
      }
      if (action === 'results') {
        if (s.kind !== 'candidate') throw new DomainError('invalidInput');
        const query = string(s, 'query');
        await respond(
          this.views.candidates(
            actor,
            language,
            query,
            await this.nexus.catalogue.search(query),
            undefined,
            destination(s),
          ),
        );
        return;
      }
      if (action === 'back') {
        await respond(
          this.returnView(
            actor,
            language,
            s.kind === 'proposals' ? { kind: 'home' } : destination(s),
          ),
        );
        return;
      }
      if (action === 'proposal-game') {
        if (s.kind !== 'proposal') throw new DomainError('invalidInput');
        const p = this.nexus.repository.proposal(string(s, 'proposalId'));
        if (!p || (p.actorId !== actor.id && !actor.admin)) throw new DomainError('forbidden');
        if (!p.gameId) throw new DomainError('notFound');
        const parent = destination(s);
        await respond(
          this.views.game(actor, language, p.gameId, undefined, {
            kind: 'proposal',
            id: p.id,
            admin: parent.kind === 'proposals' && parent.admin,
            page: parent.kind === 'proposals' ? parent.page : 0,
          }),
        );
        return;
      }
      if (action === 'requests') {
        await respond(this.views.proposals(actor, language));
        return;
      }
      if (action === 'next' || action === 'previous') {
        const page = Number(s.data.page) + (action === 'next' ? 1 : -1);
        if (s.kind === 'proposals') {
          await respond(this.views.proposals(actor, language, s.data.admin === true, page));
          return;
        }
        if (s.kind !== 'browse') throw new DomainError('invalidInput');
        await respond(
          this.views.browse(actor, language, s.data.mode as Mode, page, String(s.data.query || '')),
        );
        return;
      }
      if (action === 'create') {
        if (s.kind !== 'candidate') throw new DomainError('invalidInput');
        const game = await this.nexus.create(actor, Number(s.data.rawgId));
        await respond(
          this.views.game(
            actor,
            language,
            game.id,
            t('created', { game: escapeMarkdown(game.name) }),
            destination(s),
          ),
        );
        return;
      }
      if (s.kind !== 'game') throw new DomainError('invalidInput');
      const id = string(s, 'gameId');
      if (action === 'activate') {
        const game = await this.nexus.activate(actor, id);
        await respond(
          this.views.game(
            actor,
            language,
            id,
            t('activated', { game: escapeMarkdown(game.name) }),
            destination(s),
          ),
        );
        return;
      }
      if (action === 'subscribe' || action === 'unsubscribe') {
        await this.nexus.subscribe(actor, id, action === 'subscribe');
        await respond(this.views.game(actor, language, id, undefined, destination(s)));
        return;
      }
      throw new DomainError('invalidInput');
    } catch (error) {
      const failure = interactionFailure(error);
      const key = failure.code;
      const details = { event: 'interaction_error', code: key, ...context(), err: error };
      if (key === 'expired') this.log.debug({ ...details, event: 'menu_expired' });
      else if (failure.expected || unavailableResponse(error)) this.log.warn(details);
      else this.log.error(details);
      // A failed acknowledgement has an uncertain/expired token. Never send a second callback.
      if (unavailableResponse(error) || (acknowledgementAttempted && !i.deferred && !i.replied))
        return;
      try {
        const payload = this.views.feedback(
          language,
          t(key, failure.values),
          true,
          !['forbidden', 'adminOnly'].includes(key),
          s,
        );
        if (i.deferred || i.replied) await i.editReply(editView(payload));
        else
          await i.reply({
            ...payload,
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
      } catch (err) {
        this.log.warn({ event: 'interaction_error_response_failed', ...context(), err });
      }
    }
  }
  private returnView(actor: Actor, language: ReturnType<typeof locale>, target: Destination): View {
    if (target.kind === 'home') return this.views.home(actor, language);
    if (target.kind === 'browse')
      return this.views.browse(actor, language, target.mode, target.page, target.query);
    if (target.kind === 'proposals')
      return this.views.proposals(actor, language, target.admin, target.page);
    const p = this.nexus.repository.proposal(target.id);
    if (!p) throw new DomainError('notFound');
    return this.views.proposal(actor, language, p, {
      kind: 'proposals',
      admin: target.admin,
      page: target.page,
    });
  }
}
