import { Client, type Interaction, type TextChannel, MessageFlags } from 'discord.js';
import { Controller } from '../src/presentation/controller.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { nodes, controls, select, actionId } from './component-helpers.js';
import { session } from '../src/presentation/views.js';
import { admin, fixture, game, member } from './helpers.js';

const log = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
};

let f: ReturnType<typeof fixture>;
let controller: Controller;
let gateway: DiscordCommunity;
let client: Client;
beforeEach(() => {
  f = fixture();
  client = new Client({ intents: [] });
  gateway = new DiscordCommunity(
    client,
    config({ BOT_TOKEN: 'test', GUILD_ID: '100000000000000000' }),
    f.repository,
  );
  controller = new Controller(f.nexus, gateway, log);
  for (const method of Object.values(log)) method.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await client.destroy();
  f.repository.close();
});
function button(customId: string, roleIds = [gateway.config.memberRoleId]) {
  return {
    customId,
    id: '100000000000000123',
    createdTimestamp: Date.now(),
    guildId: gateway.config.guildId,
    locale: 'fr',
    user: { id: member.id },
    member: { roles: roleIds },
    guild: { ownerId: admin.id },
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
    editReply: jest.fn<Promise<void>, [unknown]>(async () => {}),
    reply: jest.fn<Promise<void>, [unknown]>(async () => {}),
    showModal: jest.fn<Promise<void>, [unknown]>(async () => {}),
  };
}
test('the public panel opens an ephemeral localized catalogue without editing its message', async () => {
  const i = button('nx:games');
  await controller.handle(i as unknown as Interaction);
  expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(i.deferUpdate).not.toHaveBeenCalled();
  expect(i.editReply).toHaveBeenCalledWith(
    expect.objectContaining({ allowedMentions: { parse: [] } }),
  );
  expect(JSON.stringify(i.editReply.mock.calls)).toContain('Jeux');
});
test('the published panel includes a persistent Archives entry and never pings members', async () => {
  const send = jest
    .fn<Promise<{ id: string }>, [unknown]>()
    .mockResolvedValue({ id: 'panel-message' });
  jest
    .spyOn(gateway, 'panelChannel')
    .mockResolvedValue({ id: 'panel-channel', send } as unknown as TextChannel);
  jest.spyOn(gateway, 'securePanel').mockResolvedValue();
  await controller.installPanel('panel-channel');
  const payload = JSON.parse(JSON.stringify(send.mock.calls[0]![0]));
  const buttons = controls(payload);
  expect(buttons.map((c) => c.custom_id)).toContain('nx:archives');
  expect(buttons).toHaveLength(4);
  expect(payload.allowedMentions).toEqual({ parse: [] });
});
test('a visitor without Syndiqué receives a private refusal before any domain action', async () => {
  const i = button('nx:games', []);
  await controller.handle(i as unknown as Interaction);
  expect(i.reply).toHaveBeenCalledWith(
    expect.objectContaining({ flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }),
  );
  expect(i.editReply).not.toHaveBeenCalled();
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('search opens a localized modal immediately without deferring it', async () => {
  const i = button('nx:propose');
  await controller.handle(i as unknown as Interaction);
  expect(i.showModal).toHaveBeenCalledTimes(1);
  expect(i.deferReply).not.toHaveBeenCalled();
  expect(JSON.stringify(i.showModal.mock.calls)).toContain('Ajouter un jeu');
});
test('another member cannot operate a personal session even with a valid token', async () => {
  const s = session(f.repository, 'other', 'game', { gameId: 'x' });
  const i = button(`nx:activate:${s.id}`);
  await controller.handle(i as unknown as Interaction);
  expect(i.reply).toHaveBeenCalledWith(
    expect.objectContaining({ flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }),
  );
  expect(f.community.move).not.toHaveBeenCalled();
});
test('a revoked Syndiqué role is detected through fresh REST before an activation', async () => {
  const g = f.add(game({ state: 'archived' }));
  const s = session(f.repository, member.id, 'game', { gameId: g.id });
  const i = button(`nx:activate:${s.id}`);
  jest.spyOn(gateway, 'actor').mockResolvedValue({ ...member, member: false });
  await controller.handle(i as unknown as Interaction);
  expect(i.deferUpdate).toHaveBeenCalled();
  expect(f.community.move).not.toHaveBeenCalled();
  expect(controls(i.editReply.mock.calls[0]![0])).toHaveLength(0);
});
test('activation through a personal card changes its channel and renders the result privately', async () => {
  const g = f.add(game({ state: 'archived' }));
  const s = session(f.repository, member.id, 'game', { gameId: g.id });
  const i = button(`nx:activate:${s.id}`);
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  await controller.handle(i as unknown as Interaction);
  expect(f.repository.game(g.id)?.state).toBe('active');
  expect(i.editReply).toHaveBeenCalled();
  expect(i.reply).not.toHaveBeenCalled();
});
test('members cannot open the administration proposals view through a forged action', async () => {
  const s = session(f.repository, member.id, 'browse', {});
  const i = button(`nx:admin:${s.id}`);
  await controller.handle(i as unknown as Interaction);
  expect(controls(i.reply.mock.calls[0]![0])).toHaveLength(0);
  expect(JSON.stringify(i.reply.mock.calls)).toContain('administrateurs');
});
test('archives opens the archived catalogue privately without searching RAWG', async () => {
  f.add(game({ name: 'Active game' }));
  f.add(game({ name: 'Archived game', state: 'archived' }));
  const i = button('nx:archives');
  await controller.handle(i as unknown as Interaction);
  const response = JSON.stringify(i.editReply.mock.calls);
  expect(response).toContain('Archived game');
  expect(response).not.toContain('Active game');
  expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(f.catalogue.search).not.toHaveBeenCalled();
});
test('selecting Archived in the catalogue filter displays games outside the active list', async () => {
  const s = session(f.repository, member.id, 'browse', {
    mode: 'active',
    page: 0,
    query: '',
    ids: [],
  });
  f.add(game({ name: 'Archived title', state: 'archived' }));
  const i = {
    ...button(`nx:filter:${s.id}`),
    values: ['archived'],
    isButton: () => false,
    isStringSelectMenu: () => true,
  };
  await controller.handle(i as unknown as Interaction);
  expect(i.deferUpdate).toHaveBeenCalled();
  expect(JSON.stringify(i.editReply.mock.calls)).toContain('Archived title');
});
test.each([10062, 40060, 50027])(
  'a rejected acknowledgement (%s) never triggers a second callback',
  async (code) => {
    const i = button('nx:games');
    i.createdTimestamp = Date.now() - 4000;
    const error = Object.assign(new Error('private interaction URL and token'), {
      code,
      status: 404,
    });
    i.deferReply.mockRejectedValueOnce(error);
    await controller.handle(i as unknown as Interaction);
    expect(i.reply).not.toHaveBeenCalled();
    expect(i.editReply).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'acknowledge',
        action: 'games',
        interactionAgeMs: expect.any(Number),
        receivedAgeMs: expect.any(Number),
        err: error,
      }),
    );
    expect(f.community.move).not.toHaveBeenCalled();
  },
);
test('a failed personal acknowledgement prevents mutation and logs the failing phase', async () => {
  const g = f.add(game({ state: 'archived' }));
  const s = session(f.repository, member.id, 'game', { gameId: g.id });
  const i = button(`nx:activate:${s.id}`);
  i.deferUpdate.mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 10062 }));
  await controller.handle(i as unknown as Interaction);
  expect(f.community.move).not.toHaveBeenCalled();
  expect(i.reply).not.toHaveBeenCalled();
  expect(i.editReply).not.toHaveBeenCalled();
});
test('a failed modal acknowledgement does not attempt an extra reply', async () => {
  const i = button('nx:propose');
  i.showModal.mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 10062 }));
  await controller.handle(i as unknown as Interaction);
  expect(i.reply).not.toHaveBeenCalled();
  expect(i.deferReply).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ phase: 'show_modal' }));
});
test('an expired personal menu provides a fresh catalogue button instead of warning spam', async () => {
  const s = session(f.repository, member.id, 'game', { gameId: 'old-game' });
  f.repository.saveSession({ ...s, expiresAt: Date.now() - 1 });
  const i = button(`nx:activate:${s.id}`);
  await controller.handle(i as unknown as Interaction);
  expect(JSON.stringify(i.reply.mock.calls)).toContain('nx:home');
  expect(i.reply).toHaveBeenCalledWith(
    expect.objectContaining({
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    }),
  );
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'menu_expired' }));
  expect(f.community.move).not.toHaveBeenCalled();
});
test('editing an expired webhook does not trigger another response attempt', async () => {
  const i = button('nx:games');
  i.editReply.mockRejectedValueOnce(Object.assign(new Error('expired webhook'), { code: 10015 }));
  await controller.handle(i as unknown as Interaction);
  expect(i.editReply).toHaveBeenCalledTimes(1);
  expect(i.reply).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ phase: 'edit_reply' }));
});
test('an expired autocomplete acknowledgement is not retried', async () => {
  const i = {
    ...button('', [gateway.config.adminRoleId]),
    isAutocomplete: () => true,
    options: { getFocused: () => ({ name: 'game', value: '' }) },
    respond: jest.fn().mockRejectedValue(Object.assign(new Error('expired'), { code: 10062 })),
  };
  await controller.handle(i as unknown as Interaction);
  expect(i.respond).toHaveBeenCalledTimes(1);
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'autocomplete_response_failed' }),
  );
});

function response(i: ReturnType<typeof button>) {
  return i.editReply.mock.calls[0]![0];
}
function click(payload: unknown, action: string) {
  return button(actionId(payload, action));
}
function modalSubmit(customId: string, fields: Record<string, string>, fromPrivate = true) {
  return {
    ...button(customId),
    isButton: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    message: { flags: { has: (flag: number) => fromPrivate && flag === MessageFlags.Ephemeral } },
    fields: { getTextInputValue: (key: string) => fields[key] },
  };
}

test('opening, subscribing and returning preserves archived search and page without revival', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  for (let i = 0; i < 45; i++)
    f.add(game({ name: `Zomboid ${i.toString().padStart(2, '0')}`, state: 'archived' }));
  const browse = controller.views.browse(member, 'fr', 'archived', 1, 'Zomboid');
  const ids = select(browse).map((o) => o.value);
  const choose = {
    ...click(browse, 'game'),
    values: [ids[0]],
    isButton: () => false,
    isStringSelectMenu: () => true,
  };
  await controller.handle(choose as unknown as Interaction);
  const subscribe = click(response(choose), 'subscribe');
  await controller.handle(subscribe as unknown as Interaction);
  expect(f.repository.subscribed(ids[0]!, member.id)).toBe(true);
  expect(f.repository.game(ids[0]!)?.state).toBe('archived');
  const back = click(response(subscribe), 'back');
  await controller.handle(back as unknown as Interaction);
  expect(select(response(back)).map((o) => o.value)).toEqual(ids);
  expect(JSON.stringify(response(back))).toContain('Zomboid');
  const s = f.repository.session(actionId(response(back), 'game').split(':')[2]!)!;
  expect(s.data).toMatchObject({ mode: 'archived', page: 1, query: 'Zomboid' });
  const home = click(response(back), 'home');
  await controller.handle(home as unknown as Interaction);
  expect(JSON.stringify(response(home))).toContain('Jouer ensemble');
  expect(f.community.move).not.toHaveBeenCalled();
  expect(f.catalogue.search).not.toHaveBeenCalled();
});

test('tab navigation and clearing search update one private message', async () => {
  f.add(game({ name: 'Zomboid', state: 'archived' }));
  f.add(game({ name: 'Other' }));
  const first = controller.views.browse(member, 'fr', 'active', 0, 'Zomboid');
  const archived = click(first, 'browse-archived');
  await controller.handle(archived as unknown as Interaction);
  expect(select(response(archived))).toHaveLength(1);
  const clear = click(response(archived), 'clear');
  await controller.handle(clear as unknown as Interaction);
  const token = actionId(response(clear), 'game').split(':')[2]!;
  expect(f.repository.session(token)?.data).toMatchObject({ mode: 'archived', query: '' });
  expect(clear.deferUpdate).toHaveBeenCalledTimes(1);
  expect(clear.deferReply).not.toHaveBeenCalled();
});

test('search modal has labelled help, preserves query and uses modern labels', async () => {
  const source = controller.views.browse(member, 'fr', 'all', 0, 'Zomboid');
  const i = click(source, 'search');
  await controller.handle(i as unknown as Interaction);
  const modal = JSON.parse(JSON.stringify(i.showModal.mock.calls[0]![0]));
  expect(modal.components[0].content).toContain('Ferme cette fenêtre');
  expect(modal.components[1]).toMatchObject({
    type: 18,
    description: expect.any(String),
    component: { type: 4, custom_id: 'query', value: 'Zomboid' },
  });
  expect(modal.components[1].component).not.toHaveProperty('label');
  expect(i.deferUpdate).not.toHaveBeenCalled();
  expect(i.deferReply).not.toHaveBeenCalled();
});

test.each([true, false])(
  'modal from private=%s updates a private menu and never the public panel',
  async (fromPrivate) => {
    jest.spyOn(gateway, 'actor').mockResolvedValue(member);
    const s = session(f.repository, member.id, 'entry', {});
    const i = modalSubmit(`nxm:catalogue:${s.id}`, { query: 'Unknown game' }, fromPrivate);
    await controller.handle(i as unknown as Interaction);
    expect(i.deferUpdate).toHaveBeenCalledTimes(fromPrivate ? 1 : 0);
    expect(i.deferReply).toHaveBeenCalledTimes(fromPrivate ? 0 : 1);
    if (!fromPrivate) expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(response(i)).toMatchObject({
      content: null,
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
    });
    const manual = click(response(i), 'manual');
    await controller.handle(manual as unknown as Interaction);
    const modal = JSON.parse(JSON.stringify(manual.showModal.mock.calls[0]![0]));
    expect(modal.components[1].component.value).toBe('Unknown game');
    expect(modal.components[2].description).toContain('https://');
  },
);

test('successful manual request replaces the private form with status and navigation', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  const s = session(f.repository, member.id, 'candidates', { query: 'A game', ids: [] });
  const i = modalSubmit(`nxm:manual:${s.id}`, { name: 'A game', url: 'https://example.com/game' });
  await controller.handle(i as unknown as Interaction);
  expect(f.repository.proposals(member.id)).toHaveLength(1);
  expect(JSON.stringify(response(i))).toContain('est enregistrée');
  expect(response(i)).toMatchObject({ content: null, embeds: [] });
  const back = click(response(i), 'back');
  await controller.handle(back as unknown as Interaction);
  expect(select(response(back))).toHaveLength(1);
  const home = click(response(back), 'back');
  await controller.handle(home as unknown as Interaction);
  expect(JSON.stringify(response(home))).toContain('Jouer ensemble');
});

test('an accepted request can revive a game and return through its request to the right page', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  const g = f.add(game({ state: 'archived' }));
  const p = {
    id: 'p',
    actorId: member.id,
    name: 'Approved',
    url: 'https://example.com',
    createdAt: 1,
    status: 'accepted' as const,
    reason: null,
    gameId: g.id,
    locale: 'fr' as const,
  };
  f.repository.saveProposal(p);
  const card = controller.views.proposal(member, 'fr', p, {
    kind: 'proposals',
    admin: false,
    page: 0,
  });
  const open = click(card, 'proposal-game');
  await controller.handle(open as unknown as Interaction);
  const revive = click(response(open), 'activate');
  await controller.handle(revive as unknown as Interaction);
  expect(f.repository.game(g.id)?.state).toBe('active');
  const back = click(response(revive), 'back');
  await controller.handle(back as unknown as Interaction);
  expect(actionId(response(back), 'proposal-game')).toBeDefined();
  const requests = click(response(back), 'back');
  await controller.handle(requests as unknown as Interaction);
  expect(select(response(requests))[0]?.value).toBe(p.id);
});

test('a known RAWG match opens its existing game rather than offering another creation', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  const g = f.add(game({ rawgId: 123, name: 'GTFO' }));
  const s = session(f.repository, member.id, 'entry', {});
  const i = modalSubmit(`nxm:catalogue:${s.id}`, { query: 'gtfo' }, false);
  await controller.handle(i as unknown as Interaction);
  expect(JSON.stringify(response(i))).toContain('déjà au catalogue');
  expect(JSON.stringify(response(i))).toContain(g.channelId);
  expect(f.catalogue.search).not.toHaveBeenCalled();
  expect(f.community.createChannel).not.toHaveBeenCalled();
});

test.each([false, true])(
  'setup edits the same existing panel (alreadyV2=%s) and clears legacy fields',
  async (alreadyV2) => {
    const edit = jest.fn().mockResolvedValue({ id: 'existing-panel' });
    const existing = {
      id: 'existing-panel',
      author: { id: 'bot' },
      flags: alreadyV2 ? MessageFlags.IsComponentsV2 : 0,
      edit,
    };
    const send = jest.fn();
    Object.defineProperty(client, 'user', { value: { id: 'bot' }, configurable: true });
    jest.spyOn(gateway, 'panelChannel').mockResolvedValue({
      id: 'panel-channel',
      messages: { fetch: jest.fn().mockResolvedValue(existing) },
      send,
    } as unknown as TextChannel);
    jest.spyOn(gateway, 'securePanel').mockResolvedValue();
    f.repository.set('panel', { channelId: 'panel-channel', messageId: 'existing-panel' });
    await controller.installPanel();
    const payload = JSON.parse(JSON.stringify(edit.mock.calls[0]![0]));
    expect(payload).toMatchObject({
      content: null,
      embeds: [],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    expect(payload.files).toHaveLength(2);
    expect(JSON.stringify(payload.components)).toContain('attachment://logo_nexus.png');
    expect(JSON.stringify(payload.components)).toContain('attachment://banner_nexus.png');
    expect(send).not.toHaveBeenCalled();
    expect(f.repository.get('panel')).toEqual({
      channelId: 'panel-channel',
      messageId: 'existing-panel',
    });
  },
);

test('moving a V2 public panel keeps its irreversible flag and a navigation link', async () => {
  const oldEdit = jest.fn().mockResolvedValue({ id: 'old' });
  const send = jest.fn().mockResolvedValue({ id: 'new' });
  Object.defineProperty(client, 'user', { value: { id: 'bot' }, configurable: true });
  jest
    .spyOn(gateway, 'panelChannel')
    .mockResolvedValue({ id: 'new-channel', send } as unknown as TextChannel);
  jest.spyOn(gateway, 'securePanel').mockResolvedValue();
  jest.spyOn(gateway, 'guild').mockResolvedValue({
    channels: {
      fetch: jest.fn().mockResolvedValue({
        messages: {
          fetch: jest.fn().mockResolvedValue({ author: { id: 'bot' }, edit: oldEdit }),
        },
      }),
    },
  } as never);
  f.repository.set('panel', { channelId: 'old-channel', messageId: 'old' });
  await controller.installPanel('new-channel');
  const old = oldEdit.mock.calls[0]![0];
  expect(old).toMatchObject({ content: null, embeds: [], flags: MessageFlags.IsComponentsV2 });
  expect(nodes(old).some((n) => n.url?.endsWith('/new-channel'))).toBe(true);
  expect(controls(old)).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(1);
});

test('RAWG selection previews a game and creates only on confirmation without subscription or ping', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  const start = controller.views.candidates(member, 'en', 'Wardogs', [await f.catalogue.get(123)]);
  const choose = {
    ...click(start, 'candidate'),
    locale: 'en-US',
    values: ['123'],
    isButton: () => false,
    isStringSelectMenu: () => true,
  };
  await controller.handle(choose as unknown as Interaction);
  expect(f.community.createChannel).not.toHaveBeenCalled();
  expect(JSON.stringify(response(choose))).toContain('Is this the right game?');
  expect(controls(response(choose)).find((n) => n.custom_id?.includes(':create:'))?.disabled).toBe(
    false,
  );
  const create = { ...click(response(choose), 'create'), locale: 'en-US' };
  await controller.handle(create as unknown as Interaction);
  const g = f.repository.byRawg(123)!;
  expect(g).toBeDefined();
  expect(g.state).toBe('active');
  expect(f.community.createChannel).toHaveBeenCalledTimes(1);
  expect(f.repository.subscribed(g.id, member.id)).toBe(false);
  expect(response(create)).toMatchObject({
    flags: MessageFlags.IsComponentsV2,
    content: null,
    embeds: [],
    allowedMentions: { parse: [] },
  });
  expect(JSON.stringify(response(create))).toContain('has been added');
  const home = click(response(create), 'home');
  await controller.handle(home as unknown as Interaction);
  expect(actionId(response(home), 'games')).toBeDefined();
});

test('recoverable errors remain V2 and offer a safe return to the catalogue', async () => {
  jest.spyOn(gateway, 'actor').mockResolvedValue(member);
  const g = f.add(game({ state: 'archived', blocked: true }));
  const view = controller.views.game(member, 'fr', g.id, undefined, {
    kind: 'browse',
    mode: 'archived',
    page: 0,
    query: '',
  });
  const i = click(view, 'activate');
  await controller.handle(i as unknown as Interaction);
  expect(response(i)).toMatchObject({
    flags: MessageFlags.IsComponentsV2,
    content: null,
    embeds: [],
  });
  expect(JSON.stringify(response(i))).toContain('indisponible');
  const back = click(response(i), 'back');
  await controller.handle(back as unknown as Interaction);
  expect(select(response(back))[0]?.value).toBe(g.id);
  expect(f.community.move).not.toHaveBeenCalled();
});

test.each([true, false])(
  'member-panel RAWG searches respect current admin=%s rather than old counters',
  async (isAdmin) => {
    const actor = { ...member, admin: isAdmin },
      recent = Array(5).fill(Date.now()),
      key = `search:${actor.id}`;
    f.repository.set(key, recent);
    jest.spyOn(gateway, 'actor').mockResolvedValue(actor);
    const s = session(f.repository, actor.id, 'entry', {}),
      i = modalSubmit(`nxm:catalogue:${s.id}`, { query: 'New game' }, false);
    await controller.handle(i as unknown as Interaction);
    expect(f.catalogue.search).toHaveBeenCalledTimes(isAdmin ? 1 : 0);
    expect(f.repository.get(key)).toEqual(recent);
    if (!isAdmin) expect(JSON.stringify(i.editReply.mock.calls)).toContain('Patiente');
  },
);
