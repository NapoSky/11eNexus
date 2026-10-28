import {
  Client,
  Collection,
  ComponentType,
  MessageFlags,
  ModalSubmitInteraction,
  type Interaction,
  type TextChannel,
} from 'discord.js';
import sharp from 'sharp';
import { Controller } from '../src/presentation/controller.js';
import { AdminViews, type AdminRoute } from '../src/presentation/admin-views.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { commands } from '../src/presentation/commands.js';
import { session, type View } from '../src/presentation/views.js';
import { admin, fixture, game, member } from './helpers.js';
import { actionId, assertUniqueCustomIds, controls, nodes, select } from './component-helpers.js';
let f: ReturnType<typeof fixture>,
  client: Client,
  gateway: DiscordCommunity,
  controller: Controller,
  views: AdminViews;
const log = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
};
beforeEach(() => {
  f = fixture();
  client = new Client({ intents: [] });
  gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' }),
    f.repository,
  );
  controller = new Controller(f.nexus, gateway, log);
  views = controller.administration.views;
  jest.spyOn(gateway, 'actor').mockImplementation(async (id) => (id === admin.id ? admin : member));
  for (const method of Object.values(log)) method.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await client.destroy();
  f.repository.close();
});
function button(customId: string) {
  return {
    customId,
    id: '100000000000000123',
    createdTimestamp: Date.now(),
    guildId: gateway.config.guildId,
    locale: 'fr',
    user: { id: admin.id },
    member: { roles: [gateway.config.adminRoleId] },
    guild: { ownerId: admin.id },
    message: {
      id: 'private-message',
      flags: { has: (flag: number) => flag === MessageFlags.Ephemeral },
    },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferReply: jest.fn(async function (this: { deferred: boolean }) {
      this.deferred = true;
    }),
    deferUpdate: jest.fn(async function (this: { deferred: boolean }) {
      this.deferred = true;
    }),
    reply: jest.fn<Promise<void>, [unknown]>(async () => {}),
    editReply: jest.fn<Promise<void>, [unknown]>(async (payload) => {
      assertUniqueCustomIds(payload);
    }),
    showModal: jest.fn<Promise<void>, [unknown]>(async () => {}),
  };
}
const response = (i: ReturnType<typeof button>) => i.editReply.mock.calls.at(-1)![0] as View;
const click = (view: unknown, action: string) => button(actionId(view, action, 'na'));
async function run(i: ReturnType<typeof button>) {
  await controller.handle(i as unknown as Interaction);
  return response(i);
}
function chosen(view: unknown, action: string, value: string) {
  return {
    ...click(view, action),
    values: [value],
    isButton: () => false,
    isStringSelectMenu: () => true,
  };
}
function submit(
  i: ReturnType<typeof button>,
  fields: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const modal = JSON.parse(JSON.stringify(i.showModal.mock.calls[0]![0]));
  return {
    ...button(modal.custom_id),
    isButton: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    message: i.message,
    fields: { getTextInputValue: (name: string) => fields[name] },
    ...extra,
  };
}
const render = (route: AdminRoute) => views.render(admin, 'fr', route);

test('only member and admin entry commands are registered, with no administrative subcommands', () => {
  const registered = commands();
  expect(registered.map((c) => c.name)).toEqual(['nexus', 'nexus-admin']);
  expect(registered.find((c) => c.name === 'nexus-admin')?.options || []).toEqual([]);
});
test('a persistent staff button opens one localized private hub without mutations', async () => {
  const i = button('na:home');
  const view = await run(i);
  expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(i.deferUpdate).not.toHaveBeenCalled();
  for (const action of ['requests', 'catalogue', 'maintenance', 'panels'])
    expect(actionId(view, action, 'na')).toBeDefined();
  expect(f.community.snapshot).not.toHaveBeenCalled();
  expect(f.community.move).not.toHaveBeenCalled();
  expect(f.community.alert).not.toHaveBeenCalled();
});
test('the existing Administration button enters the same hub by updating its private message', async () => {
  const s = session(f.repository, admin.id, 'browse', {}),
    i = button(`nx:admin:${s.id}`);
  expect(actionId(await run(i), 'catalogue', 'na')).toBeDefined();
  expect(i.deferUpdate).toHaveBeenCalled();
  expect(i.deferReply).not.toHaveBeenCalled();
});
test('old administrative command payloads only open the hub and cannot replay old arguments', async () => {
  const i = {
    ...button(''),
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: 'nexus-admin',
    options: { getSubcommand: () => 'retire', getString: () => 'some-game' },
  };
  expect(actionId(await run(i), 'catalogue', 'na')).toBeDefined();
  expect(f.repository.games()).toHaveLength(0);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('members and other session owners cannot inspect admin pages or use their actions', async () => {
  const view = render({ page: 'catalogue', filter: 'all', query: '', index: 0 });
  const i = {
    ...click(view, 'add'),
    user: { id: member.id },
    member: { roles: [gateway.config.memberRoleId] },
  };
  await controller.handle(i as unknown as Interaction);
  expect(i.deferUpdate).not.toHaveBeenCalled();
  expect(controls(i.reply.mock.calls[0]![0])).toHaveLength(0);
  expect(f.community.snapshot).not.toHaveBeenCalled();
  const s = session(f.repository, 'another-admin', 'admin', { route: { page: 'home' } }),
    foreign = button(`na:catalogue:${s.id}`);
  await controller.handle(foreign as unknown as Interaction);
  expect(foreign.deferUpdate).not.toHaveBeenCalled();
  expect(JSON.stringify(foreign.reply.mock.calls)).toContain('expiré');
});
test('request refusal and clarification are guided modals, require confirmation and preserve request filters', async () => {
  const p = await f.nexus.propose(member, 'Wardogs', 'https://example.com/game', 'fr');
  const list = render({ page: 'requests', filter: 'all', query: 'Ward', index: 0 });
  const detail = await run(chosen(list, 'request', p.id)),
    clarify = click(detail, 'clarify');
  await controller.handle(clarify as unknown as Interaction);
  expect(clarify.showModal).toHaveBeenCalledTimes(1);
  expect(clarify.deferUpdate).not.toHaveBeenCalled();
  const review = await run(submit(clarify, { reason: 'Quelle édition ?' }));
  expect(f.repository.proposal(p.id)?.status).toBe('pending');
  expect(JSON.stringify(review)).toContain('Quelle édition');
  const completed = await run(click(review, 'confirm'));
  expect(f.repository.proposal(p.id)).toMatchObject({
    status: 'needs_info',
    reason: 'Quelle édition ?',
  });
  const back = await run(click(completed, 'back'));
  expect(select(back)[0]?.value).toBe(p.id);
  const state = f.repository.session(actionId(back, 'request', 'na').split(':')[2]!)!.data.route;
  expect(state).toMatchObject({ page: 'requests', filter: 'all', query: 'Ward', index: 0 });
  const reject = click(await run(chosen(back, 'request', p.id)), 'reject');
  await controller.handle(reject as unknown as Interaction);
  const rejection = await run(submit(reject, { reason: 'Le jeu existe déjà.' }));
  await run(click(rejection, 'confirm'));
  expect(f.repository.proposal(p.id)?.status).toBe('rejected');
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('approving with a parent image stays inside the panel and does not copy parent subscribers', async () => {
  const parent = f.add(game({ name: 'Parent game' }));
  f.repository.subscribe(parent.id, member.id, true);
  const p = await f.nexus.propose(member, 'A new game', 'https://example.com/new', 'fr');
  f.repository.setCooldown(member.id, Date.now());
  let view = render({
    page: 'request',
    id: p.id,
    back: { page: 'requests', filter: 'all', query: 'new', index: 0 },
  });
  view = await run(click(view, 'approve'));
  view = await run(click(view, 'parent'));
  view = await run(chosen(view, 'parent-game', parent.id));
  expect(JSON.stringify(view)).toContain('Visuel préparé');
  view = await run(click(view, 'preview'));
  expect(f.community.createChannel).not.toHaveBeenCalled();
  const confirm = click(view, 'confirm');
  view = await run(confirm);
  const accepted = f.repository.proposal(p.id)!;
  expect(accepted.status).toBe('accepted');
  expect(f.repository.subscribers(accepted.gameId!)).toEqual([]);
  expect(confirm.editReply).toHaveBeenCalledTimes(2);
  expect(actionId(view, 'request-game', 'na')).toBeDefined();
});
test('a manual approval detects a member amendment before preparing its final confirmation', async () => {
  const parent = f.add(game()),
    p = await f.nexus.propose(member, 'A game', 'https://example.com', 'fr');
  let view = await run(
    click(
      render({
        page: 'request',
        id: p.id,
        back: { page: 'requests', filter: 'open', query: '', index: 0 },
      }),
      'approve',
    ),
  );
  view = await run(click(view, 'parent'));
  view = await run(chosen(view, 'parent-game', parent.id));
  await f.nexus.clarify(admin, p.id, 'Which edition?');
  await f.nexus.amendProposal(member, p.id, 'Corrected edition', 'https://example.com/corrected');
  const i = click(view, 'preview');
  const error = await run(i);
  expect(JSON.stringify(error)).toContain('état a changé');
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('RAWG addition previews identity and icon, creates only on confirmation, then returns to its catalogue', async () => {
  let view = render({ page: 'catalogue', filter: 'all', query: '', index: 0 });
  view = await run(click(view, 'add'));
  const search = click(view, 'rawg');
  await controller.handle(search as unknown as Interaction);
  jest.mocked(f.catalogue.search).mockResolvedValueOnce([await f.catalogue.get(123)]);
  view = await run(submit(search, { query: 'GTFO' }));
  view = await run(chosen(view, 'candidate', '123'));
  expect(JSON.stringify(view)).toContain('Game 123');
  expect(f.community.createChannel).not.toHaveBeenCalled();
  view = await run(click(view, 'preview'));
  view = await run(click(view, 'confirm'));
  expect(f.repository.byRawg(123)?.state).toBe('active');
  expect(f.community.createRole).toHaveBeenCalledTimes(1);
  expect(f.repository.cooldown(admin.id)).toBeNull();
  expect(f.repository.subscribers(f.repository.byRawg(123)!.id)).toEqual([]);
  expect(actionId(view, 'edit', 'na')).toBeDefined();
  const back = await run(click(view, 'back'));
  expect(select(back)[0]?.label).toBe('Game 123');
});
test('image upload uses a modal file control and stores ephemeral attachment bytes before confirmation', async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#557c5b' } })
    .png()
    .toBuffer();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(png));
  let view = await run(
    click(render({ page: 'catalogue', filter: 'all', query: '', index: 0 }), 'add'),
  );
  const identity = click(view, 'identity');
  await controller.handle(identity as unknown as Interaction);
  view = await run(submit(identity, { name: 'Manual game', url: 'https://example.com' }));
  const upload = click(view, 'upload');
  await controller.handle(upload as unknown as Interaction);
  expect(
    nodes(JSON.parse(JSON.stringify(upload.showModal.mock.calls[0]![0]))).some(
      (n) => n.type === ComponentType.FileUpload,
    ),
  ).toBe(true);
  const attachment = {
    url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/image.png?ex=SIGNED',
    size: png.length,
  };
  view = await run(
    submit(
      upload,
      {},
      { fields: { getUploadedFiles: () => new Collection([['image', attachment]]) } },
    ),
  );
  const route = f.repository.session(actionId(view, 'preview', 'na').split(':')[2]!)!.data
    .route as Extract<AdminRoute, { page: 'prepare' }>;
  const stored = f.repository.asset(route.draft.assetId!)!;
  expect(stored.source).not.toContain('?');
  expect(stored.bytes.length).toBeGreaterThan(0);
  expect(f.community.createChannel).not.toHaveBeenCalled();
  f.repository.maintain(Date.now());
  expect(f.repository.asset(stored.id)).not.toBeNull();
  view = await run(click(view, 'preview'));
  f.repository.maintain(Date.now());
  expect(f.repository.asset(stored.id)).not.toBeNull();
  await run(click(view, 'confirm'));
  expect(f.repository.games()[0]?.assetId).toBe(stored.id);
});
test('catalogue edits explicitly choose whether Discord channel and role names are aligned', async () => {
  const g = f.add(game({ name: 'Old title' })),
    view = render({
      page: 'game',
      id: g.id,
      back: { page: 'catalogue', filter: 'all', query: 'Old', index: 0 },
    }),
    edit = click(view, 'edit');
  await controller.handle(edit as unknown as Interaction);
  let review = await run(submit(edit, { name: 'New title', aliases: 'Old title, Alias' }));
  expect(f.community.renameGame).not.toHaveBeenCalled();
  review = await run(click(review, 'align'));
  expect(JSON.stringify(review)).toContain('new-title');
  await run(click(review, 'confirm'));
  expect(f.community.renameGame).toHaveBeenCalledTimes(1);
  expect(f.repository.game(g.id)).toMatchObject({
    name: 'New title',
    aliases: ['Old title', 'Alias'],
  });
});
test('native selectors repair a game using names, with review of the permission changes', async () => {
  const g = f.add(game({ blocked: true }));
  let view = render({
    page: 'game',
    id: g.id,
    back: { page: 'catalogue', filter: 'unavailable', query: '', index: 0 },
  });
  view = await run(click(view, 'repair'));
  expect(nodes(view).some((n) => n.type === ComponentType.ChannelSelect)).toBe(true);
  expect(nodes(view).some((n) => n.type === ComponentType.RoleSelect)).toBe(true);
  view = await run(chosen(view, 'repair-channel', g.channelId!));
  view = await run(chosen(view, 'repair-role', g.roleId!));
  view = await run(click(view, 'preview'));
  expect(JSON.stringify(view)).toContain('réapplique les permissions');
  expect(f.community.repairResources).not.toHaveBeenCalled();
  await run(click(view, 'confirm'));
  expect(f.community.repairResources).toHaveBeenCalledTimes(1);
  expect(f.repository.game(g.id)?.blocked).toBe(false);
});
test('diagnostic and reconciliation are separate from rotation; opening screens does not mutate Discord', async () => {
  const g = f.add(game());
  f.community.world.roles[0]!.members = [member.id];
  const initial = await run(button('na:maintenance'));
  expect(f.community.snapshot).not.toHaveBeenCalled();
  let view = await run(click(initial, 'diagnose'));
  expect(f.repository.subscribers(g.id)).toEqual([]);
  expect(f.community.move).not.toHaveBeenCalled();
  view = await run(click(view, 'reconcile'));
  expect(JSON.stringify(view)).toContain('Aucun archivage');
  await run(click(view, 'confirm'));
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('permissions revoked before confirmation prevent changes and remove admin controls', async () => {
  const g = f.add(game({ state: 'archived' }));
  const view = await run(
    click(
      render({
        page: 'game',
        id: g.id,
        back: { page: 'catalogue', filter: 'all', query: '', index: 0 },
      }),
      'activate',
    ),
  );
  jest.mocked(gateway.actor).mockResolvedValueOnce({ ...admin, admin: false });
  const i = click(view, 'confirm');
  const error = await run(i);
  expect(controls(error)).toHaveLength(0);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('an expired acknowledgement is never retried and prevents all admin mutations', async () => {
  const i = button('na:home');
  i.deferReply.mockRejectedValueOnce(Object.assign(new Error('expired token'), { code: 10062 }));
  await controller.handle(i as unknown as Interaction);
  expect(i.reply).not.toHaveBeenCalled();
  expect(i.editReply).not.toHaveBeenCalled();
  expect(gateway.actor).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ phase: 'acknowledge' }));
});
test('the staff entry is updated in place without resetting channel permissions or duplicating the message', async () => {
  const edit = jest.fn().mockResolvedValue({ id: 'entry' }),
    send = jest.fn(),
    channel = {
      id: 'staff',
      messages: { fetch: jest.fn().mockResolvedValue({ author: { id: 'bot' }, edit }) },
      send,
    };
  Object.defineProperty(client, 'user', { value: { id: 'bot' }, configurable: true });
  jest.spyOn(gateway, 'staffPanelChannel').mockResolvedValue(channel as unknown as TextChannel);
  const secure = jest.spyOn(gateway, 'securePanel');
  f.repository.set('adminPanel', { channelId: 'staff', messageId: 'entry' });
  await controller.administration.installStaff();
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({
      content: null,
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(secure).not.toHaveBeenCalled();
});

test('panel publication is previewed and confirmed; changed overwrites invalidate that confirmation', async () => {
  const overwrites = new Collection<
    string,
    { id: string; type: number; allow: { bitfield: bigint }; deny: { bitfield: bigint } }
  >();
  const channel = {
      id: 'new-panel',
      name: 'nexus',
      type: 0,
      permissionOverwrites: { cache: overwrites },
    },
    fetch = jest.fn(async () => channel);
  jest.spyOn(gateway, 'guild').mockResolvedValue({ channels: { fetch } } as never);
  const install = jest.spyOn(controller, 'installPanel').mockResolvedValue();
  let view = render({ page: 'panels', target: 'member' });
  view = await run(chosen(view, 'panel-channel', channel.id));
  view = await run(click(view, 'preview'));
  expect(JSON.stringify(view)).toContain('permissions seront remplacées');
  expect(install).not.toHaveBeenCalled();
  overwrites.set('changed', {
    id: 'changed',
    type: 0,
    allow: { bitfield: 1024n },
    deny: { bitfield: 0n },
  });
  const error = await run(click(view, 'confirm'));
  expect(JSON.stringify(error)).toContain('état a changé');
  expect(install).not.toHaveBeenCalled();
  view = await run(click(error, 'preview'));
  await run(click(view, 'confirm'));
  expect(install).toHaveBeenCalledTimes(1);
  expect(install).toHaveBeenCalledWith(channel.id);
});
test('an oversized upload is refused before downloading any bytes', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch'),
    draft = {
      name: 'Game',
      url: 'https://example.com',
      assetId: null,
      rawgId: null,
      back: { page: 'home' } as AdminRoute,
    };
  const upload = click(render({ page: 'prepare', draft }), 'upload');
  await controller.handle(upload as unknown as Interaction);
  const i = submit(
    upload,
    {},
    {
      fields: {
        getUploadedFiles: () =>
          new Collection([
            [
              'large',
              {
                size: 5_000_001,
                url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/large.png',
              },
            ],
          ]),
      },
    },
  );
  const error = await run(i);
  expect(JSON.stringify(error)).toContain('visuel');
  expect(fetcher).not.toHaveBeenCalled();
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('archiving, suspension, resumption and catalogue retirement all finish through the panel', async () => {
  const g = f.add(game()),
    back = { page: 'catalogue', filter: 'all', query: '', index: 0 } as const;
  let view = render({ page: 'game', id: g.id, back });
  view = await run(click(view, 'block'));
  expect(f.repository.game(g.id)?.blocked).toBe(false);
  view = await run(click(view, 'confirm'));
  expect(f.repository.game(g.id)?.blocked).toBe(true);
  view = await run(click(view, 'unblock'));
  view = await run(click(view, 'confirm'));
  expect(f.repository.game(g.id)?.blocked).toBe(false);
  view = await run(click(view, 'archive'));
  view = await run(click(view, 'confirm'));
  expect(f.repository.game(g.id)?.state).toBe('archived');
  view = await run(click(view, 'retire'));
  expect(JSON.stringify(view)).toContain('ne libère pas de salon physique');
  view = await run(click(view, 'confirm'));
  expect(f.repository.game(g.id)?.retired).toBe(true);
  expect(JSON.stringify(view)).toContain('ont été conservés');
  expect(f.community.deleteRole).not.toHaveBeenCalled();
});

test('cross-guild admin interactions never read sensitive state or call Discord', async () => {
  const i = { ...button('na:home'), guildId: 'other-guild' };
  await controller.handle(i as unknown as Interaction);
  expect(i.deferReply).not.toHaveBeenCalled();
  expect(gateway.actor).not.toHaveBeenCalled();
  expect(controls(i.reply.mock.calls[0]![0])).toHaveLength(0);
});

test('a deleted staff-channel default still allows choosing a new panel destination', async () => {
  const fetch = jest
    .fn()
    .mockRejectedValue(Object.assign(new Error('Unknown channel'), { code: 10003 }));
  jest.spyOn(gateway, 'guild').mockResolvedValue({ channels: { fetch } } as never);
  const view = await run(click(render({ page: 'panels', target: 'member' }), 'panel-staff'));
  expect(nodes(view).some((n) => n.type === ComponentType.ChannelSelect)).toBe(true);
  expect(JSON.stringify(view)).toContain('déjà privé');
  expect(controls(view).find((n) => n.custom_id?.includes(':preview:'))?.disabled).toBe(true);
});
test('changing a RAWG search preserves the last query rather than clearing the form', async () => {
  const draft = {
      name: '',
      url: '',
      assetId: null,
      rawgId: null,
      back: { page: 'home' } as AdminRoute,
    },
    view = render({ page: 'results', draft, query: 'Project Zomboid', items: [] }),
    i = click(view, 'rawg');
  await controller.handle(i as unknown as Interaction);
  expect(JSON.stringify(i.showModal.mock.calls)).toContain('Project Zomboid');
  expect(i.deferUpdate).not.toHaveBeenCalled();
});

test('admin RAWG searches can repeat during testing without consuming member search counters', async () => {
  const key = `search:${admin.id}`,
    recent = Array(5).fill(Date.now());
  f.repository.set(key, recent);
  const draft = {
    name: '',
    url: '',
    assetId: null,
    rawgId: null,
    back: { page: 'home' } as AdminRoute,
  };
  let view = render({ page: 'prepare', draft });
  for (let i = 0; i < 6; i++) {
    const search = click(view, 'rawg');
    await controller.handle(search as unknown as Interaction);
    view = await run(submit(search, { query: `Game ${i}` }));
  }
  expect(f.catalogue.search).toHaveBeenCalledTimes(6);
  expect(f.repository.get(key)).toEqual(recent);
});

test('an admin can request details on their own game using real SDK Label parsing; cancel and back stay distinct', async () => {
  const p = await f.nexus.propose(admin, 'Half Life 2', 'https://example.com/half-life-2', 'fr');
  const detail = render({
      page: 'request',
      id: p.id,
      back: { page: 'requests', filter: 'all', query: 'Half', index: 0 },
    }),
    open = click(detail, 'clarify');
  await controller.handle(open as unknown as Interaction);
  const modal = JSON.parse(JSON.stringify(open.showModal.mock.calls[0]![0]));
  const sdk = Reflect.construct(ModalSubmitInteraction, [
    client,
    {
      id: '100000000000000123',
      application_id: '100000000000000124',
      type: 5,
      token: 'test-only',
      version: 1,
      locale: 'fr',
      guild_locale: 'fr',
      guild_id: gateway.config.guildId,
      entitlements: [],
      authorizing_integration_owners: {},
      user: { id: admin.id, username: 'admin', discriminator: '0', avatar: null },
      data: {
        custom_id: modal.custom_id,
        components: [
          {
            type: 18,
            id: 1,
            component: {
              type: 4,
              id: 2,
              custom_id: 'reason',
              value: 'Merci de confirmer la bonne édition.',
            },
          },
        ],
      },
    },
  ]) as ModalSubmitInteraction;
  const submitted = { ...submit(open, {}), fields: sdk.fields };
  const review = await run(submitted);
  assertUniqueCustomIds(review);
  expect(actionId(review, 'cancel', 'na')).not.toBe(actionId(review, 'back', 'na'));
  await run(click(review, 'cancel'));
  expect(f.repository.proposal(p.id)?.status).toBe('pending');
  await run(click(review, 'confirm'));
  expect(f.repository.proposal(p.id)).toMatchObject({
    status: 'needs_info',
    reason: 'Merci de confirmer la bonne édition.',
  });
  expect(log.error).not.toHaveBeenCalled();
});
test('identity validation clearly shows the remaining image step before an approval is ready', async () => {
  const p = await f.nexus.propose(admin, 'Half Life 2', 'https://example.com', 'fr');
  let view = await run(
    click(render({ page: 'request', id: p.id, back: { page: 'home' } }), 'approve'),
  );
  const identity = click(view, 'identity');
  await controller.handle(identity as unknown as Interaction);
  view = await run(submit(identity, { name: 'Half Life 2', url: 'https://example.com' }));
  expect(JSON.stringify(view)).toContain('Nom et lien validés');
  expect(JSON.stringify(view)).toContain('Visuel manquant');
  expect(JSON.stringify(view)).toContain('Il reste à choisir un visuel');
  expect(controls(view).find((n) => n.custom_id?.includes(':preview:'))?.disabled).toBe(true);
  const parent = f.add(game());
  view = await run(click(view, 'parent'));
  view = await run(chosen(view, 'parent-game', parent.id));
  expect(JSON.stringify(view)).toContain('Visuel prêt');
  expect(JSON.stringify(view)).toContain('Tout est renseigné');
  expect(controls(view).find((n) => n.custom_id?.includes(':preview:'))?.disabled).toBe(false);
});
test('a blank clarification reason is rejected before rendering an empty Text Display', async () => {
  const p = await f.nexus.propose(admin, 'A game', 'https://example.com', 'fr'),
    open = click(render({ page: 'request', id: p.id, back: { page: 'home' } }), 'clarify');
  await controller.handle(open as unknown as Interaction);
  const view = await run(submit(open, { reason: '   ' }));
  expect(JSON.stringify(view)).toContain('Vérifie les informations');
  expect(f.repository.proposal(p.id)?.status).toBe('pending');
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'invalidInput', action: 'clarify', page: 'request' }),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test('diagnostic shows immediate waiting, resource and game progress before its final result', async () => {
  f.add(game());
  const actorGate = deferred<typeof admin>(),
    visible = deferred<void>();
  jest.mocked(gateway.actor).mockReturnValueOnce(actorGate.promise);
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  i.editReply.mockImplementation(async (payload) => {
    assertUniqueCustomIds(payload);
    visible.resolve();
  });
  const pending = controller.handle(i as unknown as Interaction);
  await visible.promise;
  expect(JSON.stringify(response(i))).toContain('Vérification en cours');
  expect(controls(response(i)).find((n) => n.custom_id?.includes(':diagnose:'))?.disabled).toBe(
    true,
  );
  expect(actionId(response(i), 'home', 'na')).toBeDefined();
  expect(f.community.snapshot).not.toHaveBeenCalled();
  actorGate.resolve(admin);
  await pending;
  const updates = JSON.stringify(i.editReply.mock.calls);
  expect(updates).toContain('Lecture des salons');
  expect(updates).toContain('0 / 1 jeux vérifiés');
  expect(updates).toContain('1 / 1 jeux vérifiés');
  expect(JSON.stringify(response(i))).toContain('Vérification terminée');
  expect(controls(response(i)).find((n) => n.custom_id?.includes(':diagnose:'))?.disabled).toBe(
    false,
  );
  expect(f.community.move).not.toHaveBeenCalled();
});
test('leaving a running scan stops remaining games and never brings the old diagnostic back', async () => {
  f.add(game());
  f.add(
    game({
      id: 'second',
      name: 'Another game',
      channelId: 'second-channel',
      roleId: 'second-role',
    }),
  );
  const gate = deferred<{ at: number | null; complete: boolean }>(),
    entered = deferred<void>();
  f.community.activity.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  const pending = controller.handle(i as unknown as Interaction);
  await entered.promise;
  const updates = i.editReply.mock.calls.length;
  const home = await run(click(response(i), 'home'));
  expect(actionId(home, 'requests', 'na')).toBeDefined();
  gate.resolve({ at: null, complete: true });
  await pending;
  expect(i.editReply).toHaveBeenCalledTimes(updates);
  expect(f.community.activity).toHaveBeenCalledTimes(1);
  expect(log.error).not.toHaveBeenCalled();
});
test('a late diagnostic failure cannot replace a more recently opened menu', async () => {
  const gate = deferred<typeof f.community.world>(),
    entered = deferred<void>();
  f.community.snapshot.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  const pending = controller.handle(i as unknown as Interaction);
  await entered.promise;
  const count = i.editReply.mock.calls.length;
  const newer = click(response(i), 'home');
  await run(newer);
  gate.reject(new Error('private API failure'));
  await pending;
  expect(i.editReply).toHaveBeenCalledTimes(count);
  expect(JSON.stringify(response(newer))).not.toContain('échoué');
  expect(actionId(response(newer), 'catalogue', 'na')).toBeDefined();
});
test('an on-screen diagnostic failure explains retry and keeps navigation available', async () => {
  f.community.snapshot.mockRejectedValueOnce(new Error('private API failure'));
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  const result = await run(i);
  expect(JSON.stringify(result)).toContain('La vérification a échoué');
  expect(JSON.stringify(result)).toContain('Tu peux réessayer');
  expect(JSON.stringify(result)).not.toContain('private API failure');
  expect(actionId(result, 'home', 'na')).toBeDefined();
  expect(controls(result).find((n) => n.custom_id?.includes(':diagnose:'))?.disabled).toBe(false);
  expect(log.error).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'diagnose', page: 'maintenance' }),
  );
});
test('navigation in another private message does not cancel the first message diagnostic', async () => {
  const gate = deferred<typeof f.community.world>(),
    entered = deferred<void>();
  f.community.snapshot.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  const pending = controller.handle(i as unknown as Interaction);
  await entered.promise;
  const other = button('na:home');
  other.message = { ...other.message, id: 'other-private-message' };
  await run(other);
  gate.resolve(f.community.world);
  await pending;
  expect(JSON.stringify(response(i))).toContain('Vérification terminée');
  expect(actionId(response(other), 'requests', 'na')).toBeDefined();
});
test('a slow in-flight edit finishes before a newer page can edit the same private message', async () => {
  const gate = deferred<void>(),
    entered = deferred<void>();
  const original = render({ page: 'maintenance' }),
    i = click(original, 'diagnose');
  i.editReply.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
  });
  const pending = controller.handle(i as unknown as Interaction);
  await entered.promise;
  const newer = click(original, 'home');
  const navigation = controller.handle(newer as unknown as Interaction);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(newer.editReply).not.toHaveBeenCalled();
  gate.resolve();
  await Promise.all([pending, navigation]);
  expect(actionId(response(newer), 'requests', 'na')).toBeDefined();
  expect(f.community.snapshot).not.toHaveBeenCalled();
});

test('a scan visibly waits for the shared mutex and leaving cancels the queued read', async () => {
  const gate = deferred<void>(),
    locked = deferred<void>(),
    visible = deferred<void>();
  const background = f.nexus.mutex.run(async () => {
    locked.resolve();
    await gate.promise;
  });
  await locked.promise;
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  i.editReply.mockImplementation(async () => {
    visible.resolve();
  });
  const pending = controller.handle(i as unknown as Interaction);
  await visible.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(JSON.stringify(response(i))).toContain('attente de la fin des opérations');
  expect(f.community.snapshot).not.toHaveBeenCalled();
  await run(click(response(i), 'home'));
  gate.resolve();
  await Promise.all([pending, background]);
  expect(f.community.snapshot).not.toHaveBeenCalled();
});
test('returning to a member menu also invalidates an earlier admin diagnostic', async () => {
  const gate = deferred<typeof f.community.world>(),
    entered = deferred<void>();
  f.community.snapshot.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const i = click(render({ page: 'maintenance' }), 'diagnose');
  const pending = controller.handle(i as unknown as Interaction);
  await entered.promise;
  const count = i.editReply.mock.calls.length;
  const s = session(f.repository, admin.id, 'browse', {});
  const memberHome = button(`nx:home:${s.id}`);
  await run(memberHome);
  gate.resolve(f.community.world);
  await pending;
  expect(i.editReply).toHaveBeenCalledTimes(count);
  expect(JSON.stringify(response(memberHome))).not.toContain('Vérification en cours');
});
