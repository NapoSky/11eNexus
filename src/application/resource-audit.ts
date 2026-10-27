import { channelName, DomainError, type Game, type Operation } from '../domain/model.js';
import type { Community, Repository, World } from './ports.js';

export const GAME_ROLE_MARKER = '811274814841028611';
export type AuditStatus = 'tracked' | 'untracked' | 'retired' | 'pending';
export interface AuditResource {
  kind: 'role' | 'channel';
  id: string;
  name: string;
  status: AuditStatus;
  games: string[];
  category?: string;
  subscribers?: number;
  references?: string[];
  permissions?: string;
  editable?: boolean;
}
export interface ResourceAudit {
  version: 1;
  generatedAt: string;
  complete: boolean;
  catalogueGames: number;
  marker: { id: string; name: string } | null;
  categories: { id: string; name: string }[];
  roles: AuditResource[];
  channels: AuditResource[];
  trackedOutsideScope: AuditResource[];
  missing: { kind: 'role' | 'channel'; id: string; game: string }[];
  nameDifferences: {
    kind: 'role' | 'channel';
    id: string;
    current: string;
    proposed: string;
    game: string;
    conflictingIds: string[];
  }[];
  errors: string[];
}

type AuditOptions = {
  guildId: string;
  activeCategoryId: string;
  markerRoleId?: string;
  categoryIds?: string[];
};

export async function collectResourceAudit(
  repository: Pick<Repository, 'games' | 'operations' | 'get'>,
  community: Pick<Community, 'snapshot'>,
  options: AuditOptions,
): Promise<ResourceAudit> {
  const revision = () =>
    JSON.stringify({
      games: repository.games(true).map(({ id, name, channelId, roleId, retired }) => ({
        id,
        name,
        channelId,
        roleId,
        retired,
      })),
      pending: repository
        .operations()
        .filter((op) => op.status === 'pending' || op.status === 'review'),
      archives: repository.get('archiveCategories'),
    });
  const before = revision();
  const world = await community.snapshot();
  // A concurrent creation or repair must not turn a new resource into a false orphan.
  if (revision() !== before) throw new DomainError('inProgress');
  return auditResources(repository.games(true), repository.operations(), world, {
    ...options,
    categoryIds: options.categoryIds || [
      options.activeCategoryId,
      ...(repository.get<string[]>('archiveCategories') || world.archiveCategoryIds),
    ],
  });
}

export function auditResources(
  games: Game[],
  operations: Operation[],
  world: World,
  options: AuditOptions,
): ResourceAudit {
  const marker = world.roles.find((r) => r.id === (options.markerRoleId || GAME_ROLE_MARKER));
  const categoryIds = [
    ...new Set(options.categoryIds || [options.activeCategoryId, ...world.archiveCategoryIds]),
  ];
  const report: ResourceAudit = {
    version: 1,
    generatedAt: new Date().toISOString(),
    complete: false,
    catalogueGames: games.filter((g) => !g.retired).length,
    marker: marker ? { id: marker.id, name: marker.name } : null,
    categories: categoryIds.map((id) => ({
      id,
      name: world.channels.find((c) => c.id === id)?.name || id,
    })),
    roles: [],
    channels: [],
    trackedOutsideScope: [],
    missing: [],
    nameDifferences: [],
    errors: [],
  };
  if (!world.complete)
    report.errors.push('Incomplete Discord snapshot; resources cannot be classified reliably');
  if (!games.length)
    report.errors.push('Empty SQLite catalogue; run this command against the production database');
  if (!marker) report.errors.push('Game role marker not found');
  const ordinary = world.roles.filter((r) => !r.managed && r.id !== options.guildId);
  if (
    !marker ||
    marker.id === options.guildId ||
    !/^\d{17,20}$/.test(marker.id) ||
    !Number.isInteger(marker.position) ||
    ordinary.some((r) => !Number.isInteger(r.position) || !/^\d{17,20}$/.test(r.id))
  )
    report.errors.push('Role hierarchy information is missing or invalid');
  for (const id of categoryIds)
    if (!world.channels.some((c) => c.id === id && c.type === 4))
      report.errors.push(`Category not found: ${id}`);
  if (report.errors.length) return report;
  const pending = operations.filter((op) => op.status === 'pending' || op.status === 'review');
  const pendingReference = (
    kind: 'role' | 'channel',
    id: string,
    name: string,
    topic?: string | null,
  ) =>
    pending.some((op) => {
      if (op.data[kind === 'role' ? 'roleId' : 'channelId'] === id) return true;
      if (kind === 'channel')
        return op.kind === 'create' && topic?.includes(`11eNexus:${op.gameId}`);
      return (
        (op.kind === 'create' ||
          op.kind === 'activate' ||
          (op.kind === 'import' && op.data.createRole === true)) &&
        op.data.roleName === name &&
        (!Array.isArray(op.data.previousRoleIds) || !op.data.previousRoleIds.includes(id))
      );
    });
  const classify = (
    kind: 'role' | 'channel',
    id: string,
    name: string,
    topic?: string | null,
  ): AuditResource => {
    const linked = games.filter((g) => (kind === 'role' ? g.roleId : g.channelId) === id);
    const tracked = linked.filter((g) => !g.retired);
    const status: AuditStatus = tracked.length
      ? 'tracked'
      : linked.length
        ? 'retired'
        : pendingReference(kind, id, name, topic)
          ? 'pending'
          : 'untracked';
    if (tracked.length === 1) {
      const game = tracked[0]!;
      const proposed = kind === 'role' ? game.name.slice(0, 100) : channelName(game.name);
      if (name !== proposed)
        report.nameDifferences.push({
          kind,
          id,
          current: name,
          proposed,
          game: game.name,
          conflictingIds: (kind === 'role' ? world.roles : world.channels)
            .filter((r) => r.id !== id && r.name.toLowerCase() === proposed.toLowerCase())
            .map((r) => r.id),
        });
    }
    return { kind, id, name, status, games: linked.map((g) => g.name) };
  };
  for (const role of world.roles.filter((r) => r.id !== options.guildId)) {
    if (role.id === marker!.id) continue;
    const resource = {
      ...classify('role', role.id, role.name),
      subscribers: role.members.length,
      permissions: role.permissions,
      editable: role.editable,
      references: role.references.map((id) =>
        id.startsWith('onboarding:')
          ? id
          : `${world.channels.find((c) => c.id === id)?.name || 'channel'} (${id})`,
      ),
    };
    const below =
      !role.managed &&
      (role.position! < marker!.position! ||
        (role.position === marker!.position && BigInt(role.id) > BigInt(marker!.id)));
    if (below) report.roles.push(resource);
    else if (resource.status !== 'untracked') report.trackedOutsideScope.push(resource);
  }
  for (const channel of world.channels.filter((c) => [0, 5, 15, 16].includes(c.type))) {
    const resource = {
      ...classify('channel', channel.id, channel.name, channel.topic),
      category:
        world.channels.find((c) => c.id === channel.parentId)?.name || channel.parentId || '',
    };
    if (categoryIds.includes(channel.parentId || '')) report.channels.push(resource);
    else if (resource.status !== 'untracked') report.trackedOutsideScope.push(resource);
  }
  for (const game of games.filter((g) => !g.retired))
    for (const kind of ['role', 'channel'] as const) {
      if (kind === 'role' && game.roleState === 'recycled') continue;
      const id = kind === 'role' ? game.roleId : game.channelId;
      const resources = kind === 'role' ? world.roles : world.channels;
      if (id && !resources.some((r) => r.id === id))
        report.missing.push({ kind, id, game: game.name });
    }
  for (const list of [report.roles, report.channels, report.trackedOutsideScope])
    list.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }));
  report.complete = true;
  return report;
}
