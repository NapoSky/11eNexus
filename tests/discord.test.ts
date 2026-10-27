import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Guild,
  ChannelType,
  PermissionFlagsBits as P,
  type Message,
} from 'discord.js';
import { DiscordCommunity, discordClient } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { archiveId, fixture, game, member, now } from './helpers.js';

let f: ReturnType<typeof fixture>;
let gateway: DiscordCommunity;
let client: Client;
beforeEach(() => {
  f = fixture();
  client = discordClient();
  gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' }),
    f.repository,
  );
});
afterEach(async () => {
  await client.destroy();
  f.repository.close();
});
test('the gateway never requests message content intent', () => {
  expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
  expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
});
test('a notification can mention only the selected role even if text contains everyone or other targets', async () => {
  const g = game();
  const send = jest.fn(async () => {});
  const guild = { channels: { fetch: jest.fn(async () => ({ isTextBased: () => true, send })) } };
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  await gateway.notify(g, member.id, '@everyone <@&OTHER> <@USER>');
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      allowedMentions: { parse: [], roles: [g.roleId], users: [], repliedUser: false },
    }),
  );
});
test('permissions are rechecked before sending a notification', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue({ ...member, member: false });
  const guild = jest.spyOn(gateway, 'guild');
  await expect(gateway.notify(game(), member.id, 'hello')).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(guild).not.toHaveBeenCalled();
});
test('only human messages in the target guild count, including messages inside a thread', async () => {
  const handler = jest.fn(async () => {});
  gateway.onActivity(handler);
  const base = {
    guildId: gateway.config.guildId,
    author: { bot: false },
    webhookId: null,
    system: false,
    channelId: 'channel',
    channel: { isThread: () => false },
    createdTimestamp: now,
  };
  for (const extra of [
    {},
    { author: { bot: true } },
    { webhookId: 'webhook' },
    { system: true },
    { guildId: 'other' },
    { channel: { isThread: () => true, parentId: 'parent' } },
  ])
    client.emit(Events.MessageCreate, { ...base, ...extra } as unknown as Message<true>);
  expect(handler.mock.calls).toEqual([
    ['channel', now],
    ['parent', now],
  ]);
});
test('onboarding cleanup preserves unrelated options and references in mixed options', async () => {
  const editOnboarding = jest.fn(async () => {});
  const option = (id: string, roles: string[], channels: string[]) => ({
    id,
    title: id,
    description: 'Option',
    emoji: null,
    roles: new Collection(roles.map((id) => [id, {}])),
    channels: new Collection(channels.map((id) => [id, {}])),
  });
  const guild = {
    fetchOnboarding: async () => ({
      prompts: new Collection([
        [
          'prompt',
          {
            id: 'prompt',
            title: 'Games',
            type: 0,
            singleSelect: false,
            required: false,
            inOnboarding: true,
            options: [
              option('game', ['game-role'], []),
              option('mixed', ['game-role', 'community-role'], ['community-channel']),
              option('unrelated', ['community-role'], []),
            ],
          },
        ],
      ]),
    }),
    editOnboarding,
  };
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  await gateway.removeGameOptions(['game-role'], ['game-channel']);
  expect(editOnboarding).toHaveBeenCalledWith(
    expect.objectContaining({
      prompts: [
        expect.objectContaining({
          options: [
            expect.objectContaining({
              id: 'mixed',
              roles: ['community-role'],
              channels: ['community-channel'],
            }),
            expect.objectContaining({ id: 'unrelated', roles: ['community-role'] }),
          ],
        }),
      ],
    }),
  );
});
test('private archived-thread activity is counted along with public threads and the main channel', async () => {
  const human = {
    id: 'm',
    author: { bot: false },
    webhookId: null,
    system: false,
    createdTimestamp: now,
  };
  const messages = { fetch: async () => new Collection() };
  const thread = {
    messages: { fetch: async () => new Collection([['m', human]]) },
    archiveTimestamp: now,
  };
  const fetchArchived = jest.fn(async (options: { type?: string }) => ({
    threads: options.type === 'private' ? new Collection([['thread', thread]]) : new Collection(),
    hasMore: false,
  }));
  const channel = {
    type: ChannelType.GuildText,
    messages,
    threads: { fetchActive: async () => ({ threads: new Collection() }), fetchArchived },
  };
  jest
    .spyOn(gateway, 'guild')
    .mockResolvedValue({ channels: { fetch: async () => channel } } as unknown as Guild);
  expect(await gateway.activity(game(), now - 1000)).toEqual({ at: now, complete: true });
  expect(fetchArchived).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'private', fetchAll: true }),
  );
});
test('archive permissions are restricted before the parent changes', async () => {
  Object.defineProperty(client, 'user', { value: { id: 'bot' } });
  f.repository.set('archiveCategories', [archiveId]);
  const order: string[] = [];
  const set = jest.fn(async () => {
    order.push('permissions');
  });
  const channel = {
    type: ChannelType.GuildText,
    permissionOverwrites: { cache: new Collection(), set },
    setParent: jest.fn(async () => {
      order.push('parent');
    }),
  };
  const categories = new Collection([
    [archiveId, { id: archiveId, type: ChannelType.GuildCategory, parentId: null }],
  ]);
  const guild = { channels: { fetch: async (id?: string) => (id ? channel : categories) } };
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  await gateway.move(game(), true, 'archive');
  expect(order).toEqual(['permissions', 'parent']);
  expect(set).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        id: gateway.config.memberRoleId,
        deny: [P.ViewChannel, P.SendMessages],
      }),
    ]),
    expect.any(String),
  );
});
test('three full archive categories stop before modifying any channel permission', async () => {
  const ids = ['a', 'b', 'c'];
  f.repository.set('archiveCategories', ids);
  const channels = new Collection<
    string,
    { id: string; type: ChannelType; parentId: string | null }
  >(ids.map((id) => [id, { id, type: ChannelType.GuildCategory, parentId: null }]));
  for (const id of ids)
    for (let i = 0; i < 50; i++)
      channels.set(id + i, { id: id + i, type: ChannelType.GuildText, parentId: id });
  const set = jest.fn(async () => {});
  const channel = {
    type: ChannelType.GuildText,
    permissionOverwrites: { cache: new Collection(), set },
    setParent: jest.fn(),
  };
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async (id?: string) => (id ? channel : channels) },
  } as unknown as Guild);
  await expect(gateway.move(game(), true, 'archive')).rejects.toMatchObject({ code: 'capacity' });
  expect(set).not.toHaveBeenCalled();
});
test('a channel already in a full archive can have its permissions normalized without a move', async () => {
  Object.defineProperty(client, 'user', { value: { id: 'bot' } });
  f.repository.set('archiveCategories', [archiveId]);
  const set = jest.fn(async () => {});
  const setParent = jest.fn(async () => {});
  const channel = {
    parentId: archiveId,
    type: ChannelType.GuildText,
    permissionOverwrites: { cache: new Collection(), set },
    setParent,
  };
  jest
    .spyOn(gateway, 'guild')
    .mockResolvedValue({ channels: { fetch: async () => channel } } as unknown as Guild);
  await gateway.move(game(), true, 'op');
  expect(set).toHaveBeenCalled();
  expect(setParent).not.toHaveBeenCalled();
});
test('standby archive adoption hides all textual children and moves only overflow', async () => {
  Object.defineProperty(client, 'user', { value: { id: 'bot' } });
  const first = '100000000000000200';
  const second = '100000000000000201';
  const acl = () => ({ cache: new Collection(), set: jest.fn(async () => {}) });
  const category = {
    id: first,
    parentId: null,
    type: ChannelType.GuildCategory,
    permissionOverwrites: acl(),
    setName: jest.fn(async () => {}),
  };
  const other = {
    id: second,
    parentId: null,
    type: ChannelType.GuildCategory,
    permissionOverwrites: acl(),
    setName: jest.fn(async () => {}),
  };
  const children = Array.from({ length: 52 }, (_, i) => {
    const child = {
      id: String(100000000000000300n + BigInt(i)),
      parentId: first,
      type: ChannelType.GuildText,
      permissionOverwrites: acl(),
      setParent: jest.fn(async (parent: string) => {
        child.parentId = parent;
      }),
    };
    return child;
  });
  const channels = new Collection<string, unknown>([
    [first, category],
    ...children.map((c) => [c.id, c] as [string, unknown]),
  ]);
  const create = jest.fn(async () => {
    channels.set(second, other);
    return other;
  });
  jest
    .spyOn(gateway, 'guild')
    .mockResolvedValue({ channels: { fetch: async () => channels, create } } as unknown as Guild);
  await gateway.adoptArchives([first], 'plan');
  expect(category.setName).toHaveBeenCalledWith('Archives Nexus · 1', expect.any(String));
  expect(category.permissionOverwrites.set).toHaveBeenCalled();
  expect(children.every((c) => c.permissionOverwrites.set.mock.calls.length === 1)).toBe(true);
  expect(children.filter((c) => c.parentId === first)).toHaveLength(50);
  expect(children.filter((c) => c.parentId === second)).toHaveLength(2);
  expect(create).toHaveBeenCalledTimes(1);
  expect(f.repository.get('archiveCategories')).toEqual([first, second]);
});
