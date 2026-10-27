import { createHash, randomUUID } from 'node:crypto';
import { DomainError, normalize, type Asset, type Game, type Operation } from '../domain/model.js';
import type { Community, Repository, World } from './ports.js';

export interface ImportEntry {
  confirmed: true;
  name: string;
  channelId: string;
  roleId: string;
  state: 'active' | 'archived';
  rawgId?: number;
  aliases?: string[];
}
export interface Manifest {
  version: 1;
  entries: ImportEntry[];
  removeGameOptions: boolean;
}
export interface ImportPlan {
  version: 1;
  manifest: Manifest;
  fingerprint: string;
  games: Game[];
  changes: string[];
  errors: string[];
  digest: string;
}
export interface MigrationCommunity extends Community {
  prepareImportedRole(id: string): Promise<void>;
  importRoleAsset(id: string): Promise<Asset | null>;
  removeGameOptions(roles: string[], channels: string[]): Promise<void>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fingerprint(world: World): string {
  return hash({
    channels: [...world.channels].sort((a, b) => a.id.localeCompare(b.id)),
    roles: world.roles
      .map(({ members: _members, ...r }) => r)
      .sort((a, b) => a.id.localeCompare(b.id)),
    archives: world.archiveCategoryIds,
  });
}
export function parseManifest(value: unknown): Manifest {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('entries' in value) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 150
  )
    throw new DomainError('invalidInput');
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.confirmed !== true ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      entry.name.length > 100 ||
      !/^\d{17,20}$/.test(String(entry.channelId)) ||
      !/^\d{17,20}$/.test(String(entry.roleId)) ||
      !['active', 'archived'].includes(entry.state) ||
      (entry.rawgId !== undefined && (!Number.isSafeInteger(entry.rawgId) || entry.rawgId < 1)) ||
      (entry.aliases !== undefined &&
        (!Array.isArray(entry.aliases) ||
          entry.aliases.length > 20 ||
          entry.aliases.some((a: unknown) => typeof a !== 'string' || a.length > 100)))
    )
      throw new DomainError('invalidInput');
  }
  return {
    version: 1,
    entries: value.entries as ImportEntry[],
    removeGameOptions: 'removeGameOptions' in value && value.removeGameOptions === true,
  };
}
export function buildPlan(
  manifest: Manifest,
  world: World,
  repository: Repository,
  maxGames: number,
  activeCategoryId: string,
  maxArchives = 3,
): ImportPlan {
  const errors: string[] = [];
  const changes: string[] = [];
  const games: Game[] = [];
  const seenChannels = new Set<string>();
  const seenRoles = new Set<string>();
  const seenRawg = new Set<number>();
  const names = new Set<string>();
  if (!world.complete) errors.push('Incomplete Discord snapshot');
  for (const entry of manifest.entries) {
    const channel = world.channels.find((c) => c.id === entry.channelId);
    const role = world.roles.find((r) => r.id === entry.roleId);
    if (!channel || ![0, 5, 15, 16].includes(channel.type))
      errors.push(`${entry.name}: main textual channel not found`);
    if (!role || role.managed || !role.editable || role.permissions !== '0')
      errors.push(
        `${entry.name}: role must be ordinary, below the bot and have zero global permissions`,
      );
    if (seenChannels.has(entry.channelId) || seenRoles.has(entry.roleId))
      errors.push(`${entry.name}: a channel or role is used twice`);
    if (entry.rawgId && seenRawg.has(entry.rawgId))
      errors.push(`${entry.name}: duplicate RAWG identity`);
    if (names.has(normalize(entry.name))) errors.push(`${entry.name}: duplicate canonical name`);
    seenChannels.add(entry.channelId);
    seenRoles.add(entry.roleId);
    if (entry.rawgId) seenRawg.add(entry.rawgId);
    names.add(normalize(entry.name));
    const existing = repository.games(true).find((g) => g.channelId === entry.channelId);
    const rawgOwner = entry.rawgId ? repository.byRawg(entry.rawgId) : undefined;
    const roleOwner = repository.games(true).find((g) => g.roleId === entry.roleId);
    if (
      (rawgOwner && rawgOwner.id !== existing?.id) ||
      (roleOwner && roleOwner.id !== existing?.id)
    )
      errors.push(`${entry.name}: identity already belongs to another game`);
    const game: Game = {
      id: existing?.id || randomUUID(),
      name: entry.name,
      rawgId: entry.rawgId || null,
      aliases: entry.aliases || [],
      channelId: entry.channelId,
      roleId: entry.roleId,
      state: entry.state,
      roleState: 'present',
      lastActivityAt: existing?.lastActivityAt || null,
      activatedAt: existing?.activatedAt || Date.now(),
      awaitingActivity: false,
      assetId: existing?.assetId || null,
      canRecycle: false,
      blocked: false,
      retired: false,
      externalUrl: entry.rawgId ? `https://rawg.io/games/${entry.rawgId}` : null,
    };
    games.push(game);
    changes.push(
      `${entry.name}: import current role holders; keep channel ${entry.channelId}; normalize Syndiqué visibility; target ${entry.state}; disable unrestricted role mentions; legacy role recycling disabled`,
    );
  }
  const projectedIds = new Set([...repository.games().map((g) => g.id), ...games.map((g) => g.id)]);
  if (projectedIds.size > maxGames) errors.push('Catalogue capacity exceeded');
  const leaving = new Set(games.filter((g) => g.state === 'archived').map((g) => g.channelId));
  const currentActive = world.channels.filter(
    (c) => c.parentId === activeCategoryId && !leaving.has(c.id),
  ).length;
  const incoming = games.filter(
    (g) =>
      g.state === 'active' &&
      world.channels.find((c) => c.id === g.channelId)?.parentId !== activeCategoryId,
  ).length;
  if (currentActive + incoming > 50) errors.push('Active category capacity exceeded');
  const archiving = games.filter((g) => g.state === 'archived');
  const leavingArchives = new Set(
    games.filter((g) => g.state === 'active').map((g) => g.channelId),
  );
  const alreadyArchived = world.channels.filter(
    (c) => world.archiveCategoryIds.includes(c.parentId || '') && !leavingArchives.has(c.id),
  );
  const archiveTotal =
    alreadyArchived.length +
    archiving.filter((g) => !alreadyArchived.some((c) => c.id === g.channelId)).length;
  if (archiveTotal > maxArchives * 50) errors.push('Archive capacity exceeded');
  const newCategories = Math.max(0, Math.ceil(archiveTotal / 50) - world.archiveCategoryIds.length);
  if (world.channels.length + newCategories > 500) errors.push('Server channel capacity exceeded');
  if (manifest.removeGameOptions)
    changes.push(
      'Remove imported game role/channel references from onboarding; preserve unrelated options and prompts',
    );
  const base = {
    version: 1 as const,
    manifest,
    fingerprint: fingerprint(world),
    games,
    changes,
    errors,
  };
  return { ...base, digest: hash(base) };
}
export async function applyPlan(
  plan: ImportPlan,
  repository: Repository,
  community: MigrationCommunity,
): Promise<void> {
  const { digest, ...base } = plan;
  if (plan.version !== 1 || digest !== hash(base) || plan.errors.length)
    throw new DomainError('invalidInput');
  parseManifest(plan.manifest);
  if (repository.get(`migration:${digest}`)) return;
  const world = await community.snapshot();
  if (!world.complete || fingerprint(world) !== plan.fingerprint)
    throw new DomainError('incomplete');
  for (const planned of [...plan.games].sort(
    (a, b) => Number(a.state === 'active') - Number(b.state === 'active'),
  )) {
    const target = structuredClone(planned);
    const role = world.roles.find((r) => r.id === target.roleId);
    if (!role) throw new DomainError('incomplete');
    const asset = await community.importRoleAsset(role.id);
    if (asset) {
      repository.saveAsset(asset);
      target.assetId = asset.id;
    }
    const game = { ...target, state: 'unavailable' as const, blocked: true };
    repository.saveGame(game);
    repository.replaceSubscribers(game.id, role.members);
    const op: Operation = {
      id: randomUUID(),
      kind: 'import',
      gameId: game.id,
      actorId: null,
      status: 'pending',
      startedAt: Date.now(),
      data: { state: target.state, plan: digest },
      error: null,
    };
    repository.saveOperation(op);
    try {
      await community.prepareImportedRole(role.id);
      await community.move(game, target.state === 'archived', op.id);
      repository.saveGame(target);
      op.status = 'completed';
      repository.saveOperation(op);
      repository.audit('import', null, target.id, Date.now());
    } catch {
      op.status = 'review';
      op.error = 'discordError';
      repository.saveOperation(op);
      throw new DomainError('partial', { game: game.name });
    }
  }
  if (plan.manifest.removeGameOptions)
    await community.removeGameOptions(
      plan.games.map((g) => g.roleId!),
      plan.games.map((g) => g.channelId!),
    );
  repository.set(`migration:${digest}`, { appliedAt: Date.now() });
}
