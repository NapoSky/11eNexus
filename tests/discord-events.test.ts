import {
  ChannelType,
  Client,
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Guild,
} from 'discord.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { DiscordEvents } from '../src/infrastructure/discord-events.js';
import { config } from '../src/infrastructure/config.js';
import { eventFixture } from './event-helpers.js';
import { admin } from './helpers.js';
import { controls } from './component-helpers.js';
let f: ReturnType<typeof eventFixture>,
  client: Client,
  gateway: DiscordCommunity,
  events: DiscordEvents;
const botId = '100000000000000099',
  active = '100000000000000021',
  archive = '100000000000000022';
beforeEach(() => {
  f = eventFixture();
  client = new Client({ intents: [] });
  Object.defineProperty(client, 'user', { value: { id: botId } });
  gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' }),
    f.repository,
  );
  events = new DiscordEvents(gateway);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await client.destroy();
  f.repository.close();
});
function category(id: string, position: number) {
  return {
    id,
    name: id,
    type: ChannelType.GuildCategory,
    parentId: null as string | null,
    rawPosition: position,
    permissionsFor: () => ({ has: () => true }),
    permissionOverwrites: { cache: new Collection(), set: jest.fn(async () => {}) },
  };
}

test('new roles are mentionable, have no permissions and use a friendly name without internal identifiers', async () => {
  const event = await f.create();
  const create = jest.fn(async (_payload: unknown) => ({ id: 'created-role' }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ roles: { create } } as unknown as Guild);
  await events.createRole(event, 'operation');
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Event · Campagne PZ',
      permissions: 0n,
      mentionable: true,
      hoist: false,
    }),
  );
  expect((create.mock.calls[0]![0] as { name: string }).name).not.toContain(event.id);
});
test('category creation starts hidden and includes explicit bot pinning permission', async () => {
  const create = jest.fn(async (_payload: unknown) => ({ id: active }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => new Collection(), create },
  } as unknown as Guild);
  await events.createCategory(false, 'operation');
  const payload = create.mock.calls[0]![0] as unknown as {
    permissionOverwrites: { id: string; allow?: bigint[]; deny?: bigint[] }[];
  };
  expect(
    payload.permissionOverwrites.find((o) => o.id === gateway.config.memberRoleId)?.deny,
  ).toContain(P.ViewChannel);
  expect(payload.permissionOverwrites.find((o) => o.id === botId)?.allow).toContain(P.PinMessages);
});
test('announcements and pinned V2 messages restrict all mentions and the subscription control survives restarts', async () => {
  const event = await f.create(),
    send = jest.fn(async (_payload: unknown) => ({ id: 'message' })),
    pin = jest.fn(async () => {}),
    edit = jest.fn(async (_payload: unknown) => {});
  const message = { pinned: false, pin, edit };
  const channel = {
    type: ChannelType.GuildText,
    parentId: gateway.config.activeCategoryId,
    send,
    messages: { fetch: async () => message },
  };
  jest
    .spyOn(gateway, 'guild')
    .mockResolvedValue({ channels: { fetch: async () => channel } } as unknown as Guild);
  await events.publish(event);
  await events.announce(event);
  await events.pin(event);
  for (const [payload] of send.mock.calls as unknown as [Record<string, unknown>][])
    expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(controls(send.mock.calls[0]![0]).find((c) => c.custom_id)?.custom_id).toBe(
    `ne:subscribe:${event.id}`,
  );
  expect(pin).toHaveBeenCalledTimes(1);
  await events.updateMessage({ ...event, state: 'closed' });
  expect(controls(edit.mock.calls[0]![0]).every((c) => c.disabled)).toBe(true);
});
test('a forum announcement creates one V2 post with its reviewed tag instead of sending to the forum itself', async () => {
  const event = { ...(await f.create()), announcementTagId: 'tag' };
  const create = jest.fn(async () => ({ id: 'post' }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: {
      fetch: async () => ({
        type: ChannelType.GuildForum,
        parentId: gateway.config.activeCategoryId,
        flags: { has: () => true },
        threads: { create },
      }),
    },
  } as unknown as Guild);
  expect(await events.announce(event)).toBe('post');
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      appliedTags: ['tag'],
      message: expect.objectContaining({ allowedMentions: { parse: [] } }),
    }),
  );
});
test('the first event places its category above games, sorts its channels, and the last close parks it by archives', async () => {
  const games = category(gateway.config.activeCategoryId, 0),
    eventCategory = category(active, 2),
    archives = category(archive, 3);
  const channel = (id: string, name: string, position: number) => ({
    id,
    name,
    rawPosition: position,
    type: ChannelType.GuildText,
    parentId: active,
    topic: null,
    permissionOverwrites: { cache: new Collection(), set: jest.fn(async () => {}) },
    permissionsFor: () => ({ has: () => true }),
  });
  const channels = new Collection([
    [games.id, games],
    [active, eventCategory],
    [archive, archives],
    ['100000000000000031', channel('100000000000000031', 'Zulu', 0)],
    ['100000000000000032', channel('100000000000000032', 'Alpha', 1)],
  ]);
  const setPositions = jest.fn(async (_positions: unknown) => {});
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => channels, setPositions },
  } as unknown as Guild);
  jest.spyOn(events, 'inspect').mockImplementation(async () => ({
    complete: true,
    roles: [],
    channels: [...channels.values()].map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      parentId: c.parentId,
      topic: null,
      hidden: true,
    })),
  }));
  await events.layout(active, archive, true, ['100000000000000031', '100000000000000032']);
  const first = setPositions.mock.calls[0]![0] as unknown as {
    channel: string;
    position: number;
  }[];
  expect(first.find((x) => x.channel === active)!.position).toBeLessThan(
    first.find((x) => x.channel === games.id)!.position,
  );
  expect(setPositions.mock.calls[1]![0]).toEqual([
    { channel: '100000000000000032', position: 0 },
    { channel: '100000000000000031', position: 1 },
  ]);
  setPositions.mockClear();
  await events.layout(active, archive, false, ['100000000000000031', '100000000000000032']);
  const last = setPositions.mock.calls[0]![0] as unknown as { channel: string; position: number }[];
  expect(last.find((x) => x.channel === active)!.position).toBeGreaterThan(
    last.find((x) => x.channel === archive)!.position,
  );
});
test('an unknown or still visible child prevents hiding the empty category', async () => {
  const games = category(gateway.config.activeCategoryId, 0),
    cat = category(active, 1),
    archives = category(archive, 2);
  const channels = new Collection([
    [games.id, games],
    [active, cat],
    [archive, archives],
    ['unknown', { ...category('unknown', 0), type: ChannelType.GuildText, parentId: active }],
  ]);
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => channels, setPositions: jest.fn() },
  } as unknown as Guild);
  await expect(events.layout(active, archive, false, [])).rejects.toMatchObject({
    code: 'needsReview',
  });
  expect(cat.permissionOverwrites.set).not.toHaveBeenCalled();
});
test('role deletion rechecks foreign permissions and references immediately before deleting', async () => {
  const remove = jest.fn(async () => {}),
    role = { permissions: new PermissionsBitField(0n), managed: false, delete: remove };
  const guild = {
    roles: { fetch: async () => role },
    members: { fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => 1 } } }) },
    channels: {
      fetch: async () =>
        new Collection([
          ['foreign', { permissionOverwrites: { cache: new Collection([['role', {}]]) } }],
        ]),
    },
    fetchOnboarding: async () => ({ prompts: new Collection() }),
  };
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  await expect(events.deleteRole('role', 'operation')).rejects.toMatchObject({
    code: 'needsReview',
  });
  expect(remove).not.toHaveBeenCalled();
});
test('recovering an uncertain role requires its exact audit reason and bot executor, never its name alone', async () => {
  const event = await f.create();
  const roles = new Collection([
    ['genuine', { name: 'Event · Campagne PZ' }],
    ['other', { name: 'Event · Campagne PZ' }],
  ]);
  const entries = new Collection([
    ['one', { targetId: 'genuine', executorId: botId, reason: '11eNexus event:operation' }],
    ['two', { targetId: 'other', executorId: admin.id, reason: '11eNexus event:operation' }],
  ]);
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    roles: { fetch: async () => roles },
    fetchAuditLogs: async () => ({ entries }),
  } as unknown as Guild);
  expect(await events.recoverRole(event, 'operation')).toBe('genuine');
  expect(await events.recoverRole(event, 'different')).toBeNull();
});
