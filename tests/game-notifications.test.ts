import { ComponentType } from 'discord.js';
import { DAY } from '../src/domain/model.js';
import { gameNotificationMessage } from '../src/presentation/game-messages.js';
import { controls, nodes } from './component-helpers.js';
import { admin, asset, fixture, game, member, now } from './helpers.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.repository.close());
const key = (id: string) => `game-notification-message:${id}`;

test('new games receive one pinned invitation without subscribing their creator or changing activity', async () => {
  const g = await f.nexus.create(member, 123);
  expect(f.community.sendGameNotificationMessage).toHaveBeenCalledWith(g);
  expect(f.community.pinGameNotificationMessage).toHaveBeenCalledWith(g, 'notification-message');
  expect(f.repository.get(key(g.id))).toMatchObject({
    status: 'sent',
    messageId: 'notification-message',
    sentAt: now,
  });
  expect(f.repository.subscribers(g.id)).toEqual([]);
  expect(g).toMatchObject({ awaitingActivity: true, lastActivityAt: null });
  await f.nexus.create(member, 123);
  await f.nexus.synchronize(false);
  await f.nexus.deliverNewGameAnnouncements();
  expect(f.community.sendGameNotificationMessage).toHaveBeenCalledTimes(1);
  expect(f.community.pinGameNotificationMessage).toHaveBeenCalledTimes(1);
});

test('administrative additions also publish an invitation', async () => {
  const g = await f.nexus.addByAdmin(admin, {
    name: 'Example',
    url: 'https://example.com',
    assetId: asset.id,
    rawgId: null,
  });
  expect(f.community.sendGameNotificationMessage).toHaveBeenCalledWith(g);
});

test('partial creations, existing games and revivals do not publish invitations', async () => {
  f.community.createRole.mockRejectedValueOnce(new Error('unavailable'));
  await expect(f.nexus.create(member, 123)).rejects.toMatchObject({ code: 'partial' });
  const existing = f.add(game({ rawgId: 456 }));
  await f.nexus.create(member, 456);
  const archived = f.add(game({ state: 'archived' }));
  await f.nexus.activate(admin, archived.id);
  await f.nexus.deliverNewGameAnnouncements();
  expect(f.repository.get(key(existing.id))).toBeUndefined();
  expect(f.community.sendGameNotificationMessage).not.toHaveBeenCalled();
});

test.each(['send', 'pin'] as const)(
  'a failed %s preserves the game and announcement, alerts staff and never resends',
  async (step) => {
    if (step === 'send')
      f.community.sendGameNotificationMessage.mockRejectedValueOnce(
        new Error('uncertain delivery'),
      );
    else
      f.community.pinGameNotificationMessage.mockRejectedValueOnce(new Error('missing permission'));
    const g = await f.nexus.create(member, 123);
    expect(g).toMatchObject({ state: 'active', blocked: false });
    expect(f.repository.operations()[0]?.status).toBe('completed');
    expect(f.repository.get(key(g.id))).toMatchObject({
      status: 'review',
      ...(step === 'pin' ? { messageId: 'notification-message' } : {}),
    });
    expect(f.community.alert).toHaveBeenCalledWith(
      `game-notification-message:${g.id}`,
      'gameNotificationNeedsReview',
      { game: g.name },
    );
    expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
    await f.nexus.deliverNewGameAnnouncements();
    expect(f.community.sendGameNotificationMessage).toHaveBeenCalledTimes(1);
    expect(f.community.pinGameNotificationMessage).toHaveBeenCalledTimes(step === 'pin' ? 1 : 0);
  },
);

test.each(['pending', 'sending', 'pinning'] as const)(
  'restart handles a %s invitation without duplicating a send',
  async (status) => {
    const g = f.add(game());
    f.repository.set(key(g.id), {
      status,
      createdAt: now,
      ...(status === 'pinning' ? { messageId: 'confirmed-message' } : {}),
    });
    await f.nexus.synchronize(false);
    expect(f.community.sendGameNotificationMessage).not.toHaveBeenCalled();
    expect(f.community.pinGameNotificationMessage).not.toHaveBeenCalled();
    await f.nexus.deliverNewGameAnnouncements();
    await f.nexus.deliverNewGameAnnouncements();
    expect(f.community.sendGameNotificationMessage).toHaveBeenCalledTimes(
      status === 'pending' ? 1 : 0,
    );
    expect(f.community.pinGameNotificationMessage).toHaveBeenCalledTimes(
      status === 'sending' ? 0 : 1,
    );
    if (status === 'pinning')
      expect(f.community.pinGameNotificationMessage).toHaveBeenCalledWith(g, 'confirmed-message');
    expect(f.repository.get(key(g.id))).toMatchObject({
      status: status === 'sending' ? 'review' : 'sent',
    });
  },
);

test.each([true, false])(
  'recovery only queues an invitation if its creation explicitly planned one: %s',
  async (planned) => {
    const g = f.add(game({ state: 'unavailable' }));
    f.community.world.channels.find((c) => c.id === g.channelId)!.parentId =
      f.nexus.policy.activeCategoryId;
    f.repository.saveOperation({
      id: 'interrupted',
      kind: 'create',
      gameId: g.id,
      actorId: member.id,
      status: 'pending',
      startedAt: now,
      data: { announceNewGame: true, ...(planned ? { gameNotificationMessage: true } : {}) },
      error: null,
    });
    await f.nexus.synchronize(false);
    expect(f.community.sendGameNotificationMessage).not.toHaveBeenCalled();
    expect(f.repository.get(key(g.id))).toEqual(
      planned ? { status: 'pending', createdAt: now } : undefined,
    );
    await f.nexus.deliverNewGameAnnouncements();
    expect(f.community.sendGameNotificationMessage).toHaveBeenCalledTimes(planned ? 1 : 0);
  },
);

test('completed delivery receipts expire after thirty days while unresolved invitations remain', async () => {
  for (const status of ['pending', 'sending', 'pinning', 'sent', 'review'])
    f.repository.set(key(status), { status, createdAt: now, sentAt: now });
  f.clock.at = now + 31 * DAY;
  await f.nexus.maintain();
  expect(f.repository.get(key('sent'))).toBeUndefined();
  for (const status of ['pending', 'sending', 'pinning', 'review'])
    expect(f.repository.get(key(status))).toBeDefined();
});

test('the public message is bilingual, suppresses mentions and has one persistent subscribe button', () => {
  const g = game({ name: '**Example** @everyone' });
  const payload = gameNotificationMessage(g);
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.files).toEqual([]);
  expect(nodes(payload).some((n) => n.type === ComponentType.Thumbnail)).toBe(false);
  expect(nodes(payload).find((n) => n.content)?.content).toContain('\\*\\*Example\\*\\*');
  expect(JSON.stringify(payload)).toContain('Envie d’être prévenu');
  expect(JSON.stringify(payload)).toContain('Want to be notified');
  expect(controls(payload)).toEqual([
    expect.objectContaining({
      custom_id: `nx:game-notifications:${g.channelId}`,
      label: 'Être notifié / Get notified',
    }),
  ]);
});

test('an invitation cannot be published without its real channel association', () => {
  expect(() => gameNotificationMessage(game({ channelId: null }))).toThrow('invalidInput');
});

test('the invitation attaches the stored role image as a thumbnail beside the bilingual text', () => {
  const g = game({ name: 'Dawn of War IV' });
  const payload = gameNotificationMessage(g, asset);
  expect(nodes(payload).find((n) => n.type === ComponentType.Section)).toMatchObject({
    components: [expect.objectContaining({ content: expect.stringContaining('Dawn of War IV') })],
    accessory: {
      type: ComponentType.Thumbnail,
      media: { url: 'attachment://game.png' },
      description: 'Icône de Dawn of War IV / Icon for Dawn of War IV',
    },
  });
  expect(payload.files).toHaveLength(1);
  expect(payload.files[0]!.name).toBe('game.png');
  expect(payload.files[0]!.attachment).toEqual(Buffer.from(asset.bytes));
  expect(controls(payload)).toEqual(controls(gameNotificationMessage(g)));
  expect(payload.allowedMentions).toEqual({ parse: [] });
});
