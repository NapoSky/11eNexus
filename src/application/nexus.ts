import { randomUUID } from 'node:crypto';
import {
  archiveCandidates,
  blocksMemberCreation,
  ADMIN_RETENTION_MS,
  validateGameIdentity,
  DAY,
  DomainError,
  normalize,
  requireAdmin,
  requireMember,
  type Actor,
  type Asset,
  type Game,
  type Locale,
  type Operation,
  type Proposal,
} from '../domain/model.js';
import {
  Mutex,
  type Catalogue,
  type Clock,
  type Community,
  type Repository,
  type Scheduler,
  type World,
  type Activity,
} from './ports.js';
import { eventRoleName } from '../domain/community-event.js';

// Guards run inside the same application mutex as the mutation.
export interface ReconciliationObservation {
  world: World;
  activities: Map<
    string,
    {
      channelId: string | null;
      activatedAt: number;
      activity: Activity;
      historyRead: boolean;
      failed?: boolean;
    }
  >;
}
export type MutationGuard = (observation?: ReconciliationObservation) => Promise<void>;
export interface PreparedGame {
  name: string;
  url: string;
  assetId: string;
  rawgId: number | null;
}

export interface Policy {
  maxGames: number;
  minActive: number;
  roleReserve: number;
  activeCategoryId: string;
  notificationCooldown: number;
  newGameRoleId: string;
  reservedRoleIds?: string[];
}
interface NewGameAnnouncement {
  status: 'pending' | 'sending' | 'sent' | 'review';
  createdAt: number;
  sentAt?: number;
  messageId?: string;
}
export class Nexus {
  readonly mutex = new Mutex();
  private readonly synchronization = new Mutex();
  private readonly announcementQueue = new Mutex();
  private readonly announcementDeliveries = new Map<string, Promise<void>>();
  private readonly receivedActivity = new Map<string, number>();
  constructor(
    readonly repository: Repository,
    readonly community: Community,
    readonly catalogue: Catalogue,
    readonly policy: Policy,
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly scheduler: Scheduler = { yield: async () => {} },
  ) {}
  private now(): number {
    return this.clock.now();
  }
  private async authorize(actor: Actor, admin = false): Promise<Actor> {
    const fresh = await this.community.authorize(actor);
    if (fresh.id !== actor.id) throw new DomainError('forbidden');
    if (admin) requireAdmin(fresh);
    else requireMember(fresh);
    return fresh;
  }
  assertRepairResources(
    channelId: string | null,
    roleId: string | null,
    roleName?: string,
    topic?: string | null,
  ): void {
    const events = this.repository.events();
    const unresolved = new Set(
      this.repository
        .eventOperations()
        .filter((op) => op.status !== 'completed' && op.attempted.includes('role'))
        .map((op) => op.eventId),
    );
    if (
      topic?.startsWith('11eNexus:event:') ||
      (roleId &&
        [this.policy.newGameRoleId, ...(this.policy.reservedRoleIds || [])].includes(roleId)) ||
      events.some(
        (event) =>
          (channelId && event.channelId === channelId) ||
          (roleId && event.roleId === roleId) ||
          (!event.roleId &&
            roleName &&
            unresolved.has(event.id) &&
            eventRoleName(event) === roleName),
      )
    )
      throw new DomainError('repairReservedResource');
  }
  observedGame(game: Game): Game {
    const observed = { ...game };
    this.mergeActivity(observed);
    return observed;
  }
  private mergeActivity(game: Game, activity?: Activity): void {
    const received = game.channelId ? this.receivedActivity.get(game.channelId) : undefined;
    const at = Math.max(activity?.at ?? 0, received ?? 0, game.lastActivityAt ?? 0);
    if (at > 0) game.lastActivityAt = at;
    if (at >= game.activatedAt && at > 0) game.awaitingActivity = false;
  }
  private queueNewGameAnnouncement(game: Game): void {
    const key = `new-game-announcement:${game.id}`;
    if (!this.repository.get(key))
      this.repository.set(key, {
        status: 'pending',
        createdAt: this.now(),
      } satisfies NewGameAnnouncement);
  }
  private deliverNewGameAnnouncement(id: string): Promise<void> {
    const existing = this.announcementDeliveries.get(id);
    if (existing) return existing;
    const task = this.announcementQueue.run(() => this.sendNewGameAnnouncement(id));
    this.announcementDeliveries.set(id, task);
    const finished = () => this.announcementDeliveries.delete(id);
    void task.then(finished, finished);
    return task;
  }
  private async sendNewGameAnnouncement(id: string): Promise<void> {
    const key = `new-game-announcement:${id}`;
    const claim = await this.mutex.run(async () => {
      const game = this.repository.game(id);
      const item = this.repository.get<NewGameAnnouncement>(key);
      if (!game || !item || item.status === 'sent' || item.status === 'review') return;
      const review =
        item.status === 'sending' || game.blocked || game.retired || game.state !== 'active';
      // Claim before network I/O. A persisted 'sending' without a live task is uncertain.
      this.repository.set(key, { ...item, status: review ? 'review' : 'sending' });
      return { game, item, review };
    });
    if (!claim) return;
    const { game, item } = claim;
    const review = async () => {
      await this.mutex.run(async () => this.repository.set(key, { ...item, status: 'review' }));
      await this.community.alert(`announcement:${id}`, 'newGameAnnouncementNeedsReview', {
        game: game.name,
      });
    };
    if (claim.review) {
      await this.community.alert(`announcement:${id}`, 'newGameAnnouncementNeedsReview', {
        game: game.name,
      });
      return;
    }
    try {
      const messageId = await this.community.announceNewGame(game);
      await this.mutex.run(async () =>
        this.repository.set(key, { ...item, status: 'sent', sentAt: this.now(), messageId }),
      );
    } catch {
      await review();
    }
  }
  async deliverNewGameAnnouncements(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const game of this.repository.games(true)) {
      const item = this.repository.get<NewGameAnnouncement>(`new-game-announcement:${game.id}`);
      if (!item || item.status === 'sent' || item.status === 'review') continue;
      signal?.throwIfAborted();
      await this.scheduler.yield();
      signal?.throwIfAborted();
      await this.deliverNewGameAnnouncement(game.id);
    }
  }
  private game(id: string): Game {
    const game = this.repository.game(id);
    if (!game || game.retired) throw new DomainError('notFound');
    return game;
  }
  private quota(actorId: string): void {
    const previous = this.repository.cooldown(actorId);
    if (previous !== null && previous + DAY > this.now())
      throw new DomainError('cooldown', {
        minutes: Math.ceil((previous + DAY - this.now()) / 60000),
      });
    if (
      this.repository
        .operations()
        .some((operation) => blocksMemberCreation(operation, actorId, this.now()))
    )
      throw new DomainError('inProgress');
  }
  private requireSettled(id: string): void {
    if (
      this.repository
        .operations()
        .some((o) => o.gameId === id && (o.status === 'pending' || o.status === 'review'))
    )
      throw new DomainError('needsReview');
  }
  private operation(
    kind: Operation['kind'],
    game: Game,
    actorId: string | null,
    data: Record<string, unknown> = {},
  ): Operation {
    const op: Operation = {
      id: randomUUID(),
      kind,
      gameId: game.id,
      actorId,
      status: 'pending',
      startedAt: this.now(),
      data,
      error: null,
    };
    this.repository.saveOperation(op);
    return op;
  }
  private finish(op: Operation, status: Operation['status'], error: string | null = null): void {
    op.status = status;
    op.error = error;
    op.completedAt = ['completed', 'failed'].includes(status) ? this.now() : null;
    this.repository.saveOperation(op);
  }
  private async full(): Promise<never> {
    await this.community.alert('catalogue-capacity', 'catalogueCapacity');
    throw new DomainError('capacity');
  }
  private async capacity(needsRole = true, needsChannel = true): Promise<World> {
    const world = await this.community.snapshot();
    if (!world.complete) throw new DomainError('incomplete');
    if (
      world.channels.filter((c) => c.parentId === this.policy.activeCategoryId).length >= 50 ||
      (needsChannel && world.channels.length >= 500)
    )
      return this.full();
    if (needsRole && !world.roleIcons) throw new DomainError('iconsUnavailable');
    if (needsRole && world.roles.length >= 250 - this.policy.roleReserve) {
      const recyclable = this.repository
        .games()
        .filter(
          (g) => g.state === 'archived' && g.canRecycle && g.roleState === 'present' && !g.blocked,
        )
        .sort((a, b) => (a.lastActivityAt ?? a.activatedAt) - (b.lastActivityAt ?? b.activatedAt))
        .find((g) => {
          const r = world.roles.find((r) => r.id === g.roleId);
          try {
            this.assertRepairResources(g.channelId, g.roleId, r?.name);
          } catch {
            return false;
          }
          return r?.editable && !r.managed && r.permissions === '0' && r.references.length === 0;
        });
      if (!recyclable) return this.full();
      await this.recycleInternal(recyclable, world);
      const refreshed = await this.community.snapshot();
      if (!refreshed.complete) throw new DomainError('incomplete');
      if (refreshed.roles.length >= 250 - this.policy.roleReserve) return this.full();
      return refreshed;
    }
    return world;
  }
  async create(
    actor: Actor,
    rawgId: number,
    guard?: MutationGuard,
    preview?: { candidate: import('../domain/model.js').Candidate; assetId: string },
  ): Promise<Game> {
    requireMember(actor);
    const existing = this.repository.byRawg(rawgId);
    // Provider reads and image conversion never occupy the application mutation queue.
    if (!existing && !actor.admin) this.quota(actor.id);
    const candidate = existing
      ? undefined
      : preview?.candidate || (await this.catalogue.get(rawgId));
    if (preview && preview.candidate.id !== rawgId) throw new DomainError('invalidInput');
    const asset = existing
      ? null
      : preview
        ? this.repository.asset(preview.assetId)
        : await this.catalogue.image(candidate!);
    const game = await this.mutex.run(async () => {
      actor = await this.authorize(actor);
      await guard?.();
      const current = this.repository.byRawg(rawgId);
      if (current) {
        if (current.retired) throw new DomainError('blocked');
        if (current.blocked || current.state === 'unavailable')
          throw new DomainError('partial', { game: current.name });
        return current;
      }
      if (!candidate || !asset) throw new DomainError('needsReview');
      return this.createInternal(actor, candidate.name, rawgId, candidate.url, asset);
    });
    await this.deliverNewGameAnnouncement(game.id);
    return game;
  }
  private async createInternal(
    actor: Actor,
    name: string,
    rawgId: number | null,
    url: string,
    asset: Asset,
    beneficiaryId?: string,
  ): Promise<Game> {
    requireMember(actor);
    if (!actor.admin) this.quota(actor.id);
    if (this.repository.games().length >= this.policy.maxGames) return this.full();
    if (!name.trim() || name.length > 100) throw new DomainError('invalidInput');
    if (
      rawgId === null &&
      this.repository.games(true).some((g) => normalize(g.name) === normalize(name))
    )
      throw new DomainError('duplicateGame');
    const world = await this.capacity();
    const game: Game = {
      id: randomUUID(),
      rawgId,
      name: name.trim(),
      aliases: [],
      channelId: null,
      roleId: null,
      roleState: 'missing',
      state: 'unavailable',
      lastActivityAt: null,
      activatedAt: this.now(),
      awaitingActivity: true,
      assetId: asset.id,
      externalUrl: url,
      canRecycle: true,
      blocked: false,
      retired: false,
    };
    this.repository.saveAsset(asset);
    this.repository.saveGame(game);
    const op = this.operation('create', game, actor.id, {
      administrative: actor.admin,
      beneficiaryId: beneficiaryId || actor.id,
      roleName: game.name,
      previousRoleIds: world.roles.map((r) => r.id),
      announceNewGame: true,
    });
    try {
      game.channelId = await this.community.createChannel(game, op.id);
      this.repository.saveGame(game);
      game.roleId = await this.community.createRole(game, asset, op.id);
      game.roleState = 'present';
      this.repository.saveGame(game);
      game.state = 'active';
      game.activatedAt = this.now();
      game.addedAt = this.now();
      this.repository.transaction(() => {
        this.repository.saveGame(game);
        if (!actor.admin) this.repository.setCooldown(actor.id, this.now());
        this.finish(op, 'completed');
        this.repository.audit('create', actor.id, game.id, this.now());
        this.queueNewGameAnnouncement(game);
      });
    } catch (error) {
      game.blocked = true;
      this.repository.saveGame(game);
      this.finish(op, 'review', error instanceof DomainError ? error.code : 'discordError');
      await this.community.alert(`partial:${op.id}`, 'partial', { game: game.name });
      throw new DomainError('partial', { game: game.name });
    }
    return game;
  }
  async activate(actor: Actor, id: string, guard?: MutationGuard): Promise<Game> {
    requireMember(actor);
    return this.mutex.run(async () => {
      actor = await this.authorize(actor);
      await guard?.();
      const game = this.game(id);
      this.requireSettled(id);
      if (game.blocked || game.state === 'unavailable') throw new DomainError('blocked');
      if (game.state === 'active') return game;
      if (!actor.admin) this.quota(actor.id);
      if (game.roleState === 'missing') throw new DomainError('needsReview');
      const world = await this.capacity(game.roleState === 'recycled', false);
      const op = this.operation('activate', game, actor.id, {
        administrative: actor.admin,
        roleName: game.name,
        previousRoleIds: world.roles.map((r) => r.id),
      });
      try {
        if (game.roleState === 'recycled') {
          const asset = game.assetId ? this.repository.asset(game.assetId) : null;
          if (!asset) throw new DomainError('needsReview');
          game.roleId = await this.community.createRole(game, asset, op.id);
          this.repository.saveGame(game);
          // Completed assignments are journalled; a restart never blindly replays the list.
          for (const userId of this.repository
            .subscribers(game.id)
            .filter((id) => world.memberIds.includes(id)))
            await this.community.setSubscription(game.roleId, userId, true);
          game.roleState = 'present';
          this.repository.saveGame(game);
        }
        await this.community.move(game, false, op.id);
        game.state = 'active';
        game.awaitingActivity = true;
        game.activatedAt = this.now();
        this.repository.saveGame(game);
        if (!actor.admin) this.repository.setCooldown(actor.id, this.now());
        this.finish(op, 'completed');
        this.repository.audit('activate', actor.id, game.id, this.now());
        return game;
      } catch (error) {
        game.blocked = true;
        this.repository.saveGame(game);
        this.finish(op, 'review', error instanceof DomainError ? error.code : 'discordError');
        await this.community.alert(`partial:${op.id}`, 'partial', { game: game.name });
        throw new DomainError('partial', { game: game.name });
      }
    });
  }
  async newGameAlerts(actor: Actor): Promise<boolean> {
    requireMember(actor);
    return this.community.subscription(this.policy.newGameRoleId, actor.id);
  }
  async setNewGameAlerts(actor: Actor, enabled: boolean): Promise<boolean> {
    requireMember(actor);
    return this.mutex.run(async () => {
      actor = await this.authorize(actor);
      const roleId = this.policy.newGameRoleId;
      if (this.repository.games(true).some((game) => game.roleId === roleId))
        throw new DomainError('newGameAlertsUnavailable');
      if ((await this.community.subscription(roleId, actor.id)) !== enabled)
        await this.community.setSubscription(roleId, actor.id, enabled, true);
      const actual = await this.community.subscription(roleId, actor.id);
      if (actual !== enabled) throw new DomainError('newGameAlertsUnavailable');
      this.repository.audit('new-game-alerts', actor.id, enabled ? 'on' : 'off', this.now());
      return actual;
    });
  }
  async subscribe(actor: Actor, id: string, enabled: boolean): Promise<boolean> {
    requireMember(actor);
    return this.mutex.run(async () => {
      actor = await this.authorize(actor);
      const game = this.game(id);
      this.assertRepairResources(game.channelId, game.roleId);
      this.requireSettled(id);
      if (game.blocked) throw new DomainError('blocked');
      if (game.roleState === 'recycled') {
        this.repository.subscribe(id, actor.id, enabled);
        return enabled;
      }
      if (game.roleState !== 'present' || !game.roleId) throw new DomainError('needsReview');
      await this.community.setSubscription(game.roleId, actor.id, enabled, true);
      const actual = await this.community.subscription(game.roleId, actor.id);
      this.repository.subscribe(id, actor.id, actual);
      if (actual !== enabled) throw new DomainError('discordError');
      return actual;
    });
  }
  validateIdentity(name: string, url: string): string {
    return validateGameIdentity(name, url);
  }
  private saveProposal(proposal: Proposal): void {
    proposal.updatedAt = this.now();
    proposal.closedAt = ['accepted', 'rejected', 'expired'].includes(proposal.status)
      ? this.now()
      : null;
    this.repository.saveProposal(proposal);
  }
  async maintain(): Promise<void> {
    await this.mutex.run(async () => {
      const now = this.now();
      this.repository.transaction(() => {
        const started = this.repository.get<number>('retentionStartedAt') ?? now;
        if (this.repository.get('retentionStartedAt') === undefined)
          this.repository.set('retentionStartedAt', started);
        for (const proposal of this.repository.proposals()) {
          const lastActivity = proposal.updatedAt ?? Math.max(proposal.createdAt, started);
          if (
            ['pending', 'needs_info'].includes(proposal.status) &&
            lastActivity + ADMIN_RETENTION_MS <= now
          ) {
            proposal.status = 'expired';
            this.saveProposal(proposal);
            this.repository.audit('expire-proposal', null, proposal.id, now);
          }
        }
      });
      this.repository.maintain(now);
    });
  }
  async propose(actor: Actor, name: string, url: string, locale: Locale): Promise<Proposal> {
    requireMember(actor);
    return this.mutex.run(async () => {
      actor = await this.authorize(actor);
      const validatedUrl = this.validateIdentity(name, url);
      const pending = this.repository
        .proposals()
        .find(
          (p) =>
            (p.status === 'pending' || p.status === 'needs_info') &&
            normalize(p.name) === normalize(name),
        );
      if (pending) {
        if (pending.actorId === actor.id) return pending;
        throw new DomainError('alreadyProposed');
      }
      if (
        !actor.admin &&
        this.repository.proposals(actor.id).some((p) => p.createdAt + DAY > this.now())
      )
        throw new DomainError('proposalCooldown');
      if (
        !actor.admin &&
        this.repository
          .proposals()
          .filter((p) => p.status === 'pending' || p.status === 'needs_info').length >= 50
      )
        return this.full();
      const proposal: Proposal = {
        id: randomUUID(),
        actorId: actor.id,
        name: name.trim(),
        url: validatedUrl,
        status: 'pending',
        reason: null,
        gameId: null,
        createdAt: this.now(),
        locale,
      };
      this.saveProposal(proposal);
      await this.community.alert(`proposal:${proposal.id}`, 'proposalAlert', {
        game: proposal.name,
      });
      return proposal;
    });
  }
  async approve(
    admin: Actor,
    requester: Actor,
    id: string,
    asset: Asset,
    parentGameId?: string,
  ): Promise<Game> {
    requireAdmin(admin);
    return this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      const proposal = this.repository.proposal(id);
      if (proposal?.status !== 'pending' || proposal.actorId !== requester.id)
        throw new DomainError('notFound');
      const chosenAsset = parentGameId
        ? this.repository.asset(this.game(parentGameId).assetId || '')
        : asset;
      if (!chosenAsset) throw new DomainError('invalidImage');
      requireMember(requester);
      const game = await this.createInternal(
        admin,
        proposal.name,
        null,
        proposal.url,
        chosenAsset,
        requester.id,
      );
      proposal.status = 'accepted';
      proposal.gameId = game.id;
      this.saveProposal(proposal);
      this.repository.audit('approve', admin.id, proposal.id, this.now());
      return game;
    });
  }
  async reject(admin: Actor, id: string, reason: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const proposal = this.repository.proposal(id);
      if (
        !proposal ||
        !['pending', 'needs_info'].includes(proposal.status) ||
        !reason.trim() ||
        reason.length > 500
      )
        throw new DomainError('invalidInput');
      proposal.status = 'rejected';
      proposal.reason = reason;
      this.saveProposal(proposal);
      this.repository.audit('reject', admin.id, id, this.now());
    });
  }
  async clarify(admin: Actor, id: string, reason: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const p = this.repository.proposal(id);
      if (
        !p ||
        !['pending', 'needs_info'].includes(p.status) ||
        !reason.trim() ||
        reason.length > 500
      )
        throw new DomainError('invalidInput');
      p.status = 'needs_info';
      p.reason = reason.trim();
      this.saveProposal(p);
      this.repository.audit('clarify', admin.id, id, this.now());
    });
  }
  async amendProposal(actor: Actor, id: string, name: string, url: string): Promise<Proposal> {
    requireMember(actor);
    return this.mutex.run(async () => {
      actor = await this.authorize(actor);
      const p = this.repository.proposal(id);
      if (!p || p.actorId !== actor.id) throw new DomainError('forbidden');
      if (p.status !== 'needs_info') throw new DomainError('invalidInput');
      const validatedUrl = this.validateIdentity(name, url);
      if (
        this.repository
          .proposals()
          .some(
            (other) =>
              other.id !== id &&
              ['pending', 'needs_info'].includes(other.status) &&
              normalize(other.name) === normalize(name),
          )
      )
        throw new DomainError('alreadyProposed');
      p.name = name.trim();
      p.url = validatedUrl;
      p.status = 'pending';
      p.reason = null;
      this.saveProposal(p);
      this.repository.audit('amend-proposal', actor.id, id, this.now());
      await this.community.alert(`proposal-update:${p.id}:${this.now()}`, 'proposalAlert', {
        game: p.name,
      });
      return p;
    });
  }
  async notify(actor: Actor, id: string, message: string): Promise<void> {
    requireMember(actor);
    if (!message.trim() || message.length > 1000) throw new DomainError('invalidInput');
    return this.mutex.run(async () => {
      actor = await this.authorize(actor);
      const game = this.game(id);
      if (game.state !== 'active' || game.blocked || game.roleState !== 'present')
        throw new DomainError('blocked');
      const key = `notification:${actor.id}:${game.id}`;
      const previous = this.repository.get<number>(key);
      if (previous !== undefined && previous + this.policy.notificationCooldown > this.now())
        throw new DomainError('notificationCooldown');
      await this.community.notify(game, actor.id, message);
      this.repository.set(key, this.now());
      this.repository.audit('notify', actor.id, id, this.now());
    });
  }
  async block(admin: Actor, id: string, enabled: boolean, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const g = this.game(id);
      if (!enabled) this.requireSettled(id);
      g.blocked = enabled;
      this.repository.saveGame(g);
      this.repository.audit(enabled ? 'block' : 'unblock', admin.id, id, this.now());
    });
  }
  async retire(admin: Actor, id: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const g = this.game(id);
      this.requireSettled(id);
      if (g.state === 'active') throw new DomainError('archiveFirst');
      g.retired = true;
      g.blocked = true;
      this.repository.saveGame(g);
      this.repository.audit('retire', admin.id, id, this.now());
    });
  }
  async edit(
    admin: Actor,
    id: string,
    name: string,
    aliases: string[],
    align = false,
    guard?: MutationGuard,
  ): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      if (
        !name.trim() ||
        name.length > 100 ||
        aliases.length > 20 ||
        aliases.some((a) => !a.trim() || a.length > 100)
      )
        throw new DomainError('invalidInput');
      const game = this.game(id);
      this.requireSettled(id);
      if (
        this.repository
          .games(true)
          .some((g) => g.id !== id && normalize(g.name) === normalize(name))
      )
        throw new DomainError('duplicateGame');
      if (align) {
        const op = this.operation('rename', game, admin.id, {
          previousName: game.name,
          name: name.trim(),
        });
        try {
          await this.community.renameGame(game, name.trim(), op.id);
          this.finish(op, 'completed');
        } catch {
          game.blocked = true;
          this.repository.saveGame(game);
          this.finish(op, 'review', 'discordError');
          throw new DomainError('partial', { game: game.name });
        }
      }
      game.name = name.trim();
      game.aliases = [...new Set(aliases.map((a) => a.trim()))];
      this.repository.saveGame(game);
      this.repository.audit('edit', admin.id, id, this.now());
    });
  }
  async repair(
    admin: Actor,
    id: string,
    channelId: string,
    roleId: string,
    guard?: MutationGuard,
  ): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const game = this.game(id);
      const world = await this.community.snapshot();
      if (!world.complete) throw new DomainError('incomplete');
      const channel = world.channels.find((c) => c.id === channelId);
      const role = world.roles.find((r) => r.id === roleId);
      this.assertRepairResources(channelId, roleId, role?.name, channel?.topic);
      if (
        !channel ||
        ![0, 5, 15, 16].includes(channel.type) ||
        !role ||
        role.managed ||
        role.permissions !== '0' ||
        role.references.some((reference) => reference !== channelId) ||
        !role.editable ||
        this.repository
          .games(true)
          .some((g) => g.id !== id && (g.channelId === channelId || g.roleId === roleId))
      )
        throw new DomainError('invalidInput');
      if (
        channel.parentId !== this.policy.activeCategoryId &&
        !world.archiveCategoryIds.includes(channel.parentId || '')
      )
        throw new DomainError('invalidInput');
      game.channelId = channelId;
      game.roleId = roleId;
      game.roleState = 'present';
      game.state = channel.parentId === this.policy.activeCategoryId ? 'active' : 'archived';
      game.activatedAt = this.now();
      game.awaitingActivity = true;
      game.blocked = false;
      await this.community.repairResources(game);
      this.repository.saveGame(game);
      this.repository.replaceSubscribers(game.id, role.members);
      for (const op of this.repository
        .operations()
        .filter((o) => o.gameId === id && (o.status === 'pending' || o.status === 'review'))) {
        if (op.kind === 'create') {
          game.addedAt ??= this.now();
          this.repository.saveGame(game);
          if (op.data.announceNewGame === true && game.state === 'active')
            this.queueNewGameAnnouncement(game);
        }
        this.finish(op, 'completed');
      }
      this.repository.audit('repair', admin.id, id, this.now());
    });
  }
  async addByAdmin(
    admin: Actor,
    input: PreparedGame,
    guard?: MutationGuard,
    proposalId?: string,
    requester?: Actor,
  ): Promise<Game> {
    requireAdmin(admin);
    const game = await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const p = proposalId ? this.repository.proposal(proposalId) : undefined;
      if (
        proposalId &&
        (!p || !['pending', 'needs_info'].includes(p.status) || p.actorId !== requester?.id)
      )
        throw new DomainError('staleAction');
      if (p && !requester?.member && !requester?.admin)
        throw new DomainError('requesterUnavailable');
      const url = this.validateIdentity(input.name, input.url);
      const asset = this.repository.asset(input.assetId);
      if (!asset) throw new DomainError('invalidImage');
      if (input.rawgId !== null && this.repository.byRawg(input.rawgId))
        throw new DomainError('duplicateGame');
      if (this.repository.games(true).some((g) => normalize(g.name) === normalize(input.name)))
        throw new DomainError('duplicateGame');
      const game = await this.createInternal(
        admin,
        input.name,
        input.rawgId,
        url,
        asset,
        p?.actorId,
      );
      if (p) {
        p.status = 'accepted';
        p.name = game.name;
        p.url = url;
        p.gameId = game.id;
        this.saveProposal(p);
        this.repository.audit('approve', admin.id, p.id, this.now());
      }
      return game;
    });
    await this.deliverNewGameAnnouncement(game.id);
    return game;
  }
  async attachProposal(
    admin: Actor,
    proposalId: string,
    gameId: string,
    guard?: MutationGuard,
  ): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const p = this.repository.proposal(proposalId);
      const game = this.game(gameId);
      if (!p || !['pending', 'needs_info'].includes(p.status)) throw new DomainError('staleAction');
      this.requireSettled(gameId);
      if (game.blocked) throw new DomainError('blocked');
      p.status = 'accepted';
      p.gameId = gameId;
      p.reason = null;
      this.saveProposal(p);
      this.repository.audit('attach-proposal', admin.id, p.id, this.now());
    });
  }
  async archive(admin: Actor, id: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      admin = await this.authorize(admin, true);
      await guard?.();
      const game = this.game(id);
      this.requireSettled(id);
      if (game.blocked || game.state !== 'active') throw new DomainError('blocked');
      const op = this.operation('archive', game, admin.id, { administrative: true });
      try {
        await this.community.move(game, true, op.id);
        game.state = 'archived';
        this.repository.saveGame(game);
        this.finish(op, 'completed');
        this.repository.audit('admin-archive', admin.id, id, this.now());
      } catch {
        game.blocked = true;
        this.repository.saveGame(game);
        this.finish(op, 'review', 'discordError');
        throw new DomainError('partial', { game: game.name });
      }
    });
  }
  private async recycleInternal(game: Game, world: World): Promise<void> {
    this.assertRepairResources(game.channelId, game.roleId);
    const role = world.roles.find((r) => r.id === game.roleId);
    if (
      !role ||
      !world.complete ||
      role.references.length ||
      role.permissions !== '0' ||
      role.managed ||
      !role.editable ||
      !game.assetId
    )
      throw new DomainError('needsReview');
    const op = this.operation('recycle', game, null, { roleId: game.roleId });
    this.repository.transaction(() => {
      this.repository.replaceSubscribers(game.id, role.members);
      game.roleState = 'recycled';
      this.repository.saveGame(game);
    });
    try {
      await this.community.deleteRole(role.id, op.id);
      this.finish(op, 'completed');
    } catch {
      this.finish(op, 'review', 'discordError');
      throw new DomainError('partial', { game: game.name });
    }
  }
  async recordActivity(channelId: string, at: number): Promise<void> {
    if (!this.repository.games().some((g) => g.channelId === channelId)) return;
    this.receivedActivity.set(channelId, Math.max(at, this.receivedActivity.get(channelId) ?? 0));
    await this.mutex.run(async () => {
      const game = this.repository.games().find((g) => g.channelId === channelId);
      if (!game) return;
      this.mergeActivity(game);
      this.repository.saveGame(game);
      if ((this.receivedActivity.get(channelId) ?? 0) <= (game.lastActivityAt ?? 0))
        this.receivedActivity.delete(channelId);
    });
  }
  async synchronize(
    rotate = true,
    guard?: MutationGuard,
    admin?: Actor,
    archiveIds?: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (admin) requireAdmin(admin);
    return this.synchronization.run(async () => {
      signal?.throwIfAborted();
      const activities: ReconciliationObservation['activities'] = new Map();
      const recovering = this.repository
        .operations()
        .filter((op) => op.kind === 'create' && op.status === 'pending');
      for (const game of this.repository.games()) {
        signal?.throwIfAborted();
        await this.scheduler.yield();
        signal?.throwIfAborted();
        const creation = recovering.find((op) => op.gameId === game.id);
        if (creation) {
          game.activatedAt = creation.startedAt;
          game.awaitingActivity = true;
          if (!game.channelId) {
            const recoveryWorld = await this.community.snapshot(signal);
            if (!recoveryWorld.complete) throw new DomainError('incomplete');
            const matches = recoveryWorld.channels.filter((c) =>
              c.topic?.includes(`11eNexus:${game.id}`),
            );
            if (matches.length === 1) game.channelId = matches[0]!.id;
          }
        }
        if (game.state !== 'active' && !creation) continue;
        // A recent established human message proves archival cannot be due.
        // Provisional and recovered creations still need their human-history check.
        this.mergeActivity(game);
        const needsHistory =
          game.awaitingActivity ||
          archiveCandidates([{ ...game, state: 'active' }], this.now(), 0).length > 0;
        let activity: Activity = { at: game.lastActivityAt, complete: true },
          failed = false;
        if (needsHistory) {
          try {
            activity = await this.community.activity(game, this.now() - 30 * DAY, signal);
          } catch {
            signal?.throwIfAborted();
            activity = { at: null, complete: false };
            failed = true;
          }
        }
        activities.set(game.id, {
          channelId: game.channelId,
          activatedAt: game.activatedAt,
          activity,
          historyRead: needsHistory,
          failed,
        });
      }
      // Observe resources after the potentially long histories, so manual moves and
      // subscription changes during the scan win over our earlier catalogue view.
      signal?.throwIfAborted();
      const revision = this.mutex.revision;
      let world = await this.community.snapshot(signal);
      if (!world.complete) throw new DomainError('incomplete');
      signal?.throwIfAborted();
      return this.mutex.run(async () => {
        signal?.throwIfAborted();
        if (admin) admin = await this.authorize(admin, true);
        // A mutation completed during the inventory or lock wait: refresh once
        // under the lock rather than overwrite its newer role observation.
        if (revision !== this.mutex.revision) world = await this.community.snapshot(signal);
        if (!world.complete) throw new DomainError('incomplete');
        await guard?.({ world, activities });
        const adoption = this.repository.get<{ status: string }>('archiveAdoption');
        if (adoption && adoption.status !== 'completed') throw new DomainError('needsReview');
        // Recover resources created just before a crash, but do not recreate deleted resources.
        for (const op of this.repository
          .operations()
          .filter((o) => o.status === 'pending' || o.status === 'review')) {
          await this.scheduler.yield();
          const game = this.repository.game(op.gameId);
          if (!game) continue;
          if (op.kind === 'create') {
            const channels = world.channels.filter((c) => c.topic?.includes(`11eNexus:${game.id}`));
            if (!game.channelId && channels.length === 1) game.channelId = channels[0]!.id;
          }
          if (
            (op.kind === 'create' ||
              op.kind === 'activate' ||
              (op.kind === 'import' && op.data.createRole === true)) &&
            !world.roles.some((r) => r.id === game.roleId)
          ) {
            const baseline = Array.isArray(op.data.previousRoleIds) ? op.data.previousRoleIds : [];
            const roles = world.roles.filter(
              (r) =>
                !baseline.includes(r.id) &&
                !r.managed &&
                r.permissions === '0' &&
                r.name === op.data.roleName &&
                r.editable,
            );
            if (roles.length === 1) {
              game.roleId = roles[0]!.id;
              game.roleState = 'present';
            }
          }
          this.repository.saveGame(game);
          const channel = world.channels.find((c) => c.id === game.channelId);
          const role = world.roles.find((r) => r.id === game.roleId);
          // A recorded failure can leave permissions half-applied even when the parent looks correct.
          // Only an explicit repair releases that game; mere observations cannot prove ACL completion.
          if (op.status === 'review' && op.kind !== 'recycle') {
            game.blocked = true;
            this.repository.saveGame(game);
            continue;
          }
          const complete =
            op.kind === 'create'
              ? Boolean(channel?.parentId === this.policy.activeCategoryId && role)
              : op.kind === 'archive'
                ? Boolean(channel?.parentId && world.archiveCategoryIds.includes(channel.parentId))
                : op.kind === 'import' || op.kind === 'activate'
                  ? false
                  : !role;
          if (complete) {
            this.repository.transaction(() => {
              if (op.kind === 'create') {
                game.state = 'active';
                game.activatedAt = op.startedAt;
                game.addedAt ??= op.startedAt;
                game.awaitingActivity = true;
                this.repository.saveGame(game);
                if (op.data.announceNewGame === true) this.queueNewGameAnnouncement(game);
              }
              this.finish(op, 'completed');
              if (op.actorId && op.data.administrative !== true)
                this.repository.setCooldown(
                  op.actorId,
                  Math.max(this.repository.cooldown(op.actorId) || 0, op.startedAt),
                );
            });
          } else {
            this.finish(op, 'review', op.error || 'interrupted');
            game.blocked = true;
            this.repository.saveGame(game);
          }
        }
        const trusted = new Set<string>();
        const activityAlerts: Game[] = [];
        await this.scheduler.yield();
        // One atomic commit for observed data. Otherwise every unchanged game
        // incurs a separate synchronous disk commit while interactions wait.
        this.repository.transaction(() => {
          for (const game of this.repository.games()) {
            const channel = world.channels.find((c) => c.id === game.channelId);
            if (!channel) {
              game.state = 'unavailable';
              this.repository.saveGame(game);
              continue;
            }
            const before = game.state;
            if (channel.parentId === this.policy.activeCategoryId) game.state = 'active';
            else if (channel.parentId && world.archiveCategoryIds.includes(channel.parentId))
              game.state = 'archived';
            else game.state = 'unavailable';
            if (game.state === 'active' && before !== 'active') {
              game.activatedAt = this.now();
              game.awaitingActivity = true;
            }
            const role = world.roles.find((r) => r.id === game.roleId);
            if (role) {
              game.roleState = 'present';
              this.repository.replaceSubscribers(
                game.id,
                role.members.filter((id) => world.memberIds.includes(id)),
              );
            } else if (game.roleState !== 'recycled') {
              game.roleState = 'missing';
              this.repository.replaceSubscribers(game.id, []);
            } else
              for (const id of this.repository.subscribers(game.id))
                if (!world.memberIds.includes(id)) this.repository.subscribe(game.id, id, false);
            if (game.state === 'active') {
              const observation = activities.get(game.id);
              if (
                observation?.channelId === game.channelId &&
                observation.activatedAt === game.activatedAt
              ) {
                this.mergeActivity(game, observation.activity);
                if (observation.activity.complete && observation.historyRead) trusted.add(game.id);
                if (observation.failed) activityAlerts.push(game);
              } else this.mergeActivity(game);
            }
            this.repository.saveGame(game);
          }
          this.repository.set('lastReconciliation', { at: this.now(), rotation: rotate });
        });
        for (const game of activityAlerts)
          await this.community.alert(`activity:${game.id}`, 'activityUnavailable', {
            game: game.name,
          });
        if (admin)
          this.repository.audit(
            rotate ? 'admin-rotation' : 'admin-reconciliation',
            admin.id,
            'guild',
            this.now(),
          );
        if (!rotate) return;
        for (const game of archiveCandidates(
          this.repository.games().map((g) => {
            this.mergeActivity(g);
            return g;
          }),
          this.now(),
          this.policy.minActive,
        ).filter((g) => trusted.has(g.id) && (!archiveIds || archiveIds.includes(g.id)))) {
          const op = this.operation('archive', game, null);
          try {
            await this.community.move(game, true, op.id, () => {
              const games = this.repository.games().map((g) => {
                this.mergeActivity(g);
                return g;
              });
              return archiveCandidates(games, this.now(), this.policy.minActive).some(
                (g) => g.id === game.id,
              );
            });
            this.mergeActivity(game);
            game.state = 'archived';
            this.repository.saveGame(game);
            this.finish(op, 'completed');
            this.repository.audit('archive', null, game.id, this.now());
          } catch (error) {
            if (error instanceof DomainError && error.code === 'activityChanged') {
              this.mergeActivity(game);
              this.repository.saveGame(game);
              this.finish(op, 'failed', 'activityChanged');
              continue;
            }
            game.blocked = true;
            this.repository.saveGame(game);
            this.finish(op, 'review', 'capacity');
            await this.community.alert(`archive:${game.id}`, 'capacityAlert', { game: game.name });
          }
        }
      });
    });
  }
}
