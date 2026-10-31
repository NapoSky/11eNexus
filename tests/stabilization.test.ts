import { Client, Collection, MessageFlags, type Interaction } from 'discord.js';
import { setImmediate } from 'node:timers/promises';
import { Administration } from '../src/application/administration.js';
import { Controller } from '../src/presentation/controller.js';
import { session } from '../src/presentation/views.js';
import { languagesReady } from '../src/presentation/i18n.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { admin, asset, fixture, game, member } from './helpers.js';
import { eventFixture } from './event-helpers.js';
import { eventRoleName } from '../src/domain/community-event.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const log = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
function ui(f: ReturnType<typeof fixture>) {
  const client = new Client({ intents: [] });
  const gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' }),
    f.repository,
  );
  const controller = new Controller(f.nexus, gateway, log as never);
  const writes: { action: string; payload: unknown }[] = [];
  function interaction(customId: string, select?: string) {
    const i = {
      customId,
      id: '100000000000000123',
      createdTimestamp: Date.now(),
      guildId: gateway.config.guildId,
      locale: 'fr',
      user: { id: member.id },
      member: { roles: [gateway.config.memberRoleId] },
      guild: { ownerId: admin.id },
      message: {
        id: 'same-personal-message',
        flags: { has: (flag: number) => flag === MessageFlags.Ephemeral },
      },
      values: select ? [select] : [],
      deferred: false,
      replied: false,
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => !select,
      isStringSelectMenu: () => !!select,
      isModalSubmit: () => false,
      async deferReply() {
        this.deferred = true;
      },
      async deferUpdate() {
        this.deferred = true;
      },
      async editReply(payload: unknown) {
        writes.push({ action: customId, payload });
      },
      async reply(payload: unknown) {
        writes.push({ action: customId, payload });
      },
    };
    return i as unknown as Interaction;
  }
  return { controller, gateway, client, interaction, writes };
}
beforeAll(() => languagesReady);

test('a slow member candidate cannot overwrite a newer Home navigation', async () => {
  const f = fixture(),
    u = ui(f),
    entered = deferred(),
    release = deferred();
  try {
    f.catalogue.image = jest.fn(async () => {
      entered.resolve();
      await release.promise;
      return asset;
    });
    const s = session(f.repository, member.id, 'candidates', {
      ids: [42],
      query: 'Game',
      returnTo: { kind: 'home' },
    });
    const pending = u.controller.handle(u.interaction(`nx:candidate:${s.id}`, '42'));
    await entered.promise;
    await u.controller.handle(u.interaction(`nx:home:${s.id}`));
    expect(u.writes.at(-1)?.action).toContain('nx:home:');
    release.resolve();
    await pending;
    expect(u.writes.at(-1)?.action).toContain('nx:home:');
  } finally {
    release.resolve();
    await u.client.destroy();
    f.repository.close();
  }
});

test('navigation suppresses an obsolete result while allowing the already confirmed mutation to finish', async () => {
  const f = fixture(),
    u = ui(f),
    entered = deferred(),
    release = deferred();
  try {
    const g = f.add(game()),
      original = f.community.setSubscription.getMockImplementation()!;
    jest.spyOn(u.gateway, 'actor').mockResolvedValue(member);
    f.community.setSubscription.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const s = session(f.repository, member.id, 'game', { gameId: g.id });
    const pending = u.controller.handle(u.interaction(`nx:subscribe:${s.id}`));
    await entered.promise;
    await u.controller.handle(u.interaction(`nx:home:${s.id}`));
    release.resolve();
    await pending;
    expect(f.repository.subscribed(g.id, member.id)).toBe(true);
    expect(u.writes.at(-1)?.action).toContain('nx:home:');
  } finally {
    release.resolve();
    await u.client.destroy();
    f.repository.close();
  }
});

test('game repair confirmations tolerate membership changes and observe the latest target subscribers', async () => {
  const f = fixture();
  try {
    const g = f.add(game()),
      other = f.add(game());
    const service = new Administration(f.nexus, () => f.clock.now());
    const plan = await service.plan(admin, {
      kind: 'repair',
      gameId: g.id,
      channelId: g.channelId!,
      roleId: g.roleId!,
    });
    f.community.world.roles.find((r) => r.id === other.roleId)!.members.push(member.id);
    f.community.world.roles.find((r) => r.id === g.roleId)!.members.push(member.id);
    f.community.world.memberIds.push('new-member');
    await service.execute(admin, plan);
    expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  } finally {
    f.repository.close();
  }
});

test('unresolved event role attempts reserve their candidate role until reviewed', async () => {
  const f = eventFixture();
  try {
    const event = await f.create();
    const roleId = event.roleId!;
    f.repository.saveEvent({ ...event, roleId: null, issue: 'e.partial' });
    const op = f.repository.eventOperations()[0]!;
    f.repository.saveEventOperation({ ...op, status: 'review', attempted: ['role'] });
    f.community.world.roles.push({
      id: roleId,
      name: eventRoleName(event),
      members: [],
      managed: false,
      permissions: '0',
      editable: true,
      mentionable: true,
      references: [],
    });
    const service = new Administration(f.nexus, () => f.clock.now());
    await expect(
      service.plan(admin, {
        kind: 'repair',
        gameId: f.parent.id,
        channelId: f.parent.channelId!,
        roleId,
      }),
    ).rejects.toMatchObject({ code: 'repairReservedResource' });
    await expect(
      f.nexus.repair(admin, f.parent.id, f.parent.channelId!, roleId),
    ).rejects.toMatchObject({ code: 'repairReservedResource' });
    expect(f.community.repairResources).not.toHaveBeenCalled();
  } finally {
    f.repository.close();
  }
});

test('an unrelated role subscription does not invalidate an admin refusal or require a resource inventory', async () => {
  const f = fixture();
  try {
    const g = f.add(game());
    const p = await f.nexus.propose(member, 'Another game', 'https://example.com/game', 'fr');
    const service = new Administration(f.nexus, () => f.clock.now());
    const plan = await service.plan(admin, {
      kind: 'reject',
      proposalId: p.id,
      reason: 'Duplicate request',
    });
    f.community.world.roles.find((r) => r.id === g.roleId)!.members.push(member.id);
    await service.execute(admin, plan);
    expect(f.repository.proposal(p.id)?.status).toBe('rejected');
    expect(f.community.snapshot).not.toHaveBeenCalled();
  } finally {
    f.repository.close();
  }
});

test('repair refuses roles owned by an event, both in previews and direct application calls', async () => {
  const f = fixture();
  try {
    const g = f.add(game());
    const eventRole = '100000000000000099';
    f.community.world.roles.push({
      id: eventRole,
      name: 'Event role',
      members: [],
      managed: false,
      permissions: '0',
      mentionable: true,
      references: [],
      editable: true,
    });
    f.repository.saveEvent({
      id: 'event',
      gameId: g.id,
      gameName: g.name,
      name: 'Event',
      description: 'Event description',
      state: 'active',
      creatorId: admin.id,
      createdAt: f.clock.now(),
      closedAt: null,
      archivedAt: null,
      channelId: 'event-channel',
      roleId: eventRole,
      roleDeleted: false,
      messageId: 'event-message',
      announcementChannelId: null,
      announcementId: null,
      issue: null,
    });
    const service = new Administration(f.nexus, () => f.clock.now());
    await expect(
      service.plan(admin, {
        kind: 'repair',
        gameId: g.id,
        channelId: g.channelId!,
        roleId: eventRole,
      }),
    ).rejects.toMatchObject({ code: 'repairReservedResource' });
    await expect(f.nexus.repair(admin, g.id, g.channelId!, eventRole)).rejects.toMatchObject({
      code: 'repairReservedResource',
    });
    expect(f.repository.game(g.id)?.roleId).toBe(g.roleId);
    expect(f.community.repairResources).not.toHaveBeenCalled();
  } finally {
    f.repository.close();
  }
});

test('repair refuses the dedicated new-game alerts role without breaking its subscriptions', async () => {
  const f = fixture();
  try {
    const g = f.add(game()),
      roleId = f.nexus.policy.newGameRoleId;
    f.community.world.roles.push({
      id: roleId,
      name: 'New game alerts',
      members: [],
      managed: false,
      permissions: '0',
      mentionable: true,
      references: [],
      editable: true,
    });
    const service = new Administration(f.nexus, () => f.clock.now());
    await expect(
      service.plan(admin, { kind: 'repair', gameId: g.id, channelId: g.channelId!, roleId }),
    ).rejects.toMatchObject({ code: 'repairReservedResource' });
    await expect(f.nexus.repair(admin, g.id, g.channelId!, roleId)).rejects.toMatchObject({
      code: 'repairReservedResource',
    });
    await expect(f.nexus.setNewGameAlerts(member, true)).resolves.toBe(true);
    expect(f.repository.game(g.id)?.roleId).toBe(g.roleId);
  } finally {
    f.repository.close();
  }
});

test('membership revoked during a mutex wait prevents the queued game subscription', async () => {
  const f = fixture(),
    u = ui(f),
    held = deferred(),
    release = deferred(),
    observed = deferred();
  try {
    const g = f.add(game());
    let current = member;
    f.community.authorize.mockImplementation(async () => ({ ...current }));
    jest.spyOn(u.gateway, 'actor').mockImplementation(async () => {
      observed.resolve();
      return { ...current };
    });
    const blocker = f.nexus.mutex.run(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const s = session(f.repository, member.id, 'game', { gameId: g.id });
    const pending = u.controller.handle(u.interaction(`nx:subscribe:${s.id}`));
    await observed.promise;
    await setImmediate();
    expect(f.community.setSubscription).not.toHaveBeenCalled();
    current = { ...member, member: false };
    release.resolve();
    await blocker;
    await pending;
    expect(f.community.setSubscription).not.toHaveBeenCalled();
    expect(f.community.authorize).toHaveBeenCalledTimes(1);
    expect(u.gateway.actor).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await u.client.destroy();
    f.repository.close();
  }
});

test('a required activity scan still checks messages and public/private threads', async () => {
  const f = fixture(),
    u = ui(f);
  try {
    const channel = {
      type: 0,
      messages: { fetch: jest.fn(async () => new Collection()) },
      threads: {
        fetchActive: jest.fn(async () => ({ threads: new Collection() })),
        fetchArchived: jest.fn(async () => ({ threads: new Collection(), hasMore: false })),
      },
    };
    const fetchChannel = jest.fn(async () => channel);
    jest
      .spyOn(u.gateway, 'guild')
      .mockResolvedValue({ channels: { fetch: fetchChannel } } as never);
    await u.gateway.activity(game(), Date.now() - 30 * 86400000);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(channel.messages.fetch).toHaveBeenCalledTimes(1);
    expect(channel.threads.fetchActive).toHaveBeenCalledTimes(1);
    expect(channel.threads.fetchArchived).toHaveBeenCalledTimes(2);
  } finally {
    await u.client.destroy();
    f.repository.close();
  }
});

test('a member subscription completes while the reconciliation history scan is still waiting', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  try {
    for (let index = 0; index < 50; index++) f.add(game({ name: `Game ${index}` }));
    const target = f.repository.games()[0]!;
    f.community.activity.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { at: f.clock.now(), complete: true };
    });
    const scan = f.nexus.synchronize(false);
    await entered.promise;
    const action = f.nexus.subscribe(member, target.id, true);
    await action;
    expect(f.community.setSubscription).toHaveBeenCalledTimes(1);
    release.resolve();
    await scan;
    expect(f.community.activity).toHaveBeenCalledTimes(50);
    expect(f.community.setSubscription).toHaveBeenCalledTimes(1);
    expect(f.repository.subscribed(target.id, member.id)).toBe(true);
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test('a stale inventory cannot overwrite a subscription completed while that inventory was being read', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  try {
    const g = f.add(game({ lastActivityAt: f.clock.now() }));
    f.community.snapshot.mockImplementationOnce(async () => {
      const stale = structuredClone(f.community.world);
      entered.resolve();
      await release.promise;
      return stale;
    });
    const scan = f.nexus.synchronize(false);
    await entered.promise;
    await f.nexus.subscribe(member, g.id, true);
    release.resolve();
    await scan;
    expect(f.repository.subscribed(g.id, member.id)).toBe(true);
    expect(f.community.snapshot).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test('shutdown cancels reconciliation history reads before another game or any database mutation', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred(),
    reads = new AbortController();
  try {
    f.add(game());
    f.add(game());
    const before = f.repository.games();
    f.community.activity.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { at: null, complete: true };
    });
    const scan = f.nexus.synchronize(true, undefined, undefined, undefined, reads.signal);
    const result = expect(scan).rejects.toBeDefined();
    await entered.promise;
    reads.abort();
    release.resolve();
    await result;
    expect(f.community.activity).toHaveBeenCalledTimes(1);
    expect(f.community.snapshot).not.toHaveBeenCalled();
    expect(f.community.move).not.toHaveBeenCalled();
    expect(f.repository.games()).toEqual(before);
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test('recent established activity avoids redundant history scans while expired provisional games are still checked', async () => {
  const f = fixture(0);
  try {
    for (let i = 0; i < 50; i++)
      f.add(game({ lastActivityAt: f.clock.now(), name: `Recent ${i}` }));
    await f.nexus.synchronize();
    expect(f.community.activity).not.toHaveBeenCalled();
    expect(f.community.move).not.toHaveBeenCalled();
    const provisional = f.add(
      game({
        awaitingActivity: true,
        lastActivityAt: null,
        activatedAt: f.clock.now() - 3 * 86400000,
      }),
    );
    f.community.observations.set(provisional.id, { at: f.clock.now(), complete: true });
    await f.nexus.synchronize();
    expect(f.community.activity).toHaveBeenCalledTimes(1);
    expect(f.repository.game(provisional.id)).toMatchObject({
      state: 'active',
      awaitingActivity: false,
    });
  } finally {
    f.repository.close();
  }
});

test('a manual channel move during a slow history scan wins reconciliation', async () => {
  const f = fixture(0),
    entered = deferred(),
    release = deferred();
  try {
    const g = f.add(game());
    f.community.activity.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { at: g.lastActivityAt, complete: true };
    });
    const scan = f.nexus.synchronize();
    await entered.promise;
    f.community.world.channels.find((c) => c.id === g.channelId)!.parentId =
      'outside-managed-categories';
    release.resolve();
    await scan;
    expect(f.repository.game(g.id)?.state).toBe('unavailable');
    expect(f.community.move).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test.each(['create', 'activate', 'alerts', 'proposal'] as const)(
  'revocation during the mutex wait prevents %s',
  async (kind) => {
    const f = fixture(),
      held = deferred(),
      release = deferred();
    try {
      const archived = f.add(game({ state: 'archived' }));
      const blocker = f.nexus.mutex.run(async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const action =
        kind === 'create'
          ? f.nexus.create(member, 123)
          : kind === 'activate'
            ? f.nexus.activate(member, archived.id)
            : kind === 'alerts'
              ? f.nexus.setNewGameAlerts(member, true)
              : f.nexus.propose(member, 'Request', 'https://example.com/game', 'fr');
      f.community.authorize.mockResolvedValue({ ...member, member: false });
      const result = expect(action).rejects.toMatchObject({ code: 'forbidden' });
      release.resolve();
      await blocker;
      await result;
      expect(f.community.createChannel).not.toHaveBeenCalled();
      expect(f.community.move).not.toHaveBeenCalled();
      expect(f.community.setSubscription).not.toHaveBeenCalled();
      expect(f.repository.proposals()).toHaveLength(0);
    } finally {
      release.resolve();
      f.repository.close();
    }
  },
);

test('a displayed RAWG candidate reuses the validated asset without downloading it on confirmation', async () => {
  const f = fixture(),
    u = ui(f);
  try {
    jest.spyOn(u.gateway, 'actor').mockResolvedValue(member);
    const candidate = await f.catalogue.get(123);
    const view = u.controller.views.candidate(member, 'fr', candidate, asset.id);
    const walk = (value: unknown): string | undefined => {
      if (!value || typeof value !== 'object') return;
      if (
        'custom_id' in value &&
        typeof value.custom_id === 'string' &&
        value.custom_id.startsWith('nx:create:')
      )
        return value.custom_id;
      for (const child of Object.values(value)) {
        const id = walk(child);
        if (id) return id;
      }
    };
    const id = walk(JSON.parse(JSON.stringify(view)))!;
    const entered = deferred(),
      release = deferred();
    f.community.createChannel.mockImplementationOnce(async (g) => {
      entered.resolve();
      await release.promise;
      return `channel-${g.id}`;
    });
    const pending = u.controller.handle(u.interaction(id));
    await entered.promise;
    expect(JSON.stringify(u.writes.at(-1)?.payload)).toContain('Action en cours');
    release.resolve();
    await pending;
    expect(f.repository.byRawg(123)?.state).toBe('active');
    expect(f.catalogue.get).toHaveBeenCalledTimes(1);
    expect(f.catalogue.image).not.toHaveBeenCalled();
  } finally {
    await u.client.destroy();
    f.repository.close();
  }
});

test('fresh human activity received during a reconciliation scan protects the channel from archival', async () => {
  const f = fixture(0),
    entered = deferred(),
    release = deferred();
  try {
    f.add(game({ name: 'First game' }));
    f.add(game({ name: 'Second game' }));
    const [first, second] = f.repository.games();
    f.community.activity.mockImplementation(async (g) => {
      if (g.id === second!.id) {
        entered.resolve();
        await release.promise;
      }
      return { at: g.lastActivityAt, complete: true };
    });
    const scan = f.nexus.synchronize();
    await entered.promise;
    const activity = f.nexus.recordActivity(first!.channelId!, f.clock.now());
    release.resolve();
    await scan;
    await activity;
    expect(f.repository.game(first!.id)).toMatchObject({
      state: 'active',
      lastActivityAt: f.clock.now(),
    });
    expect(f.community.move.mock.calls.some(([g]) => g.id === first!.id)).toBe(false);
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test('reconciliation observations roll back together after a database write fails', async () => {
  const f = fixture();
  try {
    f.add(game());
    f.add(game());
    const before = f.repository.games();
    f.repository.subscribe(before[0]!.id, member.id, true);
    const save = f.repository.saveGame.bind(f.repository);
    jest.spyOn(f.repository, 'saveGame').mockImplementation((g) => {
      if (g.id === before[1]!.id) throw new Error('Simulated disk failure');
      save(g);
    });
    f.community.activity.mockResolvedValue({ at: f.clock.now(), complete: true });
    await expect(f.nexus.synchronize(false)).rejects.toThrow('Simulated disk failure');
    expect(f.repository.games()).toEqual(before);
    expect(f.repository.subscribers(before[0]!.id)).toEqual([member.id]);
    expect(f.repository.get('lastReconciliation')).toBeUndefined();
  } finally {
    f.repository.close();
  }
});

test('an admin reconciliation can confirm a manually revived game without waiting for the runtime cycle', async () => {
  const f = fixture();
  try {
    const g = f.add(game({ state: 'archived' }));
    f.community.world.channels.find((c) => c.id === g.channelId)!.parentId =
      f.nexus.policy.activeCategoryId;
    const service = new Administration(f.nexus, () => f.clock.now());
    const preview = await service.inspect(admin);
    await service.execute(admin, await service.plan(admin, { kind: 'reconcile' }, preview));
    expect(f.repository.game(g.id)).toMatchObject({ state: 'active', awaitingActivity: true });
    expect(f.community.move).not.toHaveBeenCalled();
  } finally {
    f.repository.close();
  }
});

test('a reviewed admin rotation does not silently archive an additional game recovered during application', async () => {
  const f = fixture(0);
  try {
    const reviewed = f.add(game());
    const recovered = game({
      state: 'unavailable',
      awaitingActivity: true,
      lastActivityAt: null,
      activatedAt: f.clock.now() - 3 * 86400000,
    });
    f.repository.saveGame(recovered);
    f.community.add({ ...recovered, state: 'active' });
    f.repository.saveOperation({
      id: 'interrupted-create',
      kind: 'create',
      gameId: recovered.id,
      actorId: member.id,
      status: 'pending',
      startedAt: recovered.activatedAt,
      data: {},
      error: null,
    });
    const service = new Administration(f.nexus, () => f.clock.now());
    const preview = await service.inspect(admin);
    expect(preview.candidates).toEqual([reviewed.id]);
    await service.execute(admin, await service.plan(admin, { kind: 'rotate' }, preview));
    expect(f.repository.game(reviewed.id)?.state).toBe('archived');
    expect(f.repository.game(recovered.id)?.state).toBe('active');
    expect(f.community.move).toHaveBeenCalledTimes(1);
  } finally {
    f.repository.close();
  }
});

test.each(['runtime', 'diagnostic'] as const)(
  'a game that crosses 30 days during the %s scan waits for a verified history',
  async (kind) => {
    const f = fixture(0);
    try {
      const recent = f.add(
        game({ id: 'first', lastActivityAt: f.clock.now() - 30 * 86400000 + 1 }),
      );
      const old = f.add(game({ id: 'second' }));
      f.community.activity.mockImplementation(async (g) => {
        f.clock.at += 2;
        return { at: g.lastActivityAt, complete: true };
      });
      if (kind === 'runtime') {
        await f.nexus.synchronize();
        expect(f.repository.game(recent.id)?.state).toBe('active');
        expect(f.repository.game(old.id)?.state).toBe('archived');
      } else {
        const preview = await new Administration(f.nexus, () => f.clock.now()).inspect(admin);
        expect(preview.candidates).toEqual([old.id]);
      }
      expect(f.community.activity).toHaveBeenCalledTimes(1);
    } finally {
      f.repository.close();
    }
  },
);
