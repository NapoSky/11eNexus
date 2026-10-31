import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
} from 'discord.js';
import {
  DomainError,
  requireAdmin,
  requireMember,
  type Actor,
  type Locale,
} from '../domain/model.js';
import type { EventService } from '../application/events.js';
import type { Session } from '../application/ports.js';
import type { DiscordCommunity } from '../infrastructure/discord.js';
import { logger, type AppLogger } from '../infrastructure/logger.js';
import { EventViews, eventHome, type EventRoute } from './event-views.js';
import { editView, ownedSession, session, type View } from './views.js';
import { locale, translator } from './i18n.js';
import { interactionFailure } from './interaction-failure.js';

export class EventController {
  readonly views: EventViews;
  private readonly replies = new Map<
    string,
    { token: symbol; writes: Promise<void>; expiresAt: number }
  >();
  constructor(
    readonly service: EventService,
    readonly gateway: DiscordCommunity,
    readonly cachedActor: (i: Interaction) => Actor,
    readonly log: AppLogger = logger,
  ) {
    this.views = new EventViews(service.repository, gateway.config.guildId);
  }
  accepts(i: Interaction): boolean {
    return 'customId' in i && i.customId.startsWith('ne:');
  }
  private key(i: Interaction): string | undefined {
    return 'message' in i && i.message?.flags.has(MessageFlags.Ephemeral)
      ? `${i.user.id}:${i.message.id}`
      : undefined;
  }
  invalidateReply(i: Interaction): void {
    const key = this.key(i);
    if (key && this.replies.has(key)) this.replies.get(key)!.token = Symbol();
  }
  private begin(i: Interaction) {
    for (const [key, value] of this.replies)
      if (value.expiresAt <= Date.now()) this.replies.delete(key);
    const key = this.key(i),
      token = Symbol();
    const state = (key ? this.replies.get(key) : undefined) || {
      token,
      writes: Promise.resolve(),
      expiresAt: 0,
    };
    state.token = token;
    state.expiresAt = Date.now() + 15 * 60000;
    if (key) this.replies.set(key, state);
    return async (view: View) => {
      const write = state.writes.then(async () => {
        if (state.token === token && 'editReply' in i) await i.editReply(editView(view));
      });
      state.writes = write.catch(() => {});
      await write;
    };
  }
  private modal(
    action: string,
    s: Session,
    language: Locale,
    values?: { name: string; description: string },
  ): ModalBuilder {
    const t = translator(language),
      modal = new ModalBuilder()
        .setCustomId(`ne:${action}:${s.id}`)
        .setTitle(t(action === 'search-form' ? 'search' : 'e.formTitle'));
    modal.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        t(action === 'search-form' ? 'e.searchHelp' : 'e.formHelp'),
      ),
    );
    if (action === 'search-form')
      modal.addLabelComponents(
        new LabelBuilder()
          .setLabel(t('query'))
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('query')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(100),
          ),
      );
    else
      modal.addLabelComponents(
        new LabelBuilder().setLabel(t('e.name')).setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(true)
            .setValue(values?.name || ''),
        ),
        new LabelBuilder().setLabel(t('e.description')).setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('description')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(true)
            .setValue(values?.description || ''),
        ),
      );
    return modal;
  }
  async handle(interaction: Interaction): Promise<void> {
    if (
      !this.accepts(interaction) ||
      (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit())
    )
      return;
    const i = interaction,
      language = locale(i.locale),
      t = translator(language),
      [_, action, token] = i.customId.split(':');
    let actor: Actor | undefined,
      route: EventRoute = eventHome(),
      s: Session | undefined;
    let attempted = false,
      phase = 'authorize';
    const startedAt = Date.now();
    const context = () => ({
      interactionId: i.id,
      phase,
      elapsedMs: Date.now() - startedAt,
      receivedAgeMs: Math.max(0, startedAt - i.createdTimestamp),
      gatewayPingMs: this.gateway.client.ws.ping >= 0 ? this.gateway.client.ws.ping : undefined,
    });
    const respond = this.begin(i);
    try {
      actor = this.cachedActor(i);
      const memberAction = ['subscribe', 'enable', 'disable'].includes(action!);
      if (memberAction) requireMember(actor);
      else requireAdmin(actor);
      if (token && action !== 'subscribe') {
        s = ownedSession(this.service.repository, actor.id, token);
        if (memberAction ? s.kind !== 'event-notifications' : s.kind !== 'events-admin')
          throw new DomainError('expired');
        if (!memberAction) route = s.data.route as EventRoute;
      } else if (action !== 'home' && action !== 'subscribe') throw new DomainError('expired');
      // showModal is the initial response: no network or mutex wait may precede it.
      if (!i.isModalSubmit() && (action === 'search' || action === 'edit' || action === 'game')) {
        if (!s) throw new DomainError('expired');
        this.invalidateReply(i);
        let modal: ModalBuilder;
        if (action === 'search') modal = this.modal('search-form', s, language);
        else if (action === 'game' && i.isStringSelectMenu() && route.page === 'games') {
          const game = this.service.repository.game(i.values[0] || '');
          if (!game || game.retired) throw new DomainError('notFound');
          const draft = session(this.service.repository, actor.id, 'events-admin', {
            route,
            gameId: game.id,
          });
          modal = this.modal('create-form', draft, language);
        } else if (action === 'edit' && route.page === 'detail') {
          const event = this.service.repository.event(route.id);
          if (event?.state !== 'active') throw new DomainError('e.closed');
          modal = this.modal('edit-form', s, language, event);
        } else throw new DomainError('invalidInput');
        attempted = true;
        phase = 'modal';
        await i.showModal(modal);
        this.log.debug({ event: 'event_interaction_acknowledged', ...context() });
        return;
      }
      phase = 'acknowledge';
      attempted = true;
      if (
        action !== 'subscribe' &&
        'message' in i &&
        i.message?.flags.has(MessageFlags.Ephemeral) &&
        (!i.isModalSubmit() || i.isFromMessage())
      )
        await i.deferUpdate();
      else await i.deferReply({ flags: MessageFlags.Ephemeral });
      this.log.debug({ event: 'event_interaction_acknowledged', ...context() });
      phase = 'authorize_fresh';
      actor = await this.gateway.actor(i.user.id);
      if (memberAction) requireMember(actor);
      else requireAdmin(actor);
      phase = 'handle';
      if (memberAction) {
        const id = action === 'subscribe' ? token : String(s?.data.eventId || '');
        const event = this.service.repository.event(id || '');
        if (event?.state !== 'active' || !event.roleId || event.roleDeleted)
          throw new DomainError('e.closed');
        const enabled =
          action === 'subscribe'
            ? await this.service.community.subscribed(event.roleId, actor.id)
            : await this.service.subscribe(actor, event.id, action === 'enable');
        await respond(this.views.notifications(actor, language, event, enabled));
        return;
      }
      if (action === 'home') route = eventHome();
      else if (action === 'create') route = { page: 'games', query: '', index: 0 };
      else if (action === 'back') route = 'back' in route ? route.back : eventHome();
      else if (['active', 'archived', 'all'].includes(action!) && route.page === 'list')
        route = { ...route, filter: action as 'active' | 'archived' | 'all', index: 0 };
      else if (
        (action === 'next' || action === 'previous') &&
        (route.page === 'list' || route.page === 'games')
      )
        route = { ...route, index: Math.max(0, route.index + (action === 'next' ? 1 : -1)) };
      else if (action === 'event' && i.isStringSelectMenu() && route.page === 'list') {
        if (!this.service.repository.event(i.values[0] || '')) throw new DomainError('notFound');
        route = { page: 'detail', id: i.values[0]!, back: route };
      } else if (
        action === 'announcement-tag' &&
        i.isStringSelectMenu() &&
        route.page === 'confirm' &&
        route.plan.action.kind === 'create'
      ) {
        const tag = i.values[0];
        if (!route.plan.announcementTags.some((t) => t.id === tag))
          throw new DomainError('invalidInput');
        await respond(this.views.feedback(language, t('e.checking')));
        route = {
          ...route,
          plan: await this.service.plan(actor, {
            kind: 'create',
            draft: { ...route.plan.action.draft, announcementTagId: tag },
          }),
        };
      } else if (i.isModalSubmit()) {
        if (action === 'search-form' && (route.page === 'games' || route.page === 'list'))
          route = { ...route, query: i.fields.getTextInputValue('query').trim(), index: 0 };
        else if (action === 'create-form' && s) {
          await respond(this.views.feedback(language, t('e.checking')));
          const plan = await this.service.plan(actor, {
            kind: 'create',
            draft: {
              gameId: String(s.data.gameId || ''),
              name: i.fields.getTextInputValue('name'),
              description: i.fields.getTextInputValue('description'),
            },
          });
          route = { page: 'confirm', plan, back: route };
        } else if (action === 'edit-form' && route.page === 'detail') {
          await respond(this.views.feedback(language, t('e.checking')));
          const plan = await this.service.plan(actor, {
            kind: 'edit',
            eventId: route.id,
            name: i.fields.getTextInputValue('name'),
            description: i.fields.getTextInputValue('description'),
          });
          route = { page: 'confirm', plan, back: route };
        } else throw new DomainError('invalidInput');
      } else if (
        action === 'close-only' &&
        route.page === 'confirm' &&
        (route.plan.action.kind === 'close' || route.plan.action.kind === 'repair')
      ) {
        await respond(this.views.feedback(language, t('e.checking')));
        route = {
          ...route,
          plan: await this.service.plan(actor, { ...route.plan.action, cleanup: false }),
        };
      } else if (action === 'refresh' && route.page === 'confirm') {
        await respond(this.views.feedback(language, t('e.checking')));
        route = { ...route, plan: await this.service.plan(actor, route.plan.action) };
      } else if ((action === 'close' || action === 'repair') && route.page === 'detail') {
        await respond(this.views.feedback(language, t('e.checking')));
        const plan = await this.service.plan(actor, { kind: action, eventId: route.id });
        route = { page: 'confirm', plan, back: route };
      } else if (action === 'confirm' && route.page === 'confirm') {
        await respond(this.views.feedback(language, t('a.applying')));
        const plan = route.plan;
        const event = await this.service.execute(actor, plan);
        route = { page: 'detail', id: event.id, back: eventHome() };
        await respond(
          this.views.admin(
            actor,
            language,
            route,
            t(event.issue ? 'e.closedPending' : 'a.done'),
            Boolean(event.issue),
          ),
        );
        return;
      } else throw new DomainError('invalidInput');
      await respond(this.views.admin(actor, language, route));
    } catch (error) {
      const failure = interactionFailure(error);
      this.log[failure.code === 'expired' ? 'debug' : failure.expected ? 'warn' : 'error']({
        event: 'event_interaction_error',
        ...context(),
        code: failure.code,
        err: error,
      });
      if (attempted && !i.deferred && !i.replied) return;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        [10062, 10015, 40060, 50027].includes(Number(error.code))
      )
        return;
      if (route.page === 'confirm') {
        const id = route.plan.action.kind === 'create' ? route.plan.id : route.plan.action.eventId;
        route = this.service.repository.event(id)
          ? { page: 'detail', id, back: eventHome() }
          : route;
      }
      const view =
        actor?.admin && !['forbidden', 'adminOnly', 'expired'].includes(failure.code)
          ? this.views.admin(actor, language, route, t(failure.code, failure.values), true)
          : this.views.feedback(language, t(failure.code, failure.values), true);
      try {
        if (i.deferred || i.replied) await respond(view);
        else
          await i.reply({ ...view, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      } catch (err) {
        this.log.warn({ event: 'event_error_response_failed', interactionId: i.id, err });
      }
    }
  }
}
