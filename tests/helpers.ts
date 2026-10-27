import { randomUUID } from 'node:crypto';
import { Nexus } from '../src/application/nexus.js';
import type { MigrationCommunity } from '../src/application/migration.js';
import type { Activity, Catalogue, World } from '../src/application/ports.js';
import { DAY, type Actor, type Asset, type Game } from '../src/domain/model.js';
import { Store } from '../src/infrastructure/store.js';

export const member: Actor = { id: '100000000000000001', member: true, admin: false };
export const admin: Actor = { id: '100000000000000002', member: false, admin: true };
export const outsider: Actor = { id: '100000000000000003', member: false, admin: false };
export const now = Date.UTC(2026, 9, 27, 12);
export const activeId = '100000000000000010';
export const archiveId = '100000000000000011';
export const asset: Asset = {
  id: 'asset',
  bytes: Buffer.from('icon'),
  mime: 'image/png',
  source: 'https://media.rawg.io/test.png',
  sha256: 'test',
};
export function game(overrides: Partial<Game> = {}): Game {
  const id = randomUUID();
  return {
    id,
    name: `Game ${id}`,
    rawgId: null,
    aliases: [],
    channelId: `channel-${id}`,
    roleId: `role-${id}`,
    roleState: 'present',
    state: 'active',
    lastActivityAt: now - 40 * DAY,
    activatedAt: now - 50 * DAY,
    awaitingActivity: false,
    assetId: asset.id,
    externalUrl: null,
    canRecycle: true,
    blocked: false,
    retired: false,
    ...overrides,
  };
}
export class FakeCommunity implements MigrationCommunity {
  world: World = {
    channels: [
      { id: activeId, name: 'Active', parentId: null, type: 4, topic: null },
      { id: archiveId, name: 'Archives', parentId: null, type: 4, topic: null },
    ],
    roles: [],
    memberIds: [member.id, admin.id],
    complete: true,
    archiveCategoryIds: [archiveId],
    roleIcons: true,
  };
  observations = new Map<string, Activity>();
  snapshot = jest.fn(async () => structuredClone(this.world));
  activity = jest.fn(
    async (g: Game) => this.observations.get(g.id) || { at: g.lastActivityAt, complete: true },
  );
  createChannel = jest.fn(async (g: Game) => {
    const id = `channel-${g.id}`;
    this.world.channels.push({
      id,
      name: g.name,
      parentId: activeId,
      type: 0,
      topic: `11eNexus:${g.id}`,
    });
    return id;
  });
  createRole = jest.fn(async (g: Game) => {
    const id = `role-${randomUUID()}`;
    this.world.roles.push({
      id,
      name: g.name,
      members: [],
      managed: false,
      permissions: '0',
      mentionable: true,
      references: [],
      editable: true,
    });
    return id;
  });
  move = jest.fn(async (g: Game, archive: boolean) => {
    const channel = this.world.channels.find((c) => c.id === g.channelId);
    if (!channel) throw new Error('Missing channel');
    channel.parentId = archive ? archiveId : activeId;
  });
  repairResources = jest.fn(async () => {});
  setSubscription = jest.fn(async (roleId: string, userId: string, enabled: boolean) => {
    const role = this.world.roles.find((r) => r.id === roleId);
    if (!role) throw new Error('Missing role');
    role.members = role.members.filter((id) => id !== userId);
    if (enabled) role.members.push(userId);
  });
  subscription = jest.fn(async (roleId: string, userId: string) =>
    Boolean(this.world.roles.find((r) => r.id === roleId)?.members.includes(userId)),
  );
  deleteRole = jest.fn(async (id: string) => {
    this.world.roles = this.world.roles.filter((r) => r.id !== id);
  });
  notify = jest.fn(async () => {});
  alert = jest.fn(async () => {});
  prepareImportedRole = jest.fn(async (id: string) => {
    const role = this.world.roles.find((r) => r.id === id);
    if (role) role.mentionable = true;
  });
  adoptArchives = jest.fn(async (ids: string[]) => {
    this.world.archiveCategoryIds = [...new Set([...ids, ...this.world.archiveCategoryIds])];
  });
  importRoleAsset = jest.fn(async () => asset);
  removeGameOptions = jest.fn(async () => {});
  add(g: Game): void {
    this.world.channels.push({
      id: g.channelId!,
      name: g.name,
      parentId: g.state === 'active' ? activeId : archiveId,
      type: 0,
      topic: null,
    });
    if (g.roleState === 'present')
      this.world.roles.push({
        id: g.roleId!,
        name: g.name,
        members: [],
        managed: false,
        permissions: '0',
        mentionable: false,
        references: [],
        editable: true,
      });
  }
}
export function fixture(minActive = 15) {
  const repository = new Store(':memory:');
  repository.saveAsset(asset);
  const community = new FakeCommunity();
  const catalogue: Catalogue = {
    search: jest.fn(async () => []),
    get: jest.fn(async (id: number) => ({
      id,
      name: `Game ${id}`,
      released: '2026-01-01',
      studio: 'Studio',
      imageUrl: 'https://media.rawg.io/test.png',
      url: `https://rawg.io/games/${id}`,
    })),
    image: jest.fn(async () => asset),
  };
  const clock = {
    at: now,
    now() {
      return this.at;
    },
  };
  const nexus = new Nexus(
    repository,
    community,
    catalogue,
    {
      maxGames: 150,
      minActive,
      roleReserve: 5,
      activeCategoryId: activeId,
      notificationCooldown: 900000,
    },
    clock,
  );
  const add = (g: Game) => {
    repository.saveGame(g);
    community.add(g);
    return g;
  };
  return { repository, community, catalogue, nexus, clock, add };
}
