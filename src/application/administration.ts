import { createHash, randomUUID } from 'node:crypto';
import {
  archiveCandidates,
  channelName,
  normalize,
  DAY,
  DomainError,
  requireAdmin,
  type Actor,
  type Game,
} from '../domain/model.js';
import type { Nexus, PreparedGame, ReconciliationObservation } from './nexus.js';
import { auditResources, type ResourceAudit } from './resource-audit.js';
import type { Scheduler, World } from './ports.js';

export const fingerprint = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
export function entityVersion(
  value: Game | import('../domain/model.js').Proposal | undefined,
): string {
  if (value && 'lastActivityAt' in value) {
    const {
      lastActivityAt: _activity,
      activatedAt: _activated,
      awaitingActivity: _awaiting,
      ...stable
    } = value;
    return fingerprint(stable);
  }
  return fingerprint(value);
}
export type AdminAction =
  | { kind: 'activate' | 'archive' | 'block' | 'unblock' | 'retire'; gameId: string }
  | { kind: 'edit'; gameId: string; name: string; aliases: string[]; align: boolean }
  | { kind: 'repair'; gameId: string; channelId: string; roleId: string }
  | { kind: 'reject' | 'clarify'; proposalId: string; reason: string }
  | { kind: 'attach'; proposalId: string; gameId: string }
  | { kind: 'create'; input: PreparedGame; proposalId?: string }
  | { kind: 'reconcile' | 'rotate' }
  | { kind: 'panel'; target: 'member' | 'staff'; channelId: string; permissions: string };
export interface AdminPlan {
  id: string;
  actorId: string;
  action: AdminAction;
  revision: string;
  world: string;
  expiresAt: number;
  maintenance?: string;
  archiveIds?: string[];
}
export interface MaintenancePreview {
  revision: string;
  world: string;
  signature: string;
  changes: { name: string; kind: string; count?: number }[];
  candidates: string[];
  unverified: string[];
  report: ResourceAudit;
}
export interface MaintenanceProgress {
  phase: 'waiting' | 'resources' | 'activity';
  current: number;
  total: number;
}
export class Administration {
  constructor(
    readonly nexus: Nexus,
    private readonly now = () => Date.now(),
    private readonly guildId = '',
    private readonly scheduler: Scheduler = { yield: async () => {} },
  ) {}
  private needsWorld(action?: AdminAction): boolean {
    return (
      !action ||
      ['create', 'activate', 'archive', 'repair', 'reconcile', 'rotate'].includes(action.kind) ||
      (action.kind === 'edit' && action.align)
    );
  }
  private async world(action?: AdminAction): Promise<World> {
    if (this.needsWorld(action)) return this.nexus.community.snapshot();
    return {
      complete: true,
      roleIcons: false,
      archiveCategoryIds: [],
      channels: [],
      roles: [],
      memberIds: [],
    };
  }
  private worldVersion(world: World, action?: AdminAction): string {
    if (!this.needsWorld(action)) return fingerprint(null);
    const global = !action || action.kind === 'reconcile' || action.kind === 'rotate';
    const game =
      action && 'gameId' in action ? this.nexus.repository.game(action.gameId) : undefined;
    const channelIds = [game?.channelId, action?.kind === 'repair' ? action.channelId : undefined];
    const roleIds = [game?.roleId, action?.kind === 'repair' ? action.roleId : undefined];
    const capacity =
      action?.kind === 'create' || action?.kind === 'activate' || action?.kind === 'archive';
    return fingerprint({
      complete: world.complete,
      roleIcons: capacity ? world.roleIcons : undefined,
      archives:
        global || capacity || action?.kind === 'repair'
          ? [...world.archiveCategoryIds].sort()
          : undefined,
      channelCount: capacity ? world.channels.length : undefined,
      roleCount: capacity ? world.roles.length : undefined,
      channels: world.channels
        .filter(
          (c) =>
            global ||
            channelIds.includes(c.id) ||
            (capacity &&
              (c.id === this.nexus.policy.activeCategoryId ||
                c.parentId === this.nexus.policy.activeCategoryId ||
                world.archiveCategoryIds.includes(c.id) ||
                world.archiveCategoryIds.includes(c.parentId || ''))) ||
            (action?.kind === 'edit' &&
              (c.name === action.name || c.name === channelName(action.name))),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      roles: world.roles
        .filter(
          (r) =>
            global || roleIds.includes(r.id) || (action?.kind === 'edit' && r.name === action.name),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ members: _members, ...role }) => ({
          ...role,
          references: [...role.references].sort(),
        })),
    });
  }
  revision(action?: AdminAction): string {
    const repo = this.nexus.repository;
    const global = !action || action.kind === 'reconcile' || action.kind === 'rotate';
    const games =
      action && 'gameId' in action
        ? [repo.game(action.gameId)]
        : global || action?.kind === 'create'
          ? repo.games(true)
          : [];
    const proposals =
      action && 'proposalId' in action && action.proposalId
        ? [repo.proposal(action.proposalId)]
        : [];
    return fingerprint({
      games: global ? games.map((g) => g && this.nexus.observedGame(g)) : games.map(entityVersion),
      proposals,
      panels: action?.kind === 'panel' ? [repo.get('panel'), repo.get('adminPanel')] : undefined,
      operations: repo
        .operations()
        .filter(
          (o) =>
            ['pending', 'review'].includes(o.status) &&
            (global ||
              action?.kind === 'create' ||
              (action && 'gameId' in action && o.gameId === action.gameId)),
        ),
    });
  }
  async plan(actor: Actor, action: AdminAction, preview?: MaintenancePreview): Promise<AdminPlan> {
    requireAdmin(actor);
    return this.nexus.mutex.run(async () => {
      const world = await this.world(action);
      if (!world.complete) throw new DomainError('incomplete');
      if (
        (action.kind === 'reject' || action.kind === 'clarify') &&
        (!action.reason.trim() || action.reason.length > 500)
      )
        throw new DomainError('invalidInput');
      if (action.kind === 'create') {
        action.input.url = this.nexus.validateIdentity(action.input.name, action.input.url);
        if (!this.nexus.repository.asset(action.input.assetId))
          throw new DomainError('invalidImage');
        if (
          action.input.rawgId !== null &&
          (!Number.isSafeInteger(action.input.rawgId) || action.input.rawgId <= 0)
        )
          throw new DomainError('invalidInput');
        if (
          this.nexus.repository
            .games(true)
            .some(
              (g) =>
                (g.rawgId !== null && g.rawgId === action.input.rawgId) ||
                normalize(g.name) === normalize(action.input.name),
            )
        )
          throw new DomainError('duplicateGame');
        if (!world.roleIcons) throw new DomainError('iconsUnavailable');
        if (
          this.nexus.repository.games().length >= this.nexus.policy.maxGames ||
          world.channels.filter((c) => c.parentId === this.nexus.policy.activeCategoryId).length >=
            50 ||
          world.channels.length >= 500
        )
          throw new DomainError('capacity');
      }
      if (
        action.kind === 'edit' &&
        (!action.name.trim() ||
          action.name.length > 100 ||
          action.aliases.length > 20 ||
          action.aliases.some((a) => !a.trim() || a.length > 100))
      )
        throw new DomainError('invalidInput');
      if (action.kind === 'repair') {
        const channel = world.channels.find((c) => c.id === action.channelId),
          role = world.roles.find((r) => r.id === action.roleId);
        this.nexus.assertRepairResources(
          action.channelId,
          action.roleId,
          role?.name,
          channel?.topic,
        );
        if (!channel || ![0, 5, 15, 16].includes(channel.type) || !role)
          throw new DomainError('invalidInput');
        if (role.permissions !== '0') throw new DomainError('repairRolePermissions');
        if (role.references.some((reference) => reference !== action.channelId))
          throw new DomainError('repairRoleReferences');
        if (role.managed || !role.editable) throw new DomainError('repairHierarchy');
        if (channel.editable === false) throw new DomainError('repairChannelPermission');
        if (
          channel.parentId !== this.nexus.policy.activeCategoryId &&
          !world.archiveCategoryIds.includes(channel.parentId || '')
        )
          throw new DomainError('repairChannelScope');
        if (
          this.nexus.repository
            .games(true)
            .some(
              (g) =>
                g.id !== action.gameId &&
                (g.channelId === action.channelId || g.roleId === action.roleId),
            )
        )
          throw new DomainError('repairConflict');
      }
      if (action.kind === 'activate' || action.kind === 'archive') {
        const game = this.nexus.repository.game(action.gameId);
        const channel = world.channels.find((c) => c.id === game?.channelId);
        if (
          !game ||
          game.retired ||
          game.blocked ||
          !channel ||
          channel.editable === false ||
          (channel.parentId !== this.nexus.policy.activeCategoryId &&
            !world.archiveCategoryIds.includes(channel.parentId || ''))
        )
          throw new DomainError('needsReview');
        if ((game.state === 'active') !== (channel.parentId === this.nexus.policy.activeCategoryId))
          throw new DomainError('staleAction');
        if (
          action.kind === 'activate' &&
          game.roleState === 'present' &&
          !world.roles.some((r) => r.id === game.roleId)
        )
          throw new DomainError('needsReview');
      }
      const revision = this.revision(action);
      const version = this.worldVersion(world, action);
      if (preview && (preview.revision !== revision || preview.world !== version))
        throw new DomainError('staleAction');
      return {
        id: randomUUID(),
        actorId: actor.id,
        action,
        revision,
        world: version,
        expiresAt: this.now() + 5 * 60000,
        maintenance: preview?.signature,
        archiveIds: action.kind === 'rotate' ? preview?.candidates : undefined,
      };
    });
  }
  async inspect(
    actor: Actor,
    progress?: (value: MaintenanceProgress) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<MaintenancePreview> {
    requireAdmin(actor);
    signal?.throwIfAborted();
    await progress?.({ phase: 'waiting', current: 0, total: 0 });
    signal?.throwIfAborted();
    return this.inspectInternal(progress, signal);
  }
  private async inspectInternal(
    progress?: (value: MaintenanceProgress) => Promise<void>,
    signal?: AbortSignal,
    observation?: ReconciliationObservation,
  ): Promise<MaintenancePreview> {
    signal?.throwIfAborted();
    await progress?.({ phase: 'resources', current: 0, total: 0 });
    signal?.throwIfAborted();
    const { nexus } = this;
    const repo = nexus.repository;
    const revision = this.revision();
    const world = observation?.world || (await nexus.community.snapshot(signal));
    signal?.throwIfAborted();
    if (!world.complete) throw new DomainError('incomplete');
    const changes: MaintenancePreview['changes'] = [];
    const trusted = new Set<string>();
    const unverified: string[] = [];
    const games: Game[] = [];
    const catalogue = repo.games();
    await progress?.({ phase: 'activity', current: 0, total: catalogue.length });
    let checked = 0;
    for (const current of catalogue) {
      signal?.throwIfAborted();
      if (!observation) await this.scheduler.yield();
      signal?.throwIfAborted();
      const game = nexus.observedGame(current);
      if (
        repo
          .operations()
          .some((o) => o.gameId === game.id && ['pending', 'review'].includes(o.status))
      )
        game.blocked = true;
      const channel = world.channels.find((c) => c.id === game.channelId);
      const role = world.roles.find((r) => r.id === game.roleId);
      if (!channel) {
        game.state = 'unavailable';
        changes.push({ name: game.name, kind: 'unavailable' });
        games.push(game);
        await progress?.({ phase: 'activity', current: ++checked, total: catalogue.length });
        continue;
      }
      game.state =
        channel?.parentId === nexus.policy.activeCategoryId
          ? 'active'
          : channel?.parentId && world.archiveCategoryIds.includes(channel.parentId)
            ? 'archived'
            : 'unavailable';
      if (game.state !== current.state) changes.push({ name: game.name, kind: game.state });
      if (game.state === 'active' && current.state !== 'active') {
        game.awaitingActivity = true;
        game.activatedAt = this.now();
      }
      if (!role && game.roleState !== 'recycled') {
        game.roleState = 'missing';
        changes.push({ name: game.name, kind: 'missingRole' });
      }
      if (role) {
        game.roleState = 'present';
        const observed = [
          ...new Set(role.members.filter((id) => world.memberIds.includes(id))),
        ].sort();
        if (fingerprint(observed) !== fingerprint(repo.subscribers(game.id).sort()))
          changes.push({ name: game.name, kind: 'subscriptions', count: observed.length });
      }
      if (game.state === 'active') {
        const scanned = observation?.activities.get(game.id);
        const needsHistory =
          game.awaitingActivity || archiveCandidates([game], this.now(), 0).length > 0;
        // A manually moved game gets a new activation grace period; old history
        // cannot validate activity after that activation or make it expire now.
        const activity =
          current.state !== 'active'
            ? { at: game.lastActivityAt, complete: true }
            : observation
              ? scanned?.channelId === game.channelId && scanned.activatedAt === game.activatedAt
                ? scanned.activity
                : { at: null, complete: false }
              : needsHistory
                ? await nexus.community
                    .activity(game, this.now() - 30 * DAY, signal)
                    .catch(() => ({ at: null, complete: false }))
                : { at: game.lastActivityAt, complete: true };
        if (activity.at && activity.at > (game.lastActivityAt ?? 0))
          game.lastActivityAt = activity.at;
        if (activity.at && activity.at >= game.activatedAt) game.awaitingActivity = false;
        if (
          activity.complete &&
          (observation ? scanned?.historyRead : current.state === 'active' && needsHistory)
        )
          trusted.add(game.id);
        if (!activity.complete) unverified.push(game.name);
      }
      if (
        game.lastActivityAt !== current.lastActivityAt ||
        game.awaitingActivity !== current.awaitingActivity
      )
        changes.push({ name: game.name, kind: 'activity' });
      games.push(game);
      signal?.throwIfAborted();
      await progress?.({ phase: 'activity', current: ++checked, total: catalogue.length });
    }
    const candidates = archiveCandidates(games, this.now(), nexus.policy.minActive)
      .filter((g) => trusted.has(g.id))
      .map((g) => g.id)
      .sort();
    const report = auditResources(repo.games(true), repo.operations(), world, {
      guildId: this.guildId,
      activeCategoryId: nexus.policy.activeCategoryId,
      categoryIds: [
        nexus.policy.activeCategoryId,
        ...world.archiveCategoryIds,
        ...Object.values(repo.get<Record<string, string | null>>('eventCategories') || {}).filter(
          (id): id is string => typeof id === 'string',
        ),
      ],
      events: repo.events(),
    });
    if (revision !== this.revision()) throw new DomainError('staleAction');
    const version = this.worldVersion(world);
    return {
      revision,
      world: version,
      signature: fingerprint({ changes, candidates, unverified }),
      changes,
      candidates,
      unverified,
      report,
    };
  }
  async consume(
    actor: Actor,
    plan: AdminPlan,
    observation?: ReconciliationObservation,
  ): Promise<void> {
    requireAdmin(actor);
    const repo = this.nexus.repository;
    if (
      plan.actorId !== actor.id ||
      plan.expiresAt <= this.now() ||
      repo.get(`admin-action:${plan.id}`)
    )
      throw new DomainError('staleAction');
    if (this.revision(plan.action) !== plan.revision) throw new DomainError('staleAction');
    const world = observation?.world || (await this.world(plan.action));
    if (!world.complete || this.worldVersion(world, plan.action) !== plan.world)
      throw new DomainError('staleAction');
    if (
      plan.maintenance &&
      (!observation ||
        (await this.inspectInternal(undefined, undefined, observation)).signature !==
          plan.maintenance)
    )
      throw new DomainError('staleAction');
    repo.set(`admin-action:${plan.id}`, {
      actorId: actor.id,
      at: this.now(),
      expiresAt: this.now() + DAY,
    });
  }
  async execute(actor: Actor, plan: AdminPlan, requester?: Actor): Promise<void> {
    requireAdmin(actor);
    const action = plan.action;
    const guard = (observation?: ReconciliationObservation) =>
      this.consume(actor, plan, observation);
    const nexus = this.nexus;
    if (action.kind === 'activate') await nexus.activate(actor, action.gameId, guard);
    else if (action.kind === 'archive') await nexus.archive(actor, action.gameId, guard);
    else if (action.kind === 'block' || action.kind === 'unblock')
      await nexus.block(actor, action.gameId, action.kind === 'block', guard);
    else if (action.kind === 'retire') await nexus.retire(actor, action.gameId, guard);
    else if (action.kind === 'edit')
      await nexus.edit(actor, action.gameId, action.name, action.aliases, action.align, guard);
    else if (action.kind === 'repair')
      await nexus.repair(actor, action.gameId, action.channelId, action.roleId, guard);
    else if (action.kind === 'reject')
      await nexus.reject(actor, action.proposalId, action.reason, guard);
    else if (action.kind === 'clarify')
      await nexus.clarify(actor, action.proposalId, action.reason, guard);
    else if (action.kind === 'attach')
      await nexus.attachProposal(actor, action.proposalId, action.gameId, guard);
    else if (action.kind === 'create')
      await nexus.addByAdmin(actor, action.input, guard, action.proposalId, requester);
    else if (action.kind === 'reconcile' || action.kind === 'rotate')
      await nexus.synchronize(action.kind === 'rotate', guard, actor, plan.archiveIds);
    else throw new DomainError('invalidInput');
  }
}
