import { randomUUID } from 'node:crypto';
import {
  archiveCandidates,
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
} from './ports.js';

// Guards run inside the same application mutex as the mutation.
export type MutationGuard = () => Promise<void>;
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
}
export class Nexus {
  readonly mutex = new Mutex();
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
        .some(
          (o) =>
            o.actorId === actorId &&
            (o.status === 'pending' || (o.status === 'review' && o.startedAt + DAY > this.now())),
        )
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
  async create(actor: Actor, rawgId: number, guard?: MutationGuard): Promise<Game> {
    requireMember(actor);
    return this.mutex.run(async () => {
      await guard?.();
      const existing = this.repository.byRawg(rawgId);
      if (existing) {
        if (existing.retired) throw new DomainError('blocked');
        if (existing.blocked || existing.state === 'unavailable')
          throw new DomainError('partial', { game: existing.name });
        return existing;
      }
      if (!actor.admin) this.quota(actor.id);
      const candidate = await this.catalogue.get(rawgId);
      const asset = await this.catalogue.image(candidate);
      if (!asset) throw new DomainError('needsReview');
      return this.createInternal(actor, candidate.name, rawgId, candidate.url, asset);
    });
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
    });
    try {
      game.channelId = await this.community.createChannel(game, op.id);
      this.repository.saveGame(game);
      game.roleId = await this.community.createRole(game, asset, op.id);
      game.roleState = 'present';
      this.repository.saveGame(game);
      game.state = 'active';
      game.activatedAt = this.now();
      this.repository.saveGame(game);
      if (!actor.admin) this.repository.setCooldown(actor.id, this.now());
      this.finish(op, 'completed');
      this.repository.audit('create', actor.id, game.id, this.now());
      return game;
    } catch (error) {
      game.blocked = true;
      this.repository.saveGame(game);
      this.finish(op, 'review', error instanceof DomainError ? error.code : 'discordError');
      await this.community.alert(`partial:${op.id}`, 'partial', { game: game.name });
      throw new DomainError('partial', { game: game.name });
    }
  }
  async activate(actor: Actor, id: string, guard?: MutationGuard): Promise<Game> {
    requireMember(actor);
    return this.mutex.run(async () => {
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
  async subscribe(actor: Actor, id: string, enabled: boolean): Promise<boolean> {
    requireMember(actor);
    return this.mutex.run(async () => {
      const game = this.game(id);
      this.requireSettled(id);
      if (game.blocked) throw new DomainError('blocked');
      if (game.roleState === 'recycled') {
        this.repository.subscribe(id, actor.id, enabled);
        return enabled;
      }
      if (game.roleState !== 'present' || !game.roleId) throw new DomainError('needsReview');
      await this.community.setSubscription(game.roleId, actor.id, enabled);
      const actual = await this.community.subscription(game.roleId, actor.id);
      this.repository.subscribe(id, actor.id, actual);
      if (actual !== enabled) throw new DomainError('discordError');
      return actual;
    });
  }
  validateIdentity(name: string, url: string): string {
    if (!name.trim() || name.length > 100 || url.length > 500)
      throw new DomainError('invalidInput');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DomainError('invalidInput');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hostname === 'localhost' ||
      !parsed.hostname.includes('.') ||
      /^[\d.]+$/.test(parsed.hostname)
    )
      throw new DomainError('invalidInput');
    return parsed.href;
  }
  async propose(actor: Actor, name: string, url: string, locale: Locale): Promise<Proposal> {
    requireMember(actor);
    return this.mutex.run(async () => {
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
      if (this.repository.proposals(actor.id).some((p) => p.createdAt + DAY > this.now()))
        throw new DomainError('proposalCooldown');
      if (
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
      this.repository.saveProposal(proposal);
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
      this.repository.saveProposal(proposal);
      this.repository.audit('approve', admin.id, proposal.id, this.now());
      return game;
    });
  }
  async reject(admin: Actor, id: string, reason: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
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
      this.repository.saveProposal(proposal);
      this.repository.audit('reject', admin.id, id, this.now());
    });
  }
  async clarify(admin: Actor, id: string, reason: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
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
      this.repository.saveProposal(p);
      this.repository.audit('clarify', admin.id, id, this.now());
    });
  }
  async amendProposal(actor: Actor, id: string, name: string, url: string): Promise<Proposal> {
    requireMember(actor);
    return this.mutex.run(async () => {
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
      this.repository.saveProposal(p);
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
      await guard?.();
      const game = this.game(id);
      const world = await this.community.snapshot();
      if (!world.complete) throw new DomainError('incomplete');
      const channel = world.channels.find((c) => c.id === channelId);
      const role = world.roles.find((r) => r.id === roleId);
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
        .filter((o) => o.gameId === id && (o.status === 'pending' || o.status === 'review')))
        this.finish(op, 'completed');
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
    return this.mutex.run(async () => {
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
        this.repository.saveProposal(p);
        this.repository.audit('approve', admin.id, p.id, this.now());
      }
      return game;
    });
  }
  async attachProposal(
    admin: Actor,
    proposalId: string,
    gameId: string,
    guard?: MutationGuard,
  ): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
      await guard?.();
      const p = this.repository.proposal(proposalId);
      const game = this.game(gameId);
      if (!p || !['pending', 'needs_info'].includes(p.status)) throw new DomainError('staleAction');
      this.requireSettled(gameId);
      if (game.blocked) throw new DomainError('blocked');
      p.status = 'accepted';
      p.gameId = gameId;
      p.reason = null;
      this.repository.saveProposal(p);
      this.repository.audit('attach-proposal', admin.id, p.id, this.now());
    });
  }
  async archive(admin: Actor, id: string, guard?: MutationGuard): Promise<void> {
    requireAdmin(admin);
    await this.mutex.run(async () => {
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
    await this.mutex.run(async () => {
      const game = this.repository.games().find((g) => g.channelId === channelId);
      if (!game) return;
      if (at > (game.lastActivityAt ?? 0)) game.lastActivityAt = at;
      if (at >= game.activatedAt) game.awaitingActivity = false;
      this.repository.saveGame(game);
    });
  }
  async synchronize(rotate = true, guard?: MutationGuard, admin?: Actor): Promise<void> {
    return this.mutex.run(async () => {
      if (admin) requireAdmin(admin);
      await guard?.();
      const adoption = this.repository.get<{ status: string }>('archiveAdoption');
      if (adoption && adoption.status !== 'completed') throw new DomainError('needsReview');
      const world = await this.community.snapshot();
      if (!world.complete) throw new DomainError('incomplete');
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
          if (op.kind === 'create') {
            game.state = 'active';
            game.activatedAt = op.startedAt;
            game.awaitingActivity = true;
            this.repository.saveGame(game);
          }
          this.finish(op, 'completed');
          if (op.actorId && op.data.administrative !== true)
            this.repository.setCooldown(
              op.actorId,
              Math.max(this.repository.cooldown(op.actorId) || 0, op.startedAt),
            );
        } else {
          this.finish(op, 'review', op.error || 'interrupted');
          game.blocked = true;
          this.repository.saveGame(game);
        }
      }
      const trusted = new Set<string>();
      for (const game of this.repository.games()) {
        // Let Gateway interaction callbacks run between background reconciliation items.
        await this.scheduler.yield();
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
          try {
            const observation = await this.community.activity(game, this.now() - 30 * DAY);
            if (observation.at && observation.at > (game.lastActivityAt ?? 0))
              game.lastActivityAt = observation.at;
            if (observation.at && observation.at >= game.activatedAt) game.awaitingActivity = false;
            if (observation.complete) trusted.add(game.id);
          } catch {
            await this.community.alert(`activity:${game.id}`, 'activityUnavailable', {
              game: game.name,
            });
          }
        }
        this.repository.saveGame(game);
      }
      this.repository.set('lastReconciliation', { at: this.now(), rotation: rotate });
      if (admin)
        this.repository.audit(
          rotate ? 'admin-rotation' : 'admin-reconciliation',
          admin.id,
          'guild',
          this.now(),
        );
      if (!rotate) return;
      for (const game of archiveCandidates(
        this.repository.games(),
        this.now(),
        this.policy.minActive,
      ).filter((g) => trusted.has(g.id))) {
        const op = this.operation('archive', game, null);
        try {
          await this.community.move(game, true, op.id);
          game.state = 'archived';
          this.repository.saveGame(game);
          this.finish(op, 'completed');
          this.repository.audit('archive', null, game.id, this.now());
        } catch {
          game.blocked = true;
          this.repository.saveGame(game);
          this.finish(op, 'review', 'capacity');
          await this.community.alert(`archive:${game.id}`, 'capacityAlert', { game: game.name });
        }
      }
    });
  }
}
