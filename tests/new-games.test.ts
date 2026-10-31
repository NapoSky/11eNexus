import { DAY } from '../src/domain/model.js';
import { admin, asset, fixture, game, member, now, outsider } from './helpers.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.repository.close());
const key = (id: string) => `new-game-announcement:${id}`;

test('a successful creation records its addition date and announces once, including after reconciliation', async () => {
  const g = await f.nexus.create(member, 123);
  expect(g.addedAt).toBe(now);
  expect(f.community.announceNewGame).toHaveBeenCalledWith(g);
  expect(f.repository.get(key(g.id))).toMatchObject({
    status: 'sent',
    messageId: 'announcement-message',
    sentAt: now,
  });
  await f.nexus.synchronize(false);
  await f.nexus.deliverNewGameAnnouncements();
  await f.nexus.create(member, 123);
  expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
});

test('reviewed administrative additions use the same announcement path', async () => {
  const g = await f.nexus.addByAdmin(admin, {
    name: 'Example',
    url: 'https://example.com',
    assetId: asset.id,
    rawgId: null,
  });
  expect(g.addedAt).toBe(now);
  expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
});

test('partial creations do not acquire an addition date or publish an announcement', async () => {
  f.community.createRole.mockRejectedValueOnce(new Error('unavailable'));
  await expect(f.nexus.create(member, 123)).rejects.toMatchObject({ code: 'partial' });
  expect(f.repository.games()[0]?.addedAt).toBeUndefined();
  expect(f.community.announceNewGame).not.toHaveBeenCalled();
});

test('an uncertain announcement leaves a successful game intact and is never retried automatically', async () => {
  f.community.announceNewGame.mockRejectedValueOnce(new Error('request may have arrived'));
  const g = await f.nexus.create(member, 123);
  expect(g).toMatchObject({ state: 'active', blocked: false, addedAt: now });
  expect(f.repository.operations()[0]?.status).toBe('completed');
  expect(f.repository.get(key(g.id))).toMatchObject({ status: 'review' });
  expect(f.community.alert).toHaveBeenCalledWith(
    `announcement:${g.id}`,
    'newGameAnnouncementNeedsReview',
    { game: g.name },
  );
  await f.nexus.deliverNewGameAnnouncements();
  expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
});

test.each(['pending', 'sending'] as const)(
  'restart handles a persisted %s announcement without replaying an uncertain send',
  async (status) => {
    const g = f.add(game({ addedAt: now }));
    f.repository.set(key(g.id), { status, createdAt: now });
    // Read-only reconciliation itself must not publish messages.
    await f.nexus.synchronize(false);
    expect(f.community.announceNewGame).not.toHaveBeenCalled();
    await f.nexus.deliverNewGameAnnouncements();
    await f.nexus.deliverNewGameAnnouncements();
    expect(f.community.announceNewGame).toHaveBeenCalledTimes(status === 'pending' ? 1 : 0);
    expect(f.repository.get(key(g.id))).toMatchObject({
      status: status === 'pending' ? 'sent' : 'review',
    });
  },
);

test('recovering an authorized interrupted creation queues its first announcement but does not publish during diagnostics', async () => {
  const g = f.add(game({ state: 'unavailable' }));
  f.community.world.channels.find((c) => c.id === g.channelId)!.parentId =
    f.nexus.policy.activeCategoryId;
  f.repository.saveOperation({
    id: 'interrupted',
    kind: 'create',
    gameId: g.id,
    actorId: member.id,
    status: 'pending',
    startedAt: now - 1000,
    data: { announceNewGame: true },
    error: null,
  });
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)?.addedAt).toBe(now - 1000);
  expect(f.repository.get(key(g.id))).toMatchObject({ status: 'pending' });
  expect(f.community.announceNewGame).not.toHaveBeenCalled();
  await f.nexus.deliverNewGameAnnouncements();
  expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
});

test('revival preserves the original date and does not announce imported or existing games', async () => {
  const g = f.add(game({ state: 'archived', addedAt: now - 20 * DAY }));
  await f.nexus.activate(member, g.id);
  await f.nexus.deliverNewGameAnnouncements();
  expect(f.repository.game(g.id)).toMatchObject({ addedAt: now - 20 * DAY, activatedAt: now });
  expect(f.community.announceNewGame).not.toHaveBeenCalled();
});

test('alert subscriptions follow Discord and never recreate a manually removed assignment', async () => {
  const role = {
    id: f.nexus.policy.newGameRoleId,
    name: 'Nouveau Jeu',
    members: [member.id],
    managed: false,
    permissions: '0',
    mentionable: true,
    references: [],
    editable: true,
  };
  f.community.world.roles.push(role);
  expect(await f.nexus.newGameAlerts(member)).toBe(true);
  role.members = [];
  expect(await f.nexus.newGameAlerts(member)).toBe(false);
  await f.nexus.synchronize(false);
  expect(f.community.setSubscription).not.toHaveBeenCalled();
  expect(await f.nexus.setNewGameAlerts(member, true)).toBe(true);
  expect(await f.nexus.setNewGameAlerts(member, true)).toBe(true);
  expect(f.community.setSubscription).toHaveBeenCalledTimes(1);
  expect(await f.nexus.setNewGameAlerts(member, false)).toBe(false);
  expect(f.repository.cooldown(member.id)).toBeNull();
  expect(f.repository.games()).toEqual([]);
  await expect(f.nexus.setNewGameAlerts(outsider, true)).rejects.toMatchObject({
    code: 'forbidden',
  });
});

test('announcement retention preserves unresolved deliveries and permanent addition dates', async () => {
  const g = f.add(game({ addedAt: now }));
  for (const status of ['sent', 'pending', 'sending', 'review'])
    f.repository.set(key(status), { status, createdAt: now, sentAt: now });
  f.clock.at = now + 31 * DAY;
  await f.nexus.maintain();
  expect(f.repository.get(key('sent'))).toBeUndefined();
  for (const status of ['pending', 'sending', 'review'])
    expect(f.repository.get(key(status))).toBeDefined();
  expect(f.repository.game(g.id)?.addedAt).toBe(now);
});
