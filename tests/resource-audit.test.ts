import {
  auditResources,
  collectResourceAudit,
  GAME_ROLE_MARKER,
} from '../src/application/resource-audit.js';
import { renderResourceAudit } from '../src/presentation/resource-audit.js';
import type { RoleObservation, World } from '../src/application/ports.js';
import type { Game, Operation } from '../src/domain/model.js';
import type { CommunityEvent } from '../src/domain/community-event.js';
import { game } from './helpers.js';

const guildId = '100000000000000100';
const active = '100000000000000500';
const archive = '100000000000000501';
const outside = '100000000000000502';
const trackedRole = '100000000000000200';
const orphanRole = '100000000000000201';
const trackedChannel = '100000000000000600';
const orphanChannel = '100000000000000601';
const memberId = '900000000000000999';
const options = { guildId, activeCategoryId: active };
const role = (
  id: string,
  name: string,
  position: number,
  extra: Partial<RoleObservation> = {},
): RoleObservation => ({
  id,
  name,
  position,
  managed: false,
  permissions: '0',
  mentionable: true,
  editable: true,
  references: [],
  members: [memberId],
  ...extra,
});
let world: World;
let games: Game[];
beforeEach(() => {
  games = [game({ name: 'Canonical Game', roleId: trackedRole, channelId: trackedChannel })];
  world = {
    complete: true,
    memberIds: [memberId],
    roleIcons: true,
    archiveCategoryIds: [archive],
    roles: [
      role(guildId, '@everyone', 0),
      role(GAME_ROLE_MARKER, 'Jeux réguliers', 10),
      role(trackedRole, 'Old game label', 9),
      role(orphanRole, 'Untracked role', 8),
      role('100000000000000202', 'Staff above marker', 11),
      role('100000000000000203', 'Integration', 7, { managed: true }),
    ],
    channels: [
      { id: active, name: 'Active', type: 4, parentId: null, topic: null },
      { id: archive, name: 'Archive', type: 4, parentId: null, topic: null },
      { id: outside, name: 'Community', type: 4, parentId: null, topic: null },
      { id: trackedChannel, name: 'old-label', type: 0, parentId: active, topic: null },
      { id: orphanChannel, name: 'Old forum', type: 15, parentId: archive, topic: null },
      { id: '100000000000000602', name: 'General', type: 0, parentId: outside, topic: null },
      { id: '100000000000000603', name: 'Voice', type: 2, parentId: active, topic: null },
    ],
  };
});

test('tracking uses IDs despite different names and restricts untracked resources to the requested scope', () => {
  world.roles.find((r) => r.id === orphanRole)!.name = games[0]!.name;
  const report = auditResources(games, [], world, options);
  expect(report.complete).toBe(true);
  expect(report.roles.find((r) => r.id === trackedRole)?.status).toBe('tracked');
  expect(report.roles.find((r) => r.id === orphanRole)?.status).toBe('untracked');
  expect(report.roles).toHaveLength(2);
  expect(report.channels).toHaveLength(2);
  expect(report.channels.find((r) => r.id === orphanChannel)?.status).toBe('untracked');
  expect(report.nameDifferences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: trackedRole, proposed: 'Canonical Game' }),
      expect.objectContaining({ id: trackedChannel, proposed: 'canonical-game' }),
    ]),
  );
  expect(report.nameDifferences.find((d) => d.id === trackedRole)?.conflictingIds).toEqual([
    orphanRole,
  ]);
  expect(JSON.stringify(report)).not.toContain(memberId);
});
test('event resources stay tracked independently of games and never receive game renaming suggestions', () => {
  const event: CommunityEvent = {
    id: 'event',
    gameId: games[0]!.id,
    gameName: games[0]!.name,
    name: 'Community campaign',
    description: 'Hello',
    state: 'active',
    creatorId: 'admin',
    createdAt: 1,
    closedAt: null,
    archivedAt: null,
    channelId: orphanChannel,
    roleId: orphanRole,
    roleDeleted: false,
    messageId: 'message',
    announcementChannelId: null,
    announcementId: null,
    issue: null,
  };
  let report = auditResources(games, [], world, { ...options, events: [event] });
  expect(report.roles.find((r) => r.id === orphanRole)).toMatchObject({
    status: 'tracked',
    events: [event.name],
  });
  expect(report.channels.find((r) => r.id === orphanChannel)?.status).toBe('tracked');
  expect(report.nameDifferences.some((d) => d.id === orphanRole)).toBe(false);
  event.issue = 'e.partial';
  report = auditResources(games, [], world, { ...options, events: [event] });
  expect(report.roles.find((r) => r.id === orphanRole)?.status).toBe('pending');
});

test('tied positions use Discord snowflake ordering rather than names or array order', () => {
  const below = String(BigInt(GAME_ROLE_MARKER) + 1n);
  const above = String(BigInt(GAME_ROLE_MARKER) - 1n);
  world.roles.push(role(below, 'A newer role', 10), role(above, 'Z older role', 10));
  const report = auditResources(games, [], world, options);
  expect(report.roles.some((r) => r.id === below)).toBe(true);
  expect(report.roles.some((r) => r.id === above)).toBe(false);
});

test('retired entries and unfinished creations are not mislabeled as strictly untracked', () => {
  games.push(game({ name: 'Retired game', roleId: orphanRole, channelId: null, retired: true }));
  const id = '100000000000000204';
  world.roles.push(role(id, 'Pending game', 5));
  const pending: Operation = {
    id: 'operation',
    kind: 'create',
    gameId: 'pending-game',
    actorId: null,
    status: 'review',
    startedAt: 0,
    error: null,
    data: { roleName: 'Pending game', previousRoleIds: [] },
  };
  world.channels.find((c) => c.id === orphanChannel)!.topic = '11eNexus:pending-game';
  const report = auditResources(games, [pending], world, options);
  expect(report.roles.find((r) => r.id === orphanRole)?.status).toBe('retired');
  expect(report.roles.find((r) => r.id === id)?.status).toBe('pending');
  expect(report.channels.find((c) => c.id === orphanChannel)?.status).toBe('pending');
});

test('incomplete snapshots, empty databases and missing hierarchy information never produce orphan lists', () => {
  const incomplete = auditResources(games, [], { ...world, complete: false }, options);
  const empty = auditResources([], [], world, options);
  delete world.roles.find((r) => r.id === orphanRole)!.position;
  const missingPosition = auditResources(games, [], world, options);
  for (const report of [incomplete, empty, missingPosition]) {
    expect(report.complete).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.roles).toEqual([]);
    expect(report.channels).toEqual([]);
  }
});

test('a missing marker or explicitly requested category prevents a misleading clean report', () => {
  expect(
    auditResources(games, [], world, { ...options, markerRoleId: '999999999999999999' }).complete,
  ).toBe(false);
  expect(
    auditResources(games, [], world, { ...options, categoryIds: ['999999999999999999'] }).complete,
  ).toBe(false);
});

test('tracked resources outside game categories and missing resources are reported separately', () => {
  world.channels.find((c) => c.id === trackedChannel)!.parentId = outside;
  world.roles = world.roles.filter((r) => r.id !== trackedRole);
  const report = auditResources(games, [], world, options);
  expect(report.trackedOutsideScope).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: trackedChannel, status: 'tracked' })]),
  );
  expect(report.missing).toContainEqual({ kind: 'role', id: trackedRole, game: 'Canonical Game' });
  games[0]!.roleState = 'recycled';
  expect(auditResources(games, [], world, options).missing).toEqual([]);
});

test('reference and subscriber counts remain visible without exposing individual subscribers', () => {
  world.roles.find((r) => r.id === orphanRole)!.references = [
    trackedChannel,
    'onboarding:question',
  ];
  const report = auditResources(games, [], world, options);
  const orphan = report.roles.find((r) => r.id === orphanRole)!;
  expect(orphan.subscribers).toBe(1);
  expect(orphan.references).toEqual([`old-label (${trackedChannel})`, 'onboarding:question']);
  expect(orphan).not.toHaveProperty('members');
});

test.each(['fr', 'en'] as const)(
  'the %s Markdown report lists IDs and proposals without executable role names',
  (language) => {
    world.roles.find((r) => r.id === orphanRole)!.name = '<script>alert(1)</script>|name';
    const report = renderResourceAudit(auditResources(games, [], world, options), language);
    expect(report).toContain(orphanRole);
    expect(report).toContain('canonical-game');
    expect(report).not.toContain('<script>');
    expect(report).toContain('\\|name');
    expect(report).not.toContain(memberId);
  },
);

test('a concurrent creation or repair cancels the audit instead of inventing untracked resources', async () => {
  const repository = {
    games: () => games,
    events: () => [],
    operations: () => [],
    get: () => undefined,
  };
  const community = {
    snapshot: async () => {
      games[0]!.roleId = orphanRole;
      return world;
    },
  };
  await expect(collectResourceAudit(repository, community, options)).rejects.toMatchObject({
    code: 'inProgress',
  });
});
