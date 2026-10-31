import { createHash, randomUUID } from 'node:crypto';
import {
  DomainError,
  channelName,
  requireAdmin,
  requireMember,
  type Actor,
} from '../domain/model.js';
import {
  validateEventDraft,
  type CommunityEvent,
  type EventCategories,
  type EventDraft,
  type EventOperation,
} from '../domain/community-event.js';
import type { Clock, Mutex, Repository } from './ports.js';
import type { EventCommunity, EventWorld } from './event-ports.js';

type EventAction =
  | { kind: 'create'; draft: EventDraft }
  | { kind: 'close' | 'repair'; eventId: string; cleanup?: boolean }
  | { kind: 'edit'; eventId: string; name: string; description: string };
export interface EventPlan {
  id: string;
  actorId: string;
  expiresAt: number;
  action: EventAction;
  revision: string;
  cleanupId: string | null;
  cleanupRevision: string | null;
  announcementChannelId: string | null;
  replaceMessage: boolean;
  announcementTags: { id: string; name: string }[];
  archiveBlocked: boolean;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
export class EventService {
  constructor(
    readonly repository: Repository,
    readonly community: EventCommunity,
    readonly mutex: Mutex,
    readonly gameCategoryId: string,
    readonly roleReserve = 5,
    readonly clock: Clock = { now: () => Date.now() },
  ) {}
  categories(): EventCategories {
    return (
      this.repository.get<EventCategories>('eventCategories') || { activeId: null, archiveId: null }
    );
  }
  private event(id: string): CommunityEvent {
    const event = this.repository.event(id);
    if (!event || event.state === 'deleted') throw new DomainError('notFound');
    return event;
  }
  private async world(): Promise<EventWorld> {
    const world = await this.community.inspect();
    if (!world.complete) throw new DomainError('incomplete');
    return world;
  }
  private checkCategories(world: EventWorld): void {
    const categories = this.categories();
    for (const id of [categories.activeId, categories.archiveId])
      if (id && !world.channels.some((c) => c.id === id && c.type === 4 && c.editable !== false))
        throw new DomainError('e.categoriesMissing');
    if (!world.channels.some((c) => c.id === this.gameCategoryId && c.type === 4))
      throw new DomainError('configuration');
  }
  private oldest(world: EventWorld): CommunityEvent | undefined {
    return this.repository
      .events()
      .filter(
        (e) =>
          e.state === 'archived' &&
          !e.issue &&
          e.archivedAt !== null &&
          world.channels.some(
            (c) =>
              c.id === e.channelId &&
              c.parentId === this.categories().archiveId &&
              c.editable !== false &&
              c.hidden !== false,
          ),
      )
      .sort((a, b) => a.archivedAt! - b.archivedAt! || a.id.localeCompare(b.id))[0];
  }
  private revision(action: EventAction, world: EventWorld, cleanupId: string | null): string {
    const categories = this.categories();
    const event = 'eventId' in action ? this.event(action.eventId) : undefined;
    const game = action.kind === 'create' ? this.repository.game(action.draft.gameId) : undefined;
    const targetIds = [
      event?.channelId,
      game?.channelId,
      cleanupId ? this.repository.event(cleanupId)?.channelId : null,
    ];
    const channels = world.channels.filter(
      (c) =>
        [categories.activeId, categories.archiveId, this.gameCategoryId].includes(c.id) ||
        [categories.activeId, categories.archiveId].filter(Boolean).includes(c.parentId!) ||
        targetIds.includes(c.id),
    );
    return hash({
      action,
      categories,
      event,
      game: game && {
        id: game.id,
        name: game.name,
        state: game.state,
        channelId: game.channelId,
        retired: game.retired,
      },
      cleanup: cleanupId ? this.repository.event(cleanupId) : null,
      channels: channels
        .map((c) => ({
          ...c,
          lastMessageId:
            targetIds.includes(c.id) &&
            cleanupId &&
            c.id === this.repository.event(cleanupId)?.channelId
              ? c.lastMessageId
              : undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      channelCount: world.channels.length,
      roleCount: world.roles.length,
      roles: world.roles
        .filter((r) => r.id === event?.roleId)
        .map(({ members: _members, ...role }) => role),
    });
  }
  async plan(actor: Actor, requested: EventAction): Promise<EventPlan> {
    requireAdmin(actor);
    return this.mutex.run(async () => {
      let action = requested;
      if (action.kind === 'create')
        action = { kind: 'create', draft: validateEventDraft(action.draft) };
      if (action.kind === 'edit') {
        const draft = validateEventDraft({
          gameId: this.event(action.eventId).gameId,
          name: action.name,
          description: action.description,
        });
        action = { ...action, name: draft.name, description: draft.description };
      }
      const world = await this.world();
      this.checkCategories(world);
      const categories = this.categories();
      const proposedName =
        action.kind === 'create' ? action.draft.name : action.kind === 'edit' ? action.name : null;
      const ignoredId = 'eventId' in action ? action.eventId : null;
      if (
        proposedName &&
        this.repository
          .events()
          .some(
            (e) =>
              e.id !== ignoredId &&
              ['creating', 'active'].includes(e.state) &&
              channelName(e.name) === channelName(proposedName),
          )
      )
        throw new DomainError('e.duplicate');
      let cleanupId: string | null = null;
      let announcementChannelId: string | null = null;
      let announcementTags: { id: string; name: string }[] = [];
      let archiveBlocked = false;
      if (action.kind === 'create') {
        const game = this.repository.game(action.draft.gameId);
        if (!game || game.retired) throw new DomainError('notFound');
        if (
          world.roles.length >= 250 - this.roleReserve ||
          world.channels.length + Number(!categories.activeId) + Number(!categories.archiveId) + 1 >
            500 ||
          world.channels.filter((c) => c.parentId === categories.activeId && categories.activeId)
            .length >= 50
        )
          throw new DomainError('capacity');
        const source = world.channels.find(
          (c) =>
            c.id === game.channelId &&
            c.parentId === this.gameCategoryId &&
            [0, 5, 15, 16].includes(c.type) &&
            c.hidden !== true,
        );
        announcementChannelId = game.state === 'active' && source ? source.id : null;
        if (announcementChannelId && source?.requiresTag) {
          announcementTags = source.tags || [];
          if (!announcementTags.length) announcementChannelId = null;
          if (
            action.draft.announcementTagId &&
            !announcementTags.some((tag) => tag.id === action.draft.announcementTagId)
          )
            throw new DomainError('invalidInput');
        }
      } else {
        const event = this.event(action.eventId);
        const channel = world.channels.find((c) => c.id === event.channelId);
        if (channel && ![categories.activeId, categories.archiveId].includes(channel.parentId))
          throw new DomainError('needsReview');
        if (action.kind === 'edit' && !channel) throw new DomainError('e.channelMissing');
        if (action.kind === 'edit' && event.state !== 'active') throw new DomainError('e.closed');
        if (action.kind === 'close' && !['creating', 'active', 'closed'].includes(event.state))
          throw new DomainError('e.closed');
        if (action.kind === 'repair' && event.state === 'archived' && !event.issue)
          throw new DomainError('e.closed');
        if (
          (action.kind === 'close' || (action.kind === 'repair' && event.state === 'closed')) &&
          event.channelId &&
          world.channels.some(
            (c) => c.id === event.channelId && c.parentId !== categories.archiveId,
          ) &&
          world.channels.filter((c) => categories.archiveId && c.parentId === categories.archiveId)
            .length >= 50
        ) {
          cleanupId = action.cleanup === false ? null : this.oldest(world)?.id || null;
          archiveBlocked = !cleanupId;
        }
      }
      return {
        id: randomUUID(),
        actorId: actor.id,
        expiresAt: this.clock.now() + 5 * 60000,
        action,
        cleanupId,
        announcementChannelId,
        announcementTags,
        archiveBlocked,
        replaceMessage:
          action.kind === 'repair' &&
          ['active', 'creating'].includes(this.event(action.eventId).state) &&
          Boolean(this.event(action.eventId).messageId) &&
          (await this.community.messageStatus(this.event(action.eventId))) === 'missing',
        cleanupRevision: cleanupId
          ? hash(world.channels.find((c) => c.id === this.repository.event(cleanupId)?.channelId))
          : null,
        revision: this.revision(action, world, cleanupId),
      };
    });
  }
  private save(event: CommunityEvent): void {
    this.repository.saveEvent(event);
  }
  private attempt(op: EventOperation, step: string): void {
    if (!op.attempted.includes(step)) op.attempted.push(step);
    this.repository.saveEventOperation(op);
  }
  private async categoriesForCreation(op: EventOperation): Promise<EventCategories> {
    const categories = this.categories();
    for (const [key, archived] of [
      ['activeId', false],
      ['archiveId', true],
    ] as const) {
      if (categories[key]) continue;
      // An unknown category creation outcome needs review, never a second category by name.
      const previous = this.repository
        .eventOperations()
        .find((o) => o.id !== op.id && o.attempted.includes(key));
      if (previous) {
        categories[key] = await this.community.recoverCategory(archived, previous.id);
        if (!categories[key]) throw new DomainError('e.ambiguous');
        this.repository.set('eventCategories', categories);
        continue;
      }
      this.attempt(op, key);
      categories[key] = await this.community.createCategory(archived, op.id);
      this.repository.set('eventCategories', categories);
    }
    return categories;
  }
  private async open(
    event: CommunityEvent,
    op: EventOperation,
    replaceMessage = false,
  ): Promise<void> {
    const categories = await this.categoriesForCreation(op);
    let world = await this.world();
    if (!event.roleId) {
      const previous = this.repository
        .eventOperations()
        .find((o) => o.id !== op.id && o.eventId === event.id && o.attempted.includes('role'));
      const recovered = previous ? await this.community.recoverRole(event, previous.id) : null;
      if (previous && !recovered) throw new DomainError('e.ambiguous');
      const existing = world.roles.find((r) => r.id === recovered);
      if (recovered && !existing) throw new DomainError('incomplete');
      if (
        existing &&
        (existing.managed ||
          existing.permissions !== '0' ||
          !existing.editable ||
          existing.references.length)
      )
        throw new DomainError('needsReview');
      this.attempt(op, 'role');
      if (!existing && world.roles.length >= 250 - this.roleReserve)
        throw new DomainError('capacity');
      event.roleId = existing?.id || (await this.community.createRole(event, op.id));
      this.save(event);
    } else if (!world.roles.some((r) => r.id === event.roleId))
      throw new DomainError('e.roleMissing');
    if (!event.channelId) {
      const matches = world.channels.filter(
        (c) => c.topic === `11eNexus:event:${event.id}` && c.type === 0,
      );
      if (matches.length > 1) throw new DomainError('e.ambiguous');
      this.attempt(op, 'channel');
      event.channelId =
        matches[0]?.id || (await this.community.createChannel(event, categories.activeId!, op.id));
      this.save(event);
    }
    world = await this.world();
    if (!world.channels.some((c) => c.id === event.channelId && c.parentId === categories.activeId))
      throw new DomainError('needsReview');
    await this.layout();
    if (!event.messageId) {
      const previous =
        !replaceMessage &&
        this.repository
          .eventOperations()
          .some(
            (o) =>
              o.status !== 'completed' &&
              o.id !== op.id &&
              o.attempted.includes('message') &&
              o.eventId === event.id,
          );
      if (previous) {
        event.messageId = await this.community.findMessage(event, false);
        if (!event.messageId) throw new DomainError('e.ambiguous');
      } else {
        this.attempt(op, 'message');
        event.messageId = await this.community.publish(event);
      }
      event.state = 'active';
      this.save(event);
    }
    this.attempt(op, 'pin');
    await this.community.pin(event);
    event.pinned = true;
    this.save(event);
    if (op.kind === 'repair') {
      await this.community.edit(event, op.id);
      await this.community.updateMessage(event);
    }
    event.state = 'active';
    this.save(event);
    if (event.announcementChannelId && !event.announcementId) {
      const previous = this.repository
        .eventOperations()
        .some((o) => o.attempted.includes('announcement') && o.eventId === event.id);
      if (previous) {
        event.announcementId = await this.community.findMessage(event, true);
        if (!event.announcementId) throw new DomainError('e.ambiguous');
      } else {
        const current = await this.world();
        if (
          !current.channels.some(
            (c) => c.id === event.announcementChannelId && c.parentId === this.gameCategoryId,
          )
        ) {
          event.announcementChannelId = null;
          this.save(event);
          return;
        }
        this.attempt(op, 'announcement');
        event.announcementId = await this.community.announce(event);
      }
      this.save(event);
    }
  }
  private async close(event: CommunityEvent, op: EventOperation): Promise<void> {
    const categories = this.categories();
    let world = await this.world();
    if (!event.channelId) {
      const matches = world.channels.filter(
        (c) => c.topic === `11eNexus:event:${event.id}` && c.type === 0,
      );
      if (matches.length > 1) throw new DomainError('e.ambiguous');
      event.channelId = matches[0]?.id || null;
      this.save(event);
      if (
        !event.channelId &&
        this.repository
          .eventOperations()
          .some((o) => o.eventId === event.id && o.attempted.includes('channel'))
      )
        throw new DomainError('e.ambiguous');
    }
    if (!event.roleId) {
      const previous = this.repository
        .eventOperations()
        .find((o) => o.id !== op.id && o.eventId === event.id && o.attempted.includes('role'));
      if (previous) {
        event.roleId = await this.community.recoverRole(event, previous.id);
        if (!event.roleId) throw new DomainError('e.ambiguous');
        this.save(event);
      }
    }
    const channel = world.channels.find((c) => c.id === event.channelId);
    if (channel && ![categories.activeId, categories.archiveId].includes(channel.parentId))
      throw new DomainError('needsReview');
    if (channel) await this.community.hide(event, op.id);
    event.state = 'closed';
    event.closedAt ??= this.clock.now();
    this.save(event);
    let partial = false;
    if (event.messageId && channel) {
      try {
        await this.community.updateMessage(event);
      } catch {
        partial = true;
      }
    }
    if (event.roleId && !event.roleDeleted) {
      const role = world.roles.find((r) => r.id === event.roleId);
      if (role) {
        if (role.managed || !role.editable || role.permissions !== '0' || role.references.length)
          partial = true;
        else {
          try {
            await this.community.deleteRole(role.id, op.id);
            event.roleDeleted = true;
          } catch {
            partial = true;
          }
        }
      } else event.roleDeleted = true;
      this.save(event);
    }
    if (channel && channel.parentId !== categories.archiveId) {
      world = await this.world();
      if (world.channels.filter((c) => c.parentId === categories.archiveId).length >= 50) {
        if (!op.cleanupId) throw new DomainError('e.archiveFull');
        const cleanup = this.event(op.cleanupId);
        const target = world.channels.find((c) => c.id === cleanup.channelId);
        if (
          cleanup.state !== 'archived' ||
          cleanup.issue ||
          !target ||
          target.parentId !== categories.archiveId ||
          target.hidden === false
        )
          throw new DomainError('staleAction');
        if (op.cleanupRevision !== hash(target)) throw new DomainError('staleAction');
        this.attempt(op, 'cleanup');
        await this.community.deleteChannel(target.id, op.id, target);
        cleanup.state = 'deleted';
        this.save(cleanup);
        op.cleaned = true;
        this.repository.saveEventOperation(op);
        this.repository.audit('event-cleanup', op.actorId, cleanup.id, this.clock.now());
      }
      await this.community.archive(event, categories.archiveId!, op.id);
    }
    event.state = channel ? 'archived' : 'deleted';
    event.archivedAt ??= this.clock.now();
    this.save(event);
    if (partial) throw new DomainError('e.partial');
  }
  private async layout(): Promise<void> {
    const categories = this.categories();
    if (!categories.activeId || !categories.archiveId) return;
    const events = this.repository.events();
    await this.community.layout(
      categories.activeId,
      categories.archiveId,
      events.some((e) => e.state === 'active' || e.state === 'creating'),
      events.filter((e) => e.state !== 'deleted' && e.channelId).map((e) => e.channelId!),
    );
  }
  async execute(actor: Actor, plan: EventPlan): Promise<CommunityEvent> {
    requireAdmin(actor);
    return this.mutex.run(async () => {
      const key = `admin-action:event:${plan.id}`;
      if (
        plan.actorId !== actor.id ||
        plan.expiresAt <= this.clock.now() ||
        this.repository.get(key)
      )
        throw new DomainError('staleAction');
      const world = await this.world();
      this.checkCategories(world);
      if (plan.revision !== this.revision(plan.action, world, plan.cleanupId))
        throw new DomainError('staleAction');
      await this.community.authorize(actor.id, true);
      this.repository.set(key, { expiresAt: plan.expiresAt });
      const action = plan.action;
      if (
        action.kind === 'create' &&
        plan.announcementTags.length &&
        !action.draft.announcementTagId
      )
        throw new DomainError('e.tagRequired');
      const event: CommunityEvent =
        action.kind === 'create'
          ? {
              id: plan.id,
              ...action.draft,
              gameName: this.repository.game(action.draft.gameId)!.name,
              state: 'creating',
              creatorId: actor.id,
              createdAt: this.clock.now(),
              closedAt: null,
              archivedAt: null,
              channelId: null,
              roleId: null,
              roleDeleted: false,
              messageId: null,
              announcementChannelId: plan.announcementChannelId,
              announcementId: null,
              issue: null,
            }
          : this.event(action.eventId);
      if (plan.replaceMessage) {
        if ((await this.community.messageStatus(event)) !== 'missing')
          throw new DomainError('staleAction');
        event.messageId = null;
      }
      const op: EventOperation = {
        id: randomUUID(),
        eventId: event.id,
        actorId: actor.id,
        kind: action.kind,
        status: 'pending',
        startedAt: this.clock.now(),
        completedAt: null,
        attempted: [],
        cleanupId: plan.cleanupId,
        cleanupRevision: plan.cleanupRevision,
        cleaned: false,
      };
      this.repository.transaction(() => {
        this.save(event);
        this.repository.saveEventOperation(op);
      });
      try {
        if (
          action.kind === 'create' ||
          (action.kind === 'repair' && ['creating', 'active'].includes(event.state))
        )
          await this.open(event, op, plan.replaceMessage);
        else if (action.kind === 'close' || action.kind === 'repair') await this.close(event, op);
        else if (action.kind === 'edit') {
          event.name = action.name;
          event.description = action.description;
          this.save(event);
          await this.community.edit(event, op.id);
          await this.community.updateMessage(event);
        }
        await this.layout();
        event.issue = null;
        this.save(event);
        op.status = 'completed';
        op.completedAt = this.clock.now();
        this.repository.saveEventOperation(op);
        // A successful explicit repair resolves the earlier interrupted actions for this event.
        if (action.kind === 'repair' || action.kind === 'close')
          for (const previous of this.repository.eventOperations())
            if (previous.eventId === event.id && previous.status !== 'completed') {
              previous.status = 'completed';
              previous.completedAt = this.clock.now();
              this.repository.saveEventOperation(previous);
            }
        this.repository.audit(`event-${action.kind}`, actor.id, event.id, this.clock.now());
        return event;
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
        if (
          error instanceof DomainError ||
          (status >= 400 && status < 500 && ![408, 429].includes(status))
        ) {
          const categories = this.categories();
          const unconfirmed = [
            !event.roleId ? 'role' : null,
            !event.channelId ? 'channel' : null,
            !event.messageId ? 'message' : null,
            !event.announcementId ? 'announcement' : null,
            !categories.activeId ? 'activeId' : null,
            !categories.archiveId ? 'archiveId' : null,
          ];
          op.attempted = op.attempted.filter((step) => !unconfirmed.includes(step));
        }
        event.issue = error instanceof DomainError ? error.code : 'discordError';
        this.save(event);
        op.status = 'review';
        this.repository.saveEventOperation(op);
        if (
          error instanceof DomainError &&
          error.code === 'e.archiveFull' &&
          event.state === 'closed' &&
          plan.archiveBlocked
        ) {
          await this.layout();
          return event;
        }
        throw new DomainError('e.partial', { name: event.name });
      }
    });
  }
  async subscribe(actor: Actor, id: string, enabled: boolean): Promise<boolean> {
    requireMember(actor);
    return this.mutex.run(async () => {
      const event = this.event(id);
      if (event.state !== 'active' || !event.roleId || event.roleDeleted)
        throw new DomainError('e.closed');
      const world = await this.world();
      if (
        !world.channels.some(
          (c) =>
            c.id === event.channelId &&
            c.parentId === this.categories().activeId &&
            c.hidden !== true,
        ) ||
        !world.roles.some(
          (r) => r.id === event.roleId && r.editable && r.permissions === '0' && !r.managed,
        )
      )
        throw new DomainError('e.roleMissing');
      await this.community.authorize(actor.id, false);
      await this.community.subscribe(event.roleId, actor.id, enabled);
      return this.community.subscribed(event.roleId, actor.id);
    });
  }
  async synchronize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const observed = await this.mutex.run(async () => ({
      events: this.repository.events(),
      operations: this.repository.eventOperations(),
      categories: this.categories(),
    }));
    if (!observed.events.some((e) => e.state !== 'deleted')) return;
    const issueFor = (event: CommunityEvent, world: EventWorld): string | null => {
      const channel = world.channels.find((c) => c.id === event.channelId);
      const categories = observed.categories;
      if (!channel || ![categories.activeId, categories.archiveId].includes(channel.parentId))
        return 'e.channelMissing';
      if (event.state === 'active' && channel.parentId !== categories.activeId)
        return 'e.channelMissing';
      if (event.state === 'closed' && channel.hidden === false) return 'needsReview';
      if (
        event.state === 'active' &&
        (!world.roles.some((r) => r.id === event.roleId) || channel.hidden)
      )
        return 'e.roleMissing';
      if (
        event.state === 'archived' &&
        (channel.parentId !== categories.archiveId || channel.hidden === false)
      )
        return 'needsReview';
      return event.state === 'creating' ? 'e.partial' : null;
    };
    signal?.throwIfAborted();
    let world = await this.world();
    signal?.throwIfAborted();
    const messages = new Map<string, string>();
    // Slow message reads never own the mutation mutex used by personal panels.
    for (const event of observed.events) {
      signal?.throwIfAborted();
      if (event.state === 'active' && !issueFor(event, world)) {
        messages.set(event.id, await this.community.messageStatus(event));
        signal?.throwIfAborted();
      }
    }
    // Manual moves/deletions during message reads win over the earlier inventory.
    if (messages.size) world = await this.world();
    signal?.throwIfAborted();
    await this.mutex.run(async () => {
      signal?.throwIfAborted();
      if (hash(this.categories()) !== hash(observed.categories)) return;
      const currentOperations = new Map(this.repository.eventOperations().map((op) => [op.id, op]));
      this.repository.transaction(() => {
        for (const op of observed.operations) {
          if (
            op.status === 'completed' ||
            !op.cleanupId ||
            op.cleaned ||
            !op.attempted.includes('cleanup')
          )
            continue;
          const target = this.repository.event(op.cleanupId);
          const before = observed.events.find((e) => e.id === op.cleanupId);
          if (
            hash(currentOperations.get(op.id)) !== hash(op) ||
            !target ||
            !before ||
            hash(target) !== hash(before)
          )
            continue;
          if (target.channelId && !world.channels.some((c) => c.id === target.channelId)) {
            target.state = 'deleted';
            this.save(target);
            op.cleaned = true;
            this.repository.saveEventOperation(op);
          }
        }
        for (const before of observed.events) {
          const event = this.repository.event(before.id);
          // A close, repair or edit completed during the scan: discard its old observation.
          if (!event || event.state === 'deleted' || hash(event) !== hash(before)) continue;
          // A successful repair can leave the same IDs/fields (for example repinning).
          // Its operation receipt still invalidates the earlier network observation.
          if (
            hash(observed.operations.filter((op) => op.eventId === event.id)) !==
            hash([...currentOperations.values()].filter((op) => op.eventId === event.id))
          )
            continue;
          let issue = issueFor(event, world);
          if (
            !issue &&
            event.state === 'active' &&
            messages.has(event.id) &&
            messages.get(event.id) !== 'present'
          ) {
            issue = 'e.messageMissing';
            event.pinned = false;
          }
          if (issue && event.issue !== issue) {
            event.issue = issue;
            this.save(event);
          }
        }
      });
    });
  }
}
