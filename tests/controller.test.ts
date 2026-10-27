import { Client, type Interaction, MessageFlags } from 'discord.js';
import { Controller } from '../src/presentation/controller.js';
import { DiscordCommunity } from '../src/infrastructure/discord.js';
import { config } from '../src/infrastructure/config.js';
import { session } from '../src/presentation/views.js';
import { admin, fixture, game, member } from './helpers.js';

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
  controller = new Controller(f.nexus, gateway);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  await client.destroy();
  f.repository.close();
});
function button(customId: string, roleIds = [gateway.config.memberRoleId]) {
  return {
    customId,
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
