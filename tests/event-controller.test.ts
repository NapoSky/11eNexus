import { Client, MessageFlags, type Interaction } from 'discord.js';
import { Controller } from '../src/presentation/controller.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { eventMessage } from '../src/presentation/event-messages.js';
import { EventViews, eventHome } from '../src/presentation/event-views.js';
import { editView, type View } from '../src/presentation/views.js';
import { translator } from '../src/presentation/i18n.js';
import { eventFixture } from './event-helpers.js';
import { admin, member, game, outsider } from './helpers.js';
import { actionId, assertUniqueCustomIds, controls, nodes, select } from './component-helpers.js';
let f: ReturnType<typeof eventFixture>,
  controller: Controller,
  client: Client,
  gateway: DiscordCommunity;
const log = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
};
beforeEach(() => {
  f = eventFixture();
  client = new Client({ intents: [] });
  gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' }),
    f.repository,
  );
  jest.spyOn(gateway, 'actor').mockImplementation(async (id) => (id === admin.id ? admin : member));
  controller = new Controller(f.nexus, gateway, log, f.events);
  for (const method of Object.values(log)) method.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await client.destroy();
  f.repository.close();
});
function button(customId: string, user = admin, privateMessage = true) {
  return {
    customId,
    id: '100000000000000123',
    createdTimestamp: Date.now(),
    guildId: gateway.config.guildId,
    locale: 'fr',
    user: { id: user.id },
    member: {
      roles: user.admin
        ? [gateway.config.adminRoleId]
        : user.member
          ? [gateway.config.memberRoleId]
          : [],
    },
    guild: { ownerId: admin.id },
    message: {
      id: 'same-private-message',
      flags: { has: (flag: number) => privateMessage && flag === MessageFlags.Ephemeral },
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
    reply: jest.fn<Promise<void>, [unknown]>(async (payload) => {
      assertUniqueCustomIds(payload);
    }),
    editReply: jest.fn<Promise<void>, [unknown]>(async (payload) => {
      assertUniqueCustomIds(payload);
    }),
    showModal: jest.fn<Promise<void>, [unknown]>(async (payload) => {
      JSON.stringify(payload);
    }),
  };
}
const response = (i: ReturnType<typeof button>) => i.editReply.mock.calls.at(-1)![0] as View;
const click = (view: unknown, action: string) => button(actionId(view, action, 'ne'));
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
function submit(i: ReturnType<typeof button>, values: Record<string, string>) {
  const modal = JSON.parse(JSON.stringify(i.showModal.mock.calls[0]![0]));
  return {
    ...button(modal.custom_id),
    isButton: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    fields: { getTextInputValue: (id: string) => values[id] },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('admin hub links into the same private V2 event flow; creating needs a reviewed preview', async () => {
  const hub = controller.administration.views.render(admin, 'fr');
  expect(controls(hub).some((c) => c.custom_id === 'ne:home')).toBe(true);
  const home = await run(button('ne:home')),
    games = await run(click(home, 'create'));
  const choose = chosen(games, 'game', f.parent.id);
  await controller.handle(choose as unknown as Interaction);
  expect(choose.showModal).toHaveBeenCalledTimes(1);
  expect(choose.deferReply).not.toHaveBeenCalled();
  expect(choose.deferUpdate).not.toHaveBeenCalled();
  const modal = JSON.parse(JSON.stringify(choose.showModal.mock.calls[0]![0]));
  expect(modal.components.some((n: { type: number }) => n.type === 18)).toBe(true);
  const form = submit(choose, { name: 'Campagne PZ', description: 'Une campagne ensemble.' });
  const preview = await run(form);
  expect(form.deferUpdate).toHaveBeenCalledTimes(1);
  expect(f.repository.events()).toHaveLength(0);
  expect(f.eventCommunity.publish).not.toHaveBeenCalled();
  expect(JSON.stringify(preview)).toContain('Aucun ping automatique');
  const done = await run(click(preview, 'confirm'));
  expect(f.repository.events()).toHaveLength(1);
  expect(JSON.stringify(done)).toContain('Campagne PZ');
  expect(f.eventCommunity.pin).toHaveBeenCalledTimes(1);
  expect(editView(done)).toMatchObject({
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
});
test('acknowledgement precedes even a deliberately blocked fresh authorization', async () => {
  const gate = deferred<typeof admin>(),
    i = button('ne:home');
  jest.mocked(gateway.actor).mockImplementationOnce(async () => {
    expect(i.deferUpdate).toHaveBeenCalledTimes(1);
    return gate.promise;
  });
  const pending = controller.handle(i as unknown as Interaction);
  expect(i.deferUpdate).toHaveBeenCalledTimes(1);
  expect(f.eventCommunity.inspect).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(i.editReply).not.toHaveBeenCalled();
  gate.resolve(admin);
  await pending;
  expect(i.editReply).toHaveBeenCalledTimes(1);
});
test('opening a modal makes no network calls and validates SDK builders immediately', async () => {
  const route = controller.eventController.views.admin(admin, 'fr', {
    page: 'games',
    query: '',
    index: 0,
  });
  const i = chosen(route, 'game', f.parent.id);
  jest.mocked(gateway.actor).mockRejectedValue(new Error('network must not run'));
  await controller.handle(i as unknown as Interaction);
  expect(i.showModal).toHaveBeenCalledTimes(1);
  expect(gateway.actor).not.toHaveBeenCalled();
  expect(f.eventCommunity.inspect).not.toHaveBeenCalled();
});
test('a slow response cannot overwrite newer navigation, including navigation back to the main admin hub', async () => {
  const gate = deferred<typeof admin>(),
    slow = button('ne:home');
  jest.mocked(gateway.actor).mockImplementationOnce(() => gate.promise);
  const pending = controller.handle(slow as unknown as Interaction);
  await Promise.resolve();
  const recent = await run(button('ne:home'));
  expect(recent).toBeDefined();
  gate.resolve(admin);
  await pending;
  expect(slow.editReply).not.toHaveBeenCalled();
  const gate2 = deferred<typeof admin>(),
    slow2 = button('ne:home');
  jest.mocked(gateway.actor).mockImplementationOnce(() => gate2.promise);
  const pending2 = controller.handle(slow2 as unknown as Interaction);
  await Promise.resolve();
  const adminId = controls(recent).find((c) => c.custom_id?.startsWith('na:home:'))!.custom_id!;
  await controller.handle(button(adminId) as unknown as Interaction);
  gate2.resolve(admin);
  await pending2;
  expect(slow2.editReply).not.toHaveBeenCalled();
});
test('a public pinned button opens localized ephemeral controls and never edits the shared message', async () => {
  const event = await f.create(),
    publicView = eventMessage(event);
  const i = { ...button(actionId(publicView, 'subscribe', 'ne'), member, false), locale: 'en-US' };
  const view = await run(i);
  expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(i.deferUpdate).not.toHaveBeenCalled();
  expect(JSON.stringify(view)).toContain(translator('en')('e.notificationsOff'));
  const enable = { ...button(actionId(view, 'enable', 'ne'), member), locale: 'en-US' };
  await run(enable);
  expect(await f.eventCommunity.subscribed(event.roleId!, member.id)).toBe(true);
  expect(f.eventCommunity.updateMessage).not.toHaveBeenCalled();
});
test('a session owner, current membership, event state and guild are checked before subscription mutations', async () => {
  const event = await f.create(),
    publicId = actionId(eventMessage(event), 'subscribe', 'ne');
  const view = await run(button(publicId, member, false));
  const foreign = button(actionId(view, 'enable', 'ne'), admin);
  await controller.handle(foreign as unknown as Interaction);
  expect(f.eventCommunity.subscribe).not.toHaveBeenCalled();
  const wrongGuild = { ...button(publicId, member, false), guildId: 'another-guild' };
  await controller.handle(wrongGuild as unknown as Interaction);
  expect(wrongGuild.deferReply).not.toHaveBeenCalled();
  const revoked = button(publicId, member, false);
  jest.mocked(gateway.actor).mockResolvedValueOnce(outsider);
  await controller.handle(revoked as unknown as Interaction);
  expect(controls(response(revoked))).toHaveLength(0);
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'close', eventId: event.id }));
  const old = button(publicId, member, false);
  const closed = await run(old);
  expect(JSON.stringify(closed)).toContain('terminé');
  expect(f.eventCommunity.subscribe).not.toHaveBeenCalled();
});
test('an expired preview can be refreshed without recreating an event or losing its draft', async () => {
  const plan = await f.events.plan(admin, {
    kind: 'create',
    draft: { gameId: f.parent.id, name: 'My draft', description: 'Keep this text' },
  });
  const view = controller.eventController.views.admin(admin, 'fr', {
    page: 'confirm',
    plan,
    back: eventHome(),
  });
  f.clock.at += 5 * 60000;
  const failed = await run(click(view, 'confirm'));
  expect(JSON.stringify(failed)).toContain('My draft');
  expect(actionId(failed, 'refresh', 'ne')).toBeTruthy();
  const refreshed = await run(click(failed, 'refresh'));
  await run(click(refreshed, 'confirm'));
  expect(f.repository.events()[0]?.description).toBe('Keep this text');
});
test.each(['fr', 'en'] as const)(
  '%s pagination, public controls and long descriptions stay within V2 limits',
  async (language) => {
    for (let i = 0; i < 25; i++) f.add(game({ name: `Game ${i}` }));
    const views = new EventViews(f.repository, gateway.config.guildId),
      games = views.admin(admin, language, { page: 'games', query: '', index: 0 });
    expect(select(games)).toHaveLength(20);
    expect(actionId(games, 'next', 'ne')).toBeTruthy();
    const event = await f.create('A'.repeat(80));
    event.description = '*'.repeat(1000);
    f.repository.saveEvent(event);
    const screens = [
      games,
      eventMessage(event),
      views.admin(admin, language, { page: 'detail', id: event.id, back: eventHome() }),
      views.notifications(member, language, event, false),
    ];
    for (const screen of screens) {
      assertUniqueCustomIds(screen);
      expect(nodes(screen).length).toBeLessThanOrEqual(40);
      expect(screen.allowedMentions).toEqual({ parse: [] });
      for (const node of nodes(screen)) {
        if (node.content) expect(node.content.length).toBeLessThanOrEqual(4000);
        if (node.custom_id) expect(node.custom_id.length).toBeLessThanOrEqual(100);
      }
    }
  },
);
test('an API or interaction token error never produces a second initial acknowledgement', async () => {
  const i = button('ne:home');
  jest.mocked(gateway.actor).mockRejectedValueOnce({ code: 10062 });
  await controller.handle(i as unknown as Interaction);
  expect(i.deferUpdate).toHaveBeenCalledTimes(1);
  expect(i.reply).not.toHaveBeenCalled();
  expect(i.editReply).not.toHaveBeenCalled();
  const broken = button('ne:home');
  broken.deferUpdate.mockRejectedValueOnce(new Error('transport'));
  await controller.handle(broken as unknown as Interaction);
  expect(broken.deferUpdate).toHaveBeenCalledTimes(1);
  expect(broken.reply).not.toHaveBeenCalled();
});
test('a slow mutex wait is acknowledged and newer navigation wins when the preview finally completes', async () => {
  const gate = deferred<void>(),
    held = f.nexus.mutex.run(() => gate.promise);
  const route = controller.eventController.views.admin(admin, 'fr', {
    page: 'games',
    query: '',
    index: 0,
  });
  const choose = chosen(route, 'game', f.parent.id);
  await controller.handle(choose as unknown as Interaction);
  const form = submit(choose, { name: 'Slow draft', description: 'Still waiting' });
  const pending = controller.handle(form as unknown as Interaction);
  expect(form.deferUpdate).toHaveBeenCalledTimes(1);
  await run(button('ne:home'));
  gate.resolve();
  await held;
  await pending;
  expect(
    form.editReply.mock.calls.some(([payload]) =>
      JSON.stringify(payload).includes('Vérifier avant de confirmer'),
    ),
  ).toBe(false);
  expect(f.eventCommunity.createChannel).not.toHaveBeenCalled();
});
test('forum tags are chosen in the private preview before creating resources', async () => {
  const source = f.eventCommunity.world.channels.find((c) => c.id === f.parent.channelId)!;
  source.type = 15;
  source.requiresTag = true;
  source.tags = [{ id: 'tag', name: 'Campagnes' }];
  const plan = await f.events.plan(admin, {
    kind: 'create',
    draft: { gameId: f.parent.id, name: 'Forum event', description: 'Hello' },
  });
  const preview = controller.eventController.views.admin(admin, 'fr', {
    page: 'confirm',
    plan,
    back: eventHome(),
  });
  expect(controls(preview).find((c) => c.custom_id?.startsWith('ne:confirm:'))?.disabled).toBe(
    true,
  );
  const chosenPreview = await run(chosen(preview, 'announcement-tag', 'tag'));
  expect(
    controls(chosenPreview).find((c) => c.custom_id?.startsWith('ne:confirm:'))?.disabled,
  ).toBe(false);
  await run(click(chosenPreview, 'confirm'));
  expect(f.repository.events()[0]?.announcementTagId).toBe('tag');
});
test('an admin can close without approving a destructive cleanup, leaving the channel hidden for later archiving', async () => {
  const event = await f.create();
  Array.from({ length: 50 }, (_, i) => f.archived(i + 1));
  const plan = await f.events.plan(admin, { kind: 'close', eventId: event.id });
  const preview = controller.eventController.views.admin(admin, 'fr', {
    page: 'confirm',
    plan,
    back: eventHome(),
  });
  const closeOnly = await run(click(preview, 'close-only'));
  expect(JSON.stringify(closeOnly)).not.toContain('seront supprimés définitivement');
  await run(click(closeOnly, 'confirm'));
  expect(f.repository.event(event.id)?.state).toBe('closed');
  expect(f.eventCommunity.world.channels.find((c) => c.id === event.channelId)?.hidden).toBe(true);
  expect(f.eventCommunity.deleteChannel).not.toHaveBeenCalled();
});
