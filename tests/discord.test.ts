import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Guild,
  ChannelType,
  PermissionFlagsBits as P,
  type Message,
  type GuildMember,
} from 'discord.js';
import { DiscordCommunity, discordClient } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { archiveId, asset, fixture, game, member, now } from './helpers.js';

let f: ReturnType<typeof fixture>;
let gateway: DiscordCommunity;
let client: Client;
beforeEach(() => {
  f = fixture();
  client = discordClient();
  gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '389372877818036236' }),
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
test('active ordering includes untracked forums, changes only positions and skips an already sorted category', async () => {
  const active = gateway.config.activeCategoryId;
  const permissionsFor = () => ({ has: () => true });
  const channels = new Collection([
    [active, { id: active, type: ChannelType.GuildCategory, parentId: null, permissionsFor }],
    [
      '10',
      {
        id: '10',
        name: 'zulu',
        rawPosition: 19,
        type: ChannelType.GuildText,
        parentId: active,
        permissionsFor,
      },
    ],
    [
      '20',
      {
        id: '20',
        name: 'alpha-forum',
        rawPosition: 100,
        type: ChannelType.GuildForum,
        parentId: active,
        permissionsFor,
      },
    ],
    [
      '30',
      {
        id: '30',
        name: 'archive',
        rawPosition: 0,
        type: ChannelType.GuildText,
        parentId: 'archive',
        permissionsFor,
      },
    ],
  ]);
  const setPositions = jest.fn(async (positions: { channel: string; position: number }[]) => {
    for (const p of positions) Object.assign(channels.get(p.channel)!, { rawPosition: p.position });
  });
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => channels, setPositions },
    members: { fetchMe: async () => ({}) },
  } as unknown as Guild);
  await gateway.sortActiveGameChannels();
  expect(setPositions).toHaveBeenCalledWith([
    { channel: '20', position: 0 },
    { channel: '10', position: 1 },
  ]);
  await gateway.sortActiveGameChannels();
  expect(setPositions).toHaveBeenCalledTimes(1);
});
test('ordering refuses missing permissions before sending a positional update', async () => {
  const active = gateway.config.activeCategoryId;
  const permissionsFor = () => ({ has: () => false });
  const channels = new Collection([
    [active, { id: active, type: ChannelType.GuildCategory, parentId: null, permissionsFor }],
    [
      '10',
      {
        id: '10',
        name: 'zulu',
        rawPosition: 0,
        type: ChannelType.GuildText,
        parentId: active,
        permissionsFor,
      },
    ],
    [
      '20',
      {
        id: '20',
        name: 'alpha',
        rawPosition: 1,
        type: ChannelType.GuildText,
        parentId: active,
        permissionsFor,
      },
    ],
  ]);
  const setPositions = jest.fn();
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => channels, setPositions },
    members: { fetchMe: async () => ({}) },
  } as unknown as Guild);
  await expect(gateway.sortActiveGameChannels()).rejects.toMatchObject({ code: 'needsReview' });
  expect(setPositions).not.toHaveBeenCalled();
});
test('ordering abandons a snapshot when a channel moves out while permissions are refreshed', async () => {
  const active = gateway.config.activeCategoryId;
  const permissionsFor = () => ({ has: () => true });
  const zulu = {
    id: '10',
    name: 'zulu',
    rawPosition: 0,
    type: ChannelType.GuildText,
    parentId: active as string | null,
    permissionsFor,
  };
  const channels = new Collection([
    [
      active,
      {
        id: active,
        name: 'active',
        rawPosition: 0,
        type: ChannelType.GuildCategory,
        parentId: null,
        permissionsFor,
      },
    ],
    ['10', zulu],
    [
      '20',
      {
        id: '20',
        name: 'alpha',
        rawPosition: 1,
        type: ChannelType.GuildText,
        parentId: active,
        permissionsFor,
      },
    ],
  ]);
  const setPositions = jest.fn();
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => channels, setPositions },
    members: {
      fetchMe: async () => {
        zulu.parentId = 'archive';
        return {};
      },
    },
  } as unknown as Guild);
  await gateway.sortActiveGameChannels();
  expect(setPositions).not.toHaveBeenCalled();
});
test('new notification roles are mentionable with no global permissions', async () => {
  const create = jest.fn(async () => ({ id: 'new-role' }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ roles: { create } } as unknown as Guild);
  await gateway.createRole(game(), asset, 'create');
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ mentionable: true, permissions: 0n }),
  );
});
test('import and repair enable direct role mentions and leave an already mentionable role alone', async () => {
  const setMentionable = jest.fn(async () => {});
  const role = {
    managed: false,
    permissions: { bitfield: 0n },
    mentionable: false,
    setMentionable,
  };
  setMentionable.mockImplementation(async () => {
    role.mentionable = true;
  });
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    roles: { fetch: async () => role },
    members: { fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => 1 } } }) },
  } as unknown as Guild);
  await gateway.prepareImportedRole('target-role');
  await gateway.prepareImportedRole('target-role');
  expect(setMentionable).toHaveBeenCalledTimes(1);
  expect(setMentionable).toHaveBeenCalledWith(true, expect.any(String));
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
test('an activity change while resolving the archive destination cancels before any permission write', async () => {
  Object.defineProperty(client, 'user', { value: { id: 'bot' } });
  f.repository.set('archiveCategories', [archiveId]);
  const set = jest.fn(),
    setParent = jest.fn();
  const channel = {
    type: ChannelType.GuildText,
    permissionOverwrites: { cache: new Collection(), set },
    setParent,
  };
  const categories = new Collection([
    [archiveId, { id: archiveId, type: ChannelType.GuildCategory, parentId: null }],
  ]);
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async (id?: string) => (id ? channel : categories) },
  } as unknown as Guild);
  await expect(gateway.move(game(), true, 'archive', () => false)).rejects.toMatchObject({
    code: 'activityChanged',
  });
  expect(set).not.toHaveBeenCalled();
  expect(setParent).not.toHaveBeenCalled();
  expect(f.repository.get('permissionsBefore:archive')).toBeUndefined();
});

test('the final member read refuses a role assignment after membership was revoked', async () => {
  const add = jest.fn(),
    remove = jest.fn();
  const fetch = jest.fn(async () => ({
    id: member.id,
    roles: { cache: new Collection(), add, remove },
    guild: { ownerId: 'another-owner' },
  }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ members: { fetch } } as unknown as Guild);
  await expect(gateway.setSubscription('game-role', member.id, true, true)).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(fetch).toHaveBeenCalledWith({ user: member.id, force: true });
  expect(add).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test('explicit recycled-role restoration retains preferences for a still-present former Syndiqué', async () => {
  const add = jest.fn(),
    remove = jest.fn();
  const fetch = jest.fn(async () => ({
    id: member.id,
    roles: { cache: new Collection(), add, remove },
  }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ members: { fetch } } as unknown as Guild);
  await gateway.setSubscription('restored-game-role', member.id, true);
  expect(add).toHaveBeenCalledWith('restored-game-role', expect.any(String));
  expect(remove).not.toHaveBeenCalled();
});

test.each(['permissions', 'parent'] as const)(
  'activity received during the archive %s call restores the original channel',
  async (step) => {
    Object.defineProperty(client, 'user', { value: { id: 'bot' } });
    f.repository.set('archiveCategories', [archiveId]);
    let allowed = true;
    const originalParent = gateway.config.activeCategoryId;
    const overwrite = {
      id: gateway.config.memberRoleId,
      type: 0,
      allow: { bitfield: P.ViewChannel },
      deny: { bitfield: 0n },
    };
    const set = jest.fn(async () => {
      if (step === 'permissions') allowed = false;
    });
    // Deliberately keep the original object unchanged: Discord.js may return a
    // different channel object after setParent, and cancellation must still work.
    const setParent = jest.fn(async () => {
      if (step === 'parent') allowed = false;
    });
    const channel = {
      parentId: originalParent,
      type: ChannelType.GuildText,
      permissionOverwrites: { cache: new Collection([[overwrite.id, overwrite]]), set },
      setParent,
    };
    const categories = new Collection([
      [archiveId, { id: archiveId, type: ChannelType.GuildCategory, parentId: null }],
    ]);
    jest.spyOn(gateway, 'guild').mockResolvedValue({
      channels: { fetch: async (id?: string) => (id ? channel : categories) },
    } as unknown as Guild);
    await expect(gateway.move(game(), true, 'archive', () => allowed)).rejects.toMatchObject({
      code: 'activityChanged',
    });
    expect(set).toHaveBeenLastCalledWith(
      [{ id: overwrite.id, type: 0, allow: P.ViewChannel, deny: 0n }],
      expect.any(String),
    );
    expect(setParent).toHaveBeenCalledTimes(step === 'parent' ? 2 : 0);
    if (step === 'parent')
      expect(setParent).toHaveBeenLastCalledWith(
        originalParent,
        expect.objectContaining({ lockPermissions: false }),
      );
  },
);
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

test.each(['public', 'ordinary-role', 'member-overwrite', 'incomplete'])(
  'staff-panel privacy refuses %s without rewriting any channel permissions',
  async (situation) => {
    const everyone = {
        id: gateway.config.guildId,
        managed: false,
        permissions: { has: () => false },
      },
      staffRole = {
        id: gateway.config.adminRoleId,
        managed: false,
        permissions: { has: () => false },
      },
      ordinaryRole = { id: 'ordinary', managed: false, permissions: { has: () => false } };
    const roles = new Collection([
      ['everyone', everyone],
      ['staff', staffRole],
      ['ordinary', ordinaryRole],
    ]);
    const guild = {
      id: gateway.config.guildId,
      ownerId: 'owner',
      memberCount: situation === 'incomplete' ? 3 : 2,
      roles: { everyone, fetch: async () => roles },
      channels: { fetch: jest.fn() },
      members: { list: jest.fn(), fetchMe: async () => ({ id: 'bot' }) },
    };
    const staff = {
        id: '100000000000000004',
        user: { bot: false },
        guild,
        roles: { cache: new Collection([[gateway.config.adminRoleId, staffRole]]) },
      },
      regular = { id: member.id, user: { bot: false }, guild, roles: { cache: new Collection() } };
    const set = jest.fn(),
      channel = {
        id: 'staff-channel',
        type: ChannelType.GuildText,
        permissionOverwrites: { set },
        permissionsFor: (target: { id: string }) => ({
          has: () =>
            target.id === 'bot' ||
            target.id === staff.id ||
            target === staffRole ||
            (target === everyone && situation === 'public') ||
            (target === ordinaryRole && situation === 'ordinary-role') ||
            (target === regular && situation === 'member-overwrite'),
        }),
      };
    guild.channels.fetch.mockResolvedValue(channel);
    guild.members.list.mockResolvedValue(
      new Collection([
        [staff.id, staff],
        [regular.id, regular],
      ]),
    );
    jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
    await expect(gateway.staffPanelChannel()).rejects.toMatchObject({
      code: situation === 'incomplete' ? 'incomplete' : 'staffChannelPublic',
    });
    expect(set).not.toHaveBeenCalled();
  },
);
test('staff panel privacy accepts an already private channel without changing overwrites', async () => {
  const everyone = {
      id: gateway.config.guildId,
      managed: false,
      permissions: { has: () => false },
    },
    staffRole = {
      id: gateway.config.adminRoleId,
      managed: false,
      permissions: { has: () => false },
    },
    roles = new Collection([
      ['everyone', everyone],
      ['staff', staffRole],
    ]);
  const guild = {
    id: gateway.config.guildId,
    ownerId: 'owner',
    memberCount: 1,
    roles: { everyone, fetch: async () => roles },
    channels: { fetch: jest.fn() },
    members: { list: jest.fn(), fetchMe: async () => ({ id: 'bot' }) },
  };
  const staff = {
      id: '100000000000000004',
      user: { bot: false },
      guild,
      roles: { cache: new Collection([[gateway.config.adminRoleId, staffRole]]) },
    },
    set = jest.fn(),
    channel = {
      id: 'staff-channel',
      type: ChannelType.GuildText,
      permissionOverwrites: { set },
      permissionsFor: (target: unknown) => ({ has: () => target !== everyone }),
    };
  guild.channels.fetch.mockResolvedValue(channel);
  guild.members.list.mockResolvedValue(new Collection([[staff.id, staff]]));
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  expect(await gateway.staffPanelChannel()).toBe(channel);
  expect(set).not.toHaveBeenCalled();
});
test('resource renaming checks conflicts and hierarchy before its first Discord write', async () => {
  const channel = {
      id: 'game-channel',
      name: 'old',
      setName: jest.fn(),
      permissionsFor: () => ({ has: () => true }),
    },
    role = {
      id: 'game-role',
      name: 'Old',
      managed: false,
      permissions: { bitfield: 0n },
      setName: jest.fn(),
    },
    me = { roles: { highest: { comparePositionTo: () => 1 } } };
  const channels = new Collection([
      ['game-channel', channel],
      ['conflict', { ...channel, id: 'conflict', name: 'new-name' }],
    ]),
    roles = new Collection([['game-role', role]]);
  const guild = {
    channels: { fetch: async (id?: string) => (id ? channel : channels) },
    roles: { fetch: async (id?: string) => (id ? role : roles) },
    members: { fetchMe: async () => me },
  };
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  await expect(
    gateway.renameGame(game({ channelId: channel.id, roleId: role.id }), 'New name', 'op'),
  ).rejects.toMatchObject({ code: 'duplicateGame' });
  expect(channel.setName).not.toHaveBeenCalled();
  expect(role.setName).not.toHaveBeenCalled();
  channels.delete('conflict');
  await gateway.renameGame(game({ channelId: channel.id, roleId: role.id }), 'New name', 'op');
  expect(channel.setName).toHaveBeenCalledWith('new-name', expect.any(String));
  expect(role.setName).toHaveBeenCalledWith('New name', expect.any(String));
});

test('leaving an activity scan stops before another message page or thread request', async () => {
  const abort = new AbortController();
  const reason = new Error('navigation changed');
  const fetchActive = jest.fn(),
    fetchArchived = jest.fn();
  const fetch = jest.fn(async () => {
    abort.abort(reason);
    return new Collection();
  });
  const channel = {
    type: ChannelType.GuildText,
    messages: { fetch },
    threads: { fetchActive, fetchArchived },
  };
  jest
    .spyOn(gateway, 'guild')
    .mockResolvedValue({ channels: { fetch: async () => channel } } as unknown as Guild);
  await expect(gateway.activity(game(), now - 1000, abort.signal)).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetchActive).not.toHaveBeenCalled();
  expect(fetchArchived).not.toHaveBeenCalled();
});
test('leaving a resource scan prevents further requests after the in-flight batch', async () => {
  const abort = new AbortController(),
    fetchMe = jest.fn();
  const reason = new Error('navigation changed');
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: { fetch: async () => new Collection() },
    roles: { fetch: async () => new Collection() },
    members: {
      list: async () => {
        abort.abort(reason);
        return new Collection();
      },
      fetchMe,
    },
    fetchOnboarding: async () => ({}),
  } as unknown as Guild);
  await expect(gateway.snapshot(abort.signal)).rejects.toBe(reason);
  expect(fetchMe).not.toHaveBeenCalled();
});

test('new game announcements are bilingual and may mention only their configured alert role', async () => {
  const send = jest.fn<Promise<{ id: string }>, [unknown]>(async () => ({ id: 'announcement' }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    roles: { fetch: async () => ({ managed: false, permissions: { bitfield: 0n } }) },
    channels: {
      fetch: async (id: string) => {
        expect(id).toBe('389733957890998294');
        return { isTextBased: () => true, send };
      },
    },
  } as unknown as Guild);
  const g = game({ name: 'Game @everyone <@123> <@&456>' });
  expect(await gateway.announceNewGame(g)).toBe('announcement');
  const payload = send.mock.calls[0]![0] as unknown as {
    content: string;
    allowedMentions: unknown;
    nonce: string;
    enforceNonce: boolean;
  };
  expect(payload.content).toContain('rejoint les jeux du serveur');
  expect(payload.content).toContain('has joined the server');
  expect(payload.content).toContain(g.channelId);
  expect(payload.allowedMentions).toEqual({
    parse: [],
    roles: [gateway.config.newGameRoleId],
    users: [],
    repliedUser: false,
  });
  expect(payload.nonce).toHaveLength(25);
  expect(payload.enforceNonce).toBe(true);
});

test.each(['missing', 'managed', 'privileged', 'above-bot'])(
  'the new game subscription rejects an unavailable %s role',
  async (reason) => {
    const add = jest.fn(),
      remove = jest.fn();
    const role =
      reason === 'missing'
        ? null
        : {
            managed: reason === 'managed',
            permissions: { bitfield: reason === 'privileged' ? P.Administrator : 0n },
            editable: reason !== 'above-bot',
          };
    jest.spyOn(gateway, 'guild').mockResolvedValue({
      roles: { fetch: async () => role },
      members: { fetch: async () => ({ roles: { add, remove } }) },
    } as unknown as Guild);
    await expect(
      gateway.setSubscription(gateway.config.newGameRoleId, member.id, true),
    ).rejects.toMatchObject({ code: 'newGameAlertsUnavailable' });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  },
);

function memberPage(start: number, count: number): Collection<string, GuildMember> {
  return new Collection(
    Array.from({ length: count }, (_, offset) => {
      const id = (100000000000000000n + BigInt(start + offset)).toString();
      return [
        id,
        {
          id,
          user: { bot: false },
          roles: { cache: new Collection([[gateway.config.memberRoleId, {}]]) },
        } as unknown as GuildMember,
      ];
    }),
  );
}
function inventoryGuild(count: number, list: jest.Mock) {
  const fetch = jest.fn(async () => {
    throw new Error('Full Gateway fetch must not run');
  });
  const role = {
    id: gateway.config.memberRoleId,
    name: 'Member',
    managed: false,
    permissions: { bitfield: 0n },
    mentionable: false,
    position: 1,
  };
  const guild = {
    memberCount: count,
    features: [],
    channels: { fetch: async () => new Collection() },
    roles: { fetch: async () => new Collection([[role.id, role]]) },
    members: {
      list,
      fetch,
      fetchMe: jest.fn(async () => ({
        permissions: { has: () => true },
        roles: { highest: { comparePositionTo: () => 1 } },
      })),
    },
    fetchOnboarding: async () => ({ prompts: new Collection() }),
  };
  jest.spyOn(gateway, 'guild').mockResolvedValue(guild as unknown as Guild);
  return guild;
}

test('resource snapshots read every REST member page using the highest snowflake cursor', async () => {
  const first = memberPage(0, 1000),
    second = memberPage(1000, 2);
  const list = jest
    .fn()
    .mockResolvedValueOnce(new Collection([...first].reverse()))
    .mockResolvedValueOnce(second);
  const guild = inventoryGuild(1002, list);
  const world = await gateway.snapshot();
  expect(world.complete).toBe(true);
  expect(world.memberIds).toHaveLength(1002);
  expect(world.roles[0]?.members).toHaveLength(1002);
  expect(list.mock.calls).toEqual([
    [{ limit: 1000, after: undefined, cache: false }],
    [{ limit: 1000, after: '100000000000000999', cache: false }],
  ]);
  expect(guild.members.fetch).not.toHaveBeenCalled();
});

test('consecutive snapshots observe role removals immediately without an expiring member cache', async () => {
  const before = memberPage(0, 1),
    after = memberPage(0, 1);
  after.first()!.roles.cache.clear();
  const list = jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  const guild = inventoryGuild(1, list);
  expect((await gateway.snapshot()).roles[0]?.members).toHaveLength(1);
  expect((await gateway.snapshot()).roles[0]?.members).toEqual([]);
  expect(list).toHaveBeenCalledTimes(2);
  expect(guild.members.fetch).not.toHaveBeenCalled();
});

test('a failed REST page rejects the snapshot instead of exposing a partial membership list', async () => {
  const error = new Error('network unavailable');
  const list = jest.fn().mockResolvedValueOnce(memberPage(0, 1000)).mockRejectedValueOnce(error);
  inventoryGuild(1002, list);
  await expect(gateway.snapshot()).rejects.toBe(error);
});

test('a short member list remains incomplete and cannot authorize reconciliation', async () => {
  inventoryGuild(2, jest.fn().mockResolvedValue(memberPage(0, 1)));
  expect((await gateway.snapshot()).complete).toBe(false);
});

test('repeated REST pages fail closed rather than looping or accepting stale members', async () => {
  const page = memberPage(0, 1000),
    list = jest.fn().mockResolvedValue(page);
  inventoryGuild(1002, list);
  await expect(gateway.snapshot()).rejects.toMatchObject({ code: 'incomplete' });
  expect(list).toHaveBeenCalledTimes(2);
});

test('navigation cancellation prevents fetching another REST member page', async () => {
  const abort = new AbortController(),
    reason = new Error('navigation changed');
  const list = jest.fn(async () => {
    abort.abort(reason);
    return memberPage(0, 1000);
  });
  const guild = inventoryGuild(1002, list);
  await expect(gateway.snapshot(abort.signal)).rejects.toBe(reason);
  expect(list).toHaveBeenCalledTimes(1);
  expect(guild.members.fetchMe).not.toHaveBeenCalled();
});

test.each([
  [true, true, 0, 0],
  [false, false, 0, 0],
  [false, true, 1, 0],
  [true, false, 0, 1],
])(
  'subscription writes only when the fresh role state changes (%s -> %s)',
  async (present, enabled, adds, removes) => {
    const add = jest.fn(async () => {}),
      remove = jest.fn(async () => {});
    const roles = new Collection<string, unknown>([[gateway.config.memberRoleId, {}]]);
    if (present) roles.set('game-role', {});
    const fetch = jest.fn(async () => ({
      id: member.id,
      roles: { cache: roles, add, remove },
      guild: { ownerId: 'another-owner' },
    }));
    jest.spyOn(gateway, 'guild').mockResolvedValue({ members: { fetch } } as unknown as Guild);
    await gateway.setSubscription('game-role', member.id, enabled, true);
    expect(fetch).toHaveBeenCalledWith({ user: member.id, force: true });
    expect(add).toHaveBeenCalledTimes(adds);
    expect(remove).toHaveBeenCalledTimes(removes);
  },
);

test('repeated enable/disable clicks keep fresh permission checks while avoiding duplicate Discord writes', async () => {
  const roles = new Collection<string, unknown>([[gateway.config.memberRoleId, {}]]);
  const add = jest.fn(async (id: string) => {
    roles.set(id, {});
  });
  const remove = jest.fn(async (id: string) => {
    roles.delete(id);
  });
  const fetch = jest.fn(async () => ({
    id: member.id,
    roles: { cache: roles, add, remove },
    guild: { ownerId: 'another-owner' },
  }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ members: { fetch } } as unknown as Guild);
  await gateway.setSubscription('game-role', member.id, true, true);
  await gateway.setSubscription('game-role', member.id, true, true);
  await gateway.setSubscription('game-role', member.id, false, true);
  await gateway.setSubscription('game-role', member.id, false, true);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(add).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

test('an already matching role state never bypasses revoked membership', async () => {
  const add = jest.fn(),
    remove = jest.fn();
  const fetch = jest.fn(async () => ({
    id: member.id,
    roles: { cache: new Collection([['game-role', {}]]), add, remove },
    guild: { ownerId: 'another-owner' },
  }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ members: { fetch } } as unknown as Guild);
  await expect(gateway.setSubscription('game-role', member.id, true, true)).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(add).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
