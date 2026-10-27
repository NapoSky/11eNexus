import { Client, type Interaction, type TextChannel, MessageFlags } from 'discord.js';
import { Controller } from '../src/presentation/controller.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
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
    editReply: jest.fn(async () => {}),
    reply: jest.fn(async () => {}),
    showModal: jest.fn(async () => {}),
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
  const controls = payload.components[0].components;
  expect(controls.map((c: { custom_id: string }) => c.custom_id)).toContain('nx:archives');
  expect(controls).toHaveLength(4);
  expect(payload.allowedMentions).toEqual({ parse: [] });
});
test('a visitor without Syndiqué receives a private refusal before any domain action', async () => {
  const i = button('nx:games', []);
  await controller.handle(i as unknown as Interaction);
  expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  expect(i.editReply).not.toHaveBeenCalled();
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('search opens a localized modal immediately without deferring it', async () => {
  const i = button('nx:propose');
  await controller.handle(i as unknown as Interaction);
  expect(i.showModal).toHaveBeenCalledTimes(1);
  expect(i.deferReply).not.toHaveBeenCalled();
  expect(JSON.stringify(i.showModal.mock.calls)).toContain('Rechercher');
});
test('another member cannot operate a personal session even with a valid token', async () => {
  const s = session(f.repository, 'other', 'game', { gameId: 'x' });
  const i = button(`nx:activate:${s.id}`);
  await controller.handle(i as unknown as Interaction);
  expect(i.reply).toHaveBeenCalledWith(
    expect.objectContaining({ flags: MessageFlags.Ephemeral, content: expect.any(String) }),
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
  expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
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
  expect(i.editReply).toHaveBeenCalledWith(
    expect.objectContaining({ components: [], content: expect.any(String) }),
  );
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
  expect(JSON.stringify(i.reply.mock.calls)).toContain('nx:games');
  expect(i.reply).toHaveBeenCalledWith(
    expect.objectContaining({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }),
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
