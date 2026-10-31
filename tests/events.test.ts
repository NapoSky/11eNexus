import { admin, member, outsider, game } from './helpers.js';
import { eventFixture } from './event-helpers.js';
import { DAY } from '../src/domain/model.js';
import { EventViews, eventHome } from '../src/presentation/event-views.js';
import { controls } from './component-helpers.js';
let f: ReturnType<typeof eventFixture>;
beforeEach(() => {
  f = eventFixture();
});
afterEach(() => f.repository.close());

test('a dry-run is read-only and two independently named events can use the same game without changing it', async () => {
  const before = f.repository.game(f.parent.id);
  const plan = await f.events.plan(admin, {
    kind: 'create',
    draft: { gameId: f.parent.id, name: 'Campagne', description: 'Bonjour' },
  });
  expect(f.eventCommunity.createCategory).not.toHaveBeenCalled();
  expect(f.eventCommunity.publish).not.toHaveBeenCalled();
  expect(f.repository.events()).toHaveLength(0);
  const a = await f.events.execute(admin, plan),
    b = await f.create('Autre campagne');
  expect(a.roleId).not.toBe(b.roleId);
  expect(a.gameId).toBe(b.gameId);
  expect(f.repository.game(f.parent.id)).toEqual(before);
  expect(f.community.createRole).not.toHaveBeenCalled();
  expect(f.community.move).not.toHaveBeenCalled();
  expect(f.repository.cooldown(admin.id)).toBeNull();
});
test('archived games stay archived and skip the discovery announcement', async () => {
  f.parent.state = 'archived';
  f.repository.saveGame(f.parent);
  const event = await f.create();
  expect(event.announcementChannelId).toBeNull();
  expect(f.eventCommunity.announce).not.toHaveBeenCalled();
  expect(f.repository.game(f.parent.id)?.state).toBe('archived');
});
test('double confirmation creates once, and unrelated membership does not invalidate an event preview', async () => {
  const plan = await f.events.plan(admin, {
    kind: 'create',
    draft: { gameId: f.parent.id, name: 'Test', description: 'Hello' },
  });
  f.eventCommunity.world.roles.push({
    id: 'unrelated',
    name: 'Other',
    members: [],
    managed: false,
    permissions: '0',
    references: [],
    mentionable: true,
    editable: true,
  });
  await expect(f.events.execute(admin, plan)).rejects.toMatchObject({ code: 'staleAction' });
  const fresh = await f.events.plan(admin, plan.action);
  f.eventCommunity.world.roles[0]!.members.push(member.id);
  const results = await Promise.allSettled([
    f.events.execute(admin, fresh),
    f.events.execute(admin, fresh),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.eventCommunity.createRole).toHaveBeenCalledTimes(1);
});
test('member, outsider, foreign owner, expired preview and revoked admin cannot mutate events', async () => {
  const action = {
    kind: 'create' as const,
    draft: { gameId: f.parent.id, name: 'Test', description: 'Hello' },
  };
  await expect(f.events.plan(member, action)).rejects.toMatchObject({ code: 'adminOnly' });
  const plan = await f.events.plan(admin, action);
  await expect(f.events.execute({ ...admin, id: 'foreign' }, plan)).rejects.toMatchObject({
    code: 'staleAction',
  });
  f.clock.at += 5 * 60000;
  await expect(f.events.execute(admin, plan)).rejects.toMatchObject({ code: 'staleAction' });
  const fresh = await f.events.plan(admin, action);
  f.eventCommunity.actors.set(admin.id, { ...admin, admin: false });
  await expect(f.events.execute(admin, fresh)).rejects.toMatchObject({ code: 'forbidden' });
  expect(f.eventCommunity.createRole).not.toHaveBeenCalled();
});
test('capacity checks never recycle a game role and do not require role icons', async () => {
  const recyclable = f.add(game({ state: 'archived' }));
  f.eventCommunity.world.roles = Array.from({ length: 245 }, (_, i) => ({
    id: String(i),
    name: 'Role',
    members: [],
    permissions: '0',
    managed: false,
    references: [],
    mentionable: true,
    editable: true,
  }));
  await expect(f.create()).rejects.toMatchObject({ code: 'capacity' });
  expect(f.community.deleteRole).not.toHaveBeenCalled();
  expect(f.repository.game(recyclable.id)?.roleState).toBe('present');
  f.eventCommunity.world.roles = [];
  f.community.world.roleIcons = false;
  expect((await f.create()).state).toBe('active');
});
test('pinning failure keeps one usable event and an explicit repair finishes it without duplicate resources or messages', async () => {
  f.eventCommunity.pin.mockRejectedValueOnce(new Error('network'));
  await expect(f.create()).rejects.toMatchObject({ code: 'e.partial' });
  const event = f.repository.events()[0]!;
  expect(event.state).toBe('active');
  expect(event.messageId).toBeTruthy();
  const plan = await f.events.plan(admin, { kind: 'repair', eventId: event.id });
  await f.events.execute(admin, plan);
  expect(f.eventCommunity.publish).toHaveBeenCalledTimes(1);
  expect(f.eventCommunity.createRole).toHaveBeenCalledTimes(1);
  expect(f.repository.event(event.id)?.issue).toBeNull();
  expect(f.repository.eventOperations().every((o) => o.status === 'completed')).toBe(true);
});
test('an uncertain publication is recovered from its durable event marker rather than replayed', async () => {
  f.eventCommunity.publish.mockImplementationOnce(async (event) => {
    f.eventCommunity.messages.set(event.id, 'confirmed-message');
    throw new Error('timeout');
  });
  await expect(f.create()).rejects.toMatchObject({ code: 'e.partial' });
  const event = f.repository.events()[0]!;
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'repair', eventId: event.id }));
  expect(f.eventCommunity.publish).toHaveBeenCalledTimes(1);
  expect(f.repository.event(event.id)?.messageId).toBe('confirmed-message');
});
test('subscriptions stay independent from game subscriptions, visibility and other events', async () => {
  const a = await f.create(),
    b = await f.create('Other');
  await f.events.subscribe(member, a.id, true);
  expect(await f.eventCommunity.subscribed(a.roleId!, member.id)).toBe(true);
  expect(await f.eventCommunity.subscribed(b.roleId!, member.id)).toBe(false);
  expect(f.repository.subscribers(f.parent.id)).toEqual([]);
  expect(f.eventCommunity.hide).not.toHaveBeenCalled();
  await expect(f.events.subscribe(outsider, a.id, true)).rejects.toMatchObject({
    code: 'forbidden',
  });
  f.eventCommunity.actors.set(member.id, outsider);
  await expect(f.events.subscribe(member, b.id, true)).rejects.toMatchObject({ code: 'forbidden' });
});
test('closing hides first, disables subscriptions, deletes its role, preserves history and cannot reopen', async () => {
  const event = await f.create();
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'close', eventId: event.id }));
  const closed = f.repository.event(event.id)!;
  expect(closed.state).toBe('archived');
  expect(closed.roleDeleted).toBe(true);
  expect(f.eventCommunity.hide.mock.invocationCallOrder[0]).toBeLessThan(
    f.eventCommunity.archive.mock.invocationCallOrder[0]!,
  );
  expect(f.eventCommunity.deleteChannel).not.toHaveBeenCalled();
  await expect(f.events.subscribe(member, event.id, true)).rejects.toMatchObject({
    code: 'e.closed',
  });
  await expect(f.events.plan(admin, { kind: 'close', eventId: event.id })).rejects.toMatchObject({
    code: 'e.closed',
  });
});
test('failed archiving leaves a closed, hidden channel and retains an operation for review', async () => {
  const event = await f.create();
  f.eventCommunity.archive.mockRejectedValueOnce(new Error('move failed'));
  await expect(
    f.events.execute(admin, await f.events.plan(admin, { kind: 'close', eventId: event.id })),
  ).rejects.toMatchObject({ code: 'e.partial' });
  expect(f.repository.event(event.id)?.state).toBe('closed');
  expect(f.eventCommunity.world.channels.find((c) => c.id === event.channelId)?.hidden).toBe(true);
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'repair', eventId: event.id }));
  expect(f.repository.event(event.id)?.state).toBe('archived');
});
test('full archives select by archive date, show irreversible confirmation, and remove only the approved event', async () => {
  const event = await f.create();
  const old = Array.from({ length: 50 }, (_, i) => f.archived(i + 1));
  old[0]!.createdAt = 999999;
  f.repository.saveEvent(old[0]!);
  const plan = await f.events.plan(admin, { kind: 'close', eventId: event.id });
  expect(plan.cleanupId).toBe(old[0]!.id);
  expect(f.eventCommunity.deleteChannel).not.toHaveBeenCalled();
  const view = new EventViews(f.repository, '100000000000000000').admin(admin, 'fr', {
    page: 'confirm',
    plan,
    back: eventHome(),
  });
  expect(JSON.stringify(view)).toContain('définitivement');
  expect(controls(view).find((c) => c.custom_id?.startsWith('ne:confirm:'))?.style).toBe(4);
  await f.events.execute(admin, plan);
  expect(f.eventCommunity.deleteChannel).toHaveBeenCalledTimes(1);
  expect(f.eventCommunity.deleteChannel.mock.calls[0]![0]).toBe(old[0]!.channelId);
  expect(f.repository.event(old[0]!.id)?.state).toBe('deleted');
  expect(
    f.eventCommunity.world.channels.filter((c) => c.parentId === 'event-archive'),
  ).toHaveLength(50);
});
test('new activity or changed permissions on the cleanup target invalidate its confirmation', async () => {
  const event = await f.create();
  Array.from({ length: 50 }, (_, i) => f.archived(i + 1));
  const plan = await f.events.plan(admin, { kind: 'close', eventId: event.id });
  const target = f.repository.event(plan.cleanupId!)!;
  f.eventCommunity.world.channels.find((c) => c.id === target.channelId)!.lastMessageId =
    'new-message';
  await expect(f.events.execute(admin, plan)).rejects.toMatchObject({ code: 'staleAction' });
  expect(f.eventCommunity.deleteChannel).not.toHaveBeenCalled();
});
test('cleanup success followed by move failure is recorded and never authorizes another deletion on replay', async () => {
  const event = await f.create();
  Array.from({ length: 50 }, (_, i) => f.archived(i + 1));
  const plan = await f.events.plan(admin, { kind: 'close', eventId: event.id });
  f.eventCommunity.archive.mockRejectedValueOnce(new Error('move failed'));
  await expect(f.events.execute(admin, plan)).rejects.toMatchObject({ code: 'e.partial' });
  expect(f.repository.eventOperations().some((o) => o.cleaned && o.status === 'review')).toBe(true);
  await expect(f.events.execute(admin, plan)).rejects.toMatchObject({ code: 'staleAction' });
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'repair', eventId: event.id }));
  expect(f.eventCommunity.deleteChannel).toHaveBeenCalledTimes(1);
});
test('unknown archive occupants are counted but never offered as deletion targets', async () => {
  const event = await f.create();
  for (let i = 0; i < 50; i++)
    f.eventCommunity.world.channels.push({
      id: `unknown-${i}`,
      name: 'History',
      type: 0,
      parentId: 'event-archive',
      topic: null,
    });
  const plan = await f.events.plan(admin, { kind: 'close', eventId: event.id });
  expect(plan.archiveBlocked).toBe(true);
  await f.events.execute(admin, plan);
  expect(f.repository.event(event.id)?.state).toBe('closed');
  expect(f.eventCommunity.deleteChannel).not.toHaveBeenCalled();
});
test('reconciliation respects manual deletion and moves and never recreates resources or assignments', async () => {
  const event = await f.create();
  f.eventCommunity.world.roles = [];
  const calls = f.eventCommunity.createRole.mock.calls.length;
  await f.events.synchronize();
  expect(f.repository.event(event.id)?.issue).toBe('e.roleMissing');
  expect(f.eventCommunity.createRole).toHaveBeenCalledTimes(calls);
  expect(f.eventCommunity.subscribe).not.toHaveBeenCalled();
  f.eventCommunity.world.channels.find((c) => c.id === event.channelId)!.parentId = 'outside';
  await f.events.synchronize();
  expect(f.repository.event(event.id)?.issue).toBe('e.channelMissing');
  await expect(f.events.subscribe(member, event.id, true)).rejects.toMatchObject({
    code: 'e.roleMissing',
  });
});
test('retention preserves event history and unresolved operations while terminal receipts expire', async () => {
  const event = await f.create();
  f.eventCommunity.archive.mockRejectedValueOnce(new Error('failed'));
  await expect(
    f.events.execute(admin, await f.events.plan(admin, { kind: 'close', eventId: event.id })),
  ).rejects.toMatchObject({ code: 'e.partial' });
  f.clock.at += 31 * DAY;
  f.repository.maintain(f.clock.now());
  expect(f.repository.event(event.id)).toBeDefined();
  expect(f.repository.eventOperations()).toHaveLength(1);
  expect(f.repository.eventOperations()[0]!.status).toBe('review');
});
test('a missing pinned message is only replaced by a reviewed repair and new subscriptions are never replayed', async () => {
  const event = await f.create();
  f.eventCommunity.messageStatus.mockResolvedValue('missing');
  await f.events.synchronize();
  expect(f.repository.event(event.id)?.issue).toBe('e.messageMissing');
  expect(f.eventCommunity.publish).toHaveBeenCalledTimes(1);
  const plan = await f.events.plan(admin, { kind: 'repair', eventId: event.id });
  expect(plan.replaceMessage).toBe(true);
  const view = new EventViews(f.repository, '100000000000000000').admin(admin, 'fr', {
    page: 'confirm',
    plan,
    back: eventHome(),
  });
  expect(JSON.stringify(view)).toContain('publiera et épinglera un nouveau message');
  await f.events.execute(admin, plan);
  expect(f.eventCommunity.publish).toHaveBeenCalledTimes(2);
  expect(f.eventCommunity.subscribe).not.toHaveBeenCalled();
});
test('a role created just before a lost response is recovered by its original operation, without a duplicate', async () => {
  const original = f.eventCommunity.createRole.getMockImplementation()!;
  f.eventCommunity.createRole.mockImplementationOnce(async (event) => {
    await original(event);
    throw new Error('lost response');
  });
  await expect(f.create()).rejects.toMatchObject({ code: 'e.partial' });
  const event = f.repository.events()[0]!;
  f.eventCommunity.recoverRole.mockResolvedValue(`role-${event.id}`);
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'repair', eventId: event.id }));
  expect(f.eventCommunity.createRole).toHaveBeenCalledTimes(1);
  expect(f.repository.event(event.id)?.state).toBe('active');
});
test('a required forum tag must be reviewed before any creation is allowed', async () => {
  const source = f.eventCommunity.world.channels.find((c) => c.id === f.parent.channelId)!;
  source.type = 15;
  source.requiresTag = true;
  source.tags = [{ id: 'tag', name: 'Campagnes' }];
  const draft = { gameId: f.parent.id, name: 'Forum Event', description: 'Hello' };
  const plan = await f.events.plan(admin, { kind: 'create', draft });
  expect(plan.announcementChannelId).toBe(f.parent.channelId);
  expect(plan.announcementTags).toHaveLength(1);
  await expect(f.events.execute(admin, plan)).rejects.toMatchObject({ code: 'e.tagRequired' });
  expect(f.eventCommunity.createChannel).not.toHaveBeenCalled();
  const chosen = await f.events.plan(admin, {
    kind: 'create',
    draft: { ...draft, announcementTagId: 'tag' },
  });
  expect((await f.events.execute(admin, chosen)).announcementTagId).toBe('tag');
});
test('two concurrent closures on the last archive place never overflow or silently choose another cleanup target', async () => {
  const a = await f.create('A'),
    b = await f.create('B');
  Array.from({ length: 49 }, (_, i) => f.archived(i + 1));
  const first = await f.events.plan(admin, { kind: 'close', eventId: a.id }),
    second = await f.events.plan(admin, { kind: 'close', eventId: b.id });
  const results = await Promise.allSettled([
    f.events.execute(admin, first),
    f.events.execute(admin, second),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.eventCommunity.deleteChannel).not.toHaveBeenCalled();
  expect(
    f.eventCommunity.world.channels.filter((c) => c.parentId === 'event-archive'),
  ).toHaveLength(50);
});
test('manual category deletion never recreates it, and an incomplete observation cannot classify resources as missing', async () => {
  const event = await f.create();
  const count = f.eventCommunity.createCategory.mock.calls.length;
  f.eventCommunity.world.complete = false;
  await expect(f.events.synchronize()).rejects.toMatchObject({ code: 'incomplete' });
  expect(f.repository.event(event.id)?.issue).toBeNull();
  f.eventCommunity.world.complete = true;
  f.eventCommunity.world.channels = f.eventCommunity.world.channels.filter(
    (c) => c.id !== 'event-active',
  );
  await expect(
    f.events.plan(admin, {
      kind: 'create',
      draft: { gameId: f.parent.id, name: 'Other', description: 'Hello' },
    }),
  ).rejects.toMatchObject({ code: 'e.categoriesMissing' });
  expect(f.eventCommunity.createCategory).toHaveBeenCalledTimes(count);
});
test('an authoritative API rejection can be retried after review without treating it as an unknown creation', async () => {
  f.eventCommunity.createRole.mockRejectedValueOnce({ status: 403, code: 50013 });
  await expect(f.create()).rejects.toMatchObject({ code: 'e.partial' });
  const event = f.repository.events()[0]!;
  await f.events.execute(admin, await f.events.plan(admin, { kind: 'repair', eventId: event.id }));
  expect(f.repository.event(event.id)?.state).toBe('active');
  expect(f.eventCommunity.recoverRole).not.toHaveBeenCalled();
});
test('editing cannot collide with another open event name or mutate a channel moved outside management', async () => {
  const a = await f.create('Alpha'),
    b = await f.create('Beta');
  await expect(
    f.events.plan(admin, { kind: 'edit', eventId: b.id, name: a.name, description: 'Hello' }),
  ).rejects.toMatchObject({ code: 'e.duplicate' });
  f.eventCommunity.world.channels.find((c) => c.id === b.channelId)!.parentId = 'external';
  await expect(
    f.events.plan(admin, { kind: 'edit', eventId: b.id, name: 'New name', description: 'Hello' }),
  ).rejects.toMatchObject({ code: 'needsReview' });
  expect(f.eventCommunity.edit).not.toHaveBeenCalled();
});
