import { createHash, randomUUID } from 'node:crypto';
import {
  DAY,
  DomainError,
  normalize,
  type Asset,
  type Game,
  type Operation,
} from '../domain/model.js';
import type { Catalogue, Community, Repository, World } from './ports.js';

export interface ImportEntry {
  confirmed: true;
  name: string;
  channelId: string;
  roleId?: string;
  createRole?: true;
  iconRoleId?: string;
  state: 'active' | 'archived';
  rawgId?: number;
  aliases?: string[];
}
export interface Manifest {
  version: 1;
  entries: ImportEntry[];
  removeGameOptions: boolean;
  archiveCategoryIds?: string[];
}
export interface ImportPlan {
  version: 1;
  manifest: Manifest;
  fingerprint: string;
  games: Game[];
  changes: string[];
  errors: string[];
  digest: string;
  roleCreations?: { gameId: string; iconRoleId?: string }[];
}
export interface MigrationCommunity extends Community {
  adoptArchives(ids: string[], operationId: string): Promise<void>;
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
      typeof entry.channelId !== 'string' ||
      !/^\d{17,20}$/.test(entry.channelId) ||
      (entry.createRole === true
        ? entry.roleId !== undefined || (!entry.rawgId && !entry.iconRoleId)
        : typeof entry.roleId !== 'string' || !/^\d{17,20}$/.test(entry.roleId)) ||
      (entry.createRole !== undefined && entry.createRole !== true) ||
      (entry.iconRoleId !== undefined &&
        (entry.createRole !== true || !/^\d{17,20}$/.test(String(entry.iconRoleId)))) ||
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
    ...('archiveCategoryIds' in value
      ? { archiveCategoryIds: parseArchiveIds(value.archiveCategoryIds) }
      : {}),
  };
}
function parseArchiveIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    value.some((id) => typeof id !== 'string' || !/^\d{17,20}$/.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new DomainError('invalidInput');
  return value as string[];
}
export function buildPlan(
  manifest: Manifest,
  world: World,
  repository: Repository,
  maxGames: number,
  activeCategoryId: string,
  maxArchives = 3,
  roleReserve = 5,
): ImportPlan {
  const errors: string[] = [];
  const changes: string[] = [];
  const games: Game[] = [];
  const roleCreations: NonNullable<ImportPlan['roleCreations']> = [];
  const seenChannels = new Set<string>();
  const seenRoles = new Set<string>();
  const seenRawg = new Set<number>();
  const names = new Set<string>();
  if (!world.complete) errors.push('Incomplete Discord snapshot');
  const archiveIds = [
    ...new Set([...(manifest.archiveCategoryIds || []), ...world.archiveCategoryIds]),
  ];
  if (archiveIds.length > maxArchives) errors.push('Too many archive categories');
  for (const id of manifest.archiveCategoryIds || []) {
    const category = world.channels.find((c) => c.id === id);
    if (category?.type !== 4 || id === activeCategoryId)
      errors.push(`Invalid archive category: ${id}`);
    if (world.channels.some((c) => c.parentId === id && ![0, 5, 15, 16].includes(c.type)))
      errors.push(`Archive category contains non-textual channels: ${id}`);
    changes.push(
      `Archive category ${id}: reuse its ID, rename and hide the category and all its textual children, including channels outside the catalogue; preserve history; distribute any overflow across at most ${maxArchives} archive categories`,
    );
  }
  for (const entry of manifest.entries) {
    const channel = world.channels.find((c) => c.id === entry.channelId);
    const role = world.roles.find((r) => r.id === entry.roleId);
    if (!channel || ![0, 5, 15, 16].includes(channel.type))
      errors.push(`${entry.name}: main textual channel not found`);
    if (!entry.createRole && (!role || role.managed || !role.editable || role.permissions !== '0'))
      errors.push(
        `${entry.name}: role must be ordinary, below the bot and have zero global permissions`,
      );
    if (seenChannels.has(entry.channelId) || (entry.roleId && seenRoles.has(entry.roleId)))
      errors.push(`${entry.name}: a channel or role is used twice`);
    if (entry.rawgId && seenRawg.has(entry.rawgId))
      errors.push(`${entry.name}: duplicate RAWG identity`);
    if (names.has(normalize(entry.name))) errors.push(`${entry.name}: duplicate canonical name`);
    seenChannels.add(entry.channelId);
    if (entry.roleId) seenRoles.add(entry.roleId);
    if (entry.rawgId) seenRawg.add(entry.rawgId);
    names.add(normalize(entry.name));
    const existing = repository.games(true).find((g) => g.channelId === entry.channelId);
    if (
      entry.createRole &&
      repository
        .operations()
        .some(
          (o) =>
            o.gameId === existing?.id &&
            o.kind === 'import' &&
            o.data.createRole === true &&
            (o.status === 'pending' || o.status === 'review'),
        )
    )
      errors.push(
        `${entry.name}: a previous role creation needs review; select its existing role or repair the game before retrying`,
      );
    if (entry.createRole && !entry.rawgId && !entry.iconRoleId)
      errors.push(`${entry.name}: choose a verified RAWG game or parent role icon`);
    if (entry.iconRoleId && !world.roles.some((r) => r.id === entry.iconRoleId && !r.managed))
      errors.push(`${entry.name}: parent icon role not found`);
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
      roleId: entry.roleId || null,
      state: entry.state,
      roleState: entry.createRole ? 'missing' : 'present',
      lastActivityAt: existing?.lastActivityAt || null,
      activatedAt: existing?.activatedAt || Date.now(),
      awaitingActivity: false,
      assetId: existing?.assetId || null,
      canRecycle: Boolean(
        entry.createRole || (existing?.roleId === entry.roleId && existing?.canRecycle),
      ),
      blocked: false,
      retired: false,
      externalUrl: entry.rawgId ? `https://rawg.io/games/${entry.rawgId}` : null,
    };
    games.push(game);
    if (entry.createRole) {
      roleCreations.push({
        gameId: game.id,
        ...(entry.iconRoleId ? { iconRoleId: entry.iconRoleId } : {}),
      });
      changes.push(
        `${entry.name}: create a mentionable notification role with a verified icon, zero global permissions and zero initial subscribers; keep channel ${entry.channelId}; target ${entry.state}`,
      );
      continue;
    }
    changes.push(
      `${entry.name}: import current role holders; keep channel ${entry.channelId}; normalize Syndiqué visibility; target ${entry.state}; enable direct role mentions; ${game.canRecycle ? 'Nexus-created role keeps guarded recycling eligibility' : 'legacy role recycling disabled'}`,
    );
  }
  if (roleCreations.length && !world.roleIcons)
    errors.push('Role icons are unavailable on this server');
  if (roleCreations.length && world.roles.length + roleCreations.length > 250 - roleReserve)
    errors.push(
      'Insufficient role capacity including the reserved slots; free up space before importing',
    );
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
    (c) => archiveIds.includes(c.parentId || '') && !leavingArchives.has(c.id),
  );
  const archiveTotal =
    alreadyArchived.length +
    archiving.filter((g) => !alreadyArchived.some((c) => c.id === g.channelId)).length;
  if (archiveTotal > maxArchives * 50) errors.push('Archive capacity exceeded');
  const newCategories = Math.max(0, Math.ceil(archiveTotal / 50) - archiveIds.length);
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
    roleCreations,
    changes,
    errors,
  };
  return { ...base, digest: hash(base) };
}
export async function prepareRoleIcons(
  plan: ImportPlan,
  repository: Repository,
  community: Pick<MigrationCommunity, 'importRoleAsset'>,
  catalogue: Pick<Catalogue, 'get' | 'image'>,
): Promise<ImportPlan> {
  const copy = structuredClone(plan);
  if (!copy.errors.length)
    for (const creation of copy.roleCreations || []) {
      const game = copy.games.find((g) => g.id === creation.gameId)!;
      try {
        const asset = creation.iconRoleId
          ? await community.importRoleAsset(creation.iconRoleId)
          : game.rawgId
            ? await catalogue.image(await catalogue.get(game.rawgId))
            : null;
        if (!asset) throw new DomainError('invalidImage');
        repository.saveAsset(asset);
        repository.set(`import-icon:${game.id}`, {
          assetId: asset.id,
          expiresAt: Date.now() + 7 * DAY,
        });
        game.assetId = asset.id;
        copy.changes.push(`${game.name}: verified icon ${asset.sha256} from ${asset.source}`);
      } catch (error) {
        copy.errors.push(
          `${game.name}: new role icon unavailable (${error instanceof DomainError ? error.code : 'imageError'}); select a valid game or parent icon`,
        );
      }
    }
  const { digest: _digest, ...base } = copy;
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
  const creations = plan.roleCreations || [];
  for (const creation of creations) {
    const game = plan.games.find((g) => g.id === creation.gameId);
    if (!game || game.roleId || !game.assetId || !repository.asset(game.assetId))
      throw new DomainError('invalidImage');
    if (
      repository
        .operations()
        .some(
          (o) =>
            o.gameId === game.id &&
            o.kind === 'import' &&
            o.data.createRole === true &&
            (o.status === 'pending' || o.status === 'review'),
        )
    )
      throw new DomainError('needsReview');
  }
  if (plan.manifest.archiveCategoryIds?.length) {
    repository.set('archiveAdoption', {
      status: 'pending',
      plan: digest,
      ids: plan.manifest.archiveCategoryIds,
    });
    try {
      await community.adoptArchives(plan.manifest.archiveCategoryIds, digest);
      repository.set('archiveAdoption', {
        status: 'completed',
        plan: digest,
        ids: plan.manifest.archiveCategoryIds,
      });
    } catch {
      repository.set('archiveAdoption', {
        status: 'review',
        plan: digest,
        ids: plan.manifest.archiveCategoryIds,
      });
      throw new DomainError('partial', { game: 'archives' });
    }
  }
  for (const planned of [...plan.games].sort(
    (a, b) => Number(a.state === 'active') - Number(b.state === 'active'),
  )) {
    const target = structuredClone(planned);
    const createRole = creations.some((c) => c.gameId === target.id);
    const role = world.roles.find((r) => r.id === target.roleId);
    if (!role && !createRole) throw new DomainError('incomplete');
    const asset = createRole
      ? repository.asset(target.assetId!)
      : await community.importRoleAsset(role!.id);
    if (asset) {
      repository.saveAsset(asset);
      target.assetId = asset.id;
    }
    const game = { ...target, state: 'unavailable' as const, blocked: true };
    repository.saveGame(game);
    repository.replaceSubscribers(game.id, role?.members || []);
    const op: Operation = {
      id: randomUUID(),
      kind: 'import',
      gameId: game.id,
      actorId: null,
      status: 'pending',
      startedAt: Date.now(),
      data: {
        state: target.state,
        plan: digest,
        ...(createRole
          ? {
              createRole: true,
              roleName: target.name,
              previousRoleIds: world.roles.map((r) => r.id),
            }
          : {}),
      },
      error: null,
    };
    repository.saveOperation(op);
    try {
      if (createRole) {
        target.roleId = await community.createRole(target, asset, op.id);
        target.roleState = 'present';
        game.roleId = target.roleId;
        game.roleState = 'present';
        repository.saveGame(game);
      } else await community.prepareImportedRole(role!.id);
      await community.move(game, target.state === 'archived', op.id);
      repository.saveGame(target);
      op.status = 'completed';
      op.completedAt = Date.now();
      repository.saveOperation(op);
      repository.audit('import', null, target.id, Date.now());
      for (const previous of repository
        .operations()
        .filter(
          (o) =>
            o.gameId === game.id &&
            o.kind === 'import' &&
            o.id !== op.id &&
            (o.status === 'pending' || o.status === 'review'),
        )) {
        previous.status = 'completed';
        previous.completedAt = Date.now();
        previous.data.resolvedBy = op.id;
        repository.saveOperation(previous);
      }
    } catch {
      op.status = 'review';
      op.error = 'discordError';
      repository.saveOperation(op);
      throw new DomainError('partial', { game: game.name });
    }
  }
  if (plan.manifest.removeGameOptions)
    await community.removeGameOptions(
      plan.games.map((g) => repository.game(g.id)!.roleId!),
      plan.games.map((g) => g.channelId!),
    );
  repository.set(`migration:${digest}`, { appliedAt: Date.now() });
}
