import { DAY, type Operation } from '../src/domain/model.js';
import { Nexus } from '../src/application/nexus.js';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import {
  activeId,
  admin,
  archiveId,
  asset,
  fixture,
  game,
  member,
  now,
  outsider,
} from './helpers.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.repository.close());
test('background reconciliation lets I/O callbacks run while processing archived games', async () => {
  for (let i = 0; i < 20; i++) f.add(game({ state: 'archived' }));
  const incomingCallback = jest.fn();
  setImmediate(incomingCallback);
  const nexus = new Nexus(f.repository, f.community, f.catalogue, f.nexus.policy, f.clock, {
    yield: () => yieldToIO(),
  });
  await nexus.synchronize(false);
  expect(incomingCallback).toHaveBeenCalled();
  expect(f.repository.games()).toHaveLength(20);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('a creation has a visible channel and role without subscribing or mentioning anyone', async () => {
  const g = await f.nexus.create(member, 123);
  expect(g.state).toBe('active');
  expect(g.awaitingActivity).toBe(true);
  expect(f.repository.subscribers(g.id)).toEqual([]);
  expect(f.community.notify).not.toHaveBeenCalled();
  expect(f.repository.cooldown(member.id)).toBe(now);
  expect(f.repository.operations()[0]?.status).toBe('completed');
});
test('concurrent creation of one RAWG identity is idempotent and creates one channel', async () => {
  const [a, b] = await Promise.all([f.nexus.create(member, 123), f.nexus.create(admin, 123)]);
  expect(a.id).toBe(b.id);
  expect(f.community.createChannel).toHaveBeenCalledTimes(1);
});
test('one successful creation or revival per member in a rolling 24 hours', async () => {
  await f.nexus.create(member, 1);
  const archived = f.add(game({ state: 'archived' }));
  await expect(f.nexus.activate(member, archived.id)).rejects.toMatchObject({ code: 'cooldown' });
  f.clock.at += DAY;
  await expect(f.nexus.activate(member, archived.id)).resolves.toMatchObject({ state: 'active' });
});
test('an already active game does not consume a quota', async () => {
  const g = f.add(game());
  await f.nexus.activate(member, g.id);
  expect(f.repository.cooldown(member.id)).toBeNull();
});
test.each(['create', 'activate', 'subscribe', 'notify'] as const)(
  'membership is enforced for %s',
  async (method) => {
    const g = f.add(game());
    const action =
      method === 'create'
        ? f.nexus.create(outsider, 1)
        : method === 'activate'
          ? f.nexus.activate(outsider, g.id)
          : method === 'subscribe'
            ? f.nexus.subscribe(outsider, g.id, true)
            : f.nexus.notify(outsider, g.id, 'hello');
    await expect(action).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.community.createChannel).not.toHaveBeenCalled();
  },
);
test('a first human message promotes a provisional activation to the 30-day pool', async () => {
  const g = f.add(game({ awaitingActivity: true, activatedAt: now - DAY, lastActivityAt: null }));
  await f.nexus.recordActivity(g.channelId!, now - DAY - 1);
  expect(f.repository.game(g.id)?.awaitingActivity).toBe(true);
  await f.nexus.recordActivity(g.channelId!, now);
  expect(f.repository.game(g.id)?.awaitingActivity).toBe(false);
});
test('reconciliation observes manual subscriptions and moves without undoing them', async () => {
  const g = f.add(game());
  f.repository.subscribe(g.id, member.id, true);
  f.community.world.roles[0]!.members = [admin.id];
  f.community.world.channels.find((c) => c.id === g.channelId)!.parentId = archiveId;
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)?.state).toBe('archived');
  expect(f.repository.subscribers(g.id)).toEqual([admin.id]);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('a manually deleted role is not recreated or its former subscribers restored', async () => {
  const g = f.add(game({ state: 'archived' }));
  f.repository.subscribe(g.id, member.id, true);
  f.community.world.roles = [];
  await f.nexus.synchronize();
  expect(f.repository.game(g.id)?.roleState).toBe('missing');
  expect(f.repository.subscribers(g.id)).toEqual([]);
  await expect(f.nexus.activate(member, g.id)).rejects.toMatchObject({ code: 'needsReview' });
  expect(f.community.createRole).not.toHaveBeenCalled();
});
test('deleted or unmanaged channels become unavailable and are never recreated', async () => {
  const a = f.add(game()),
    b = f.add(game());
  f.community.world.channels = f.community.world.channels.filter((c) => c.id !== a.channelId);
  f.community.world.channels.find((c) => c.id === b.channelId)!.parentId = 'other';
  await f.nexus.synchronize();
  expect(f.repository.games().every((g) => g.state === 'unavailable')).toBe(true);
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('incomplete snapshots cannot delete subscriptions or trigger rotation', async () => {
  const g = f.add(game());
  f.repository.subscribe(g.id, member.id, true);
  f.community.world.complete = false;
  f.community.world.roles = [];
  await expect(f.nexus.synchronize()).rejects.toMatchObject({ code: 'incomplete' });
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('incomplete activity scans postpone archival while trusted scans preserve the baseline', async () => {
  const games = Array.from({ length: 17 }, () => f.add(game()));
  for (const g of games)
    f.community.observations.set(g.id, { at: g.lastActivityAt, complete: false });
  await f.nexus.synchronize();
  expect(f.community.move).not.toHaveBeenCalled();
  f.community.observations.clear();
  await f.nexus.synchronize();
  expect(f.repository.games().filter((g) => g.state === 'active')).toHaveLength(15);
});
test('a provisional game expires at 48h even when it is below the normal baseline', async () => {
  const g = f.add(
    game({ awaitingActivity: true, activatedAt: now - 2 * DAY, lastActivityAt: null }),
  );
  await f.nexus.synchronize();
  expect(f.repository.game(g.id)?.state).toBe('archived');
});
test('a partial creation is journalled and cannot produce a second game on retry', async () => {
  f.community.createRole.mockRejectedValueOnce(new Error('network'));
  await expect(f.nexus.create(member, 1)).rejects.toMatchObject({ code: 'partial' });
  const g = f.repository.games()[0]!;
  expect(g.channelId).toBeTruthy();
  expect(f.repository.operations()[0]?.status).toBe('review');
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)?.blocked).toBe(true);
  await expect(f.nexus.create(member, 1)).rejects.toMatchObject({ code: 'partial' });
  expect(f.community.createChannel).toHaveBeenCalledTimes(1);
});
test('a crash after Discord creates a channel recovers its stable marker without recreation', async () => {
  const g = game({ channelId: null, roleId: null, state: 'unavailable' });
  f.repository.saveGame(g);
  const channel = await f.community.createChannel(g);
  const role = await f.community.createRole(g);
  const op: Operation = {
    id: 'op',
    kind: 'create',
    gameId: g.id,
    actorId: member.id,
    status: 'pending',
    startedAt: now - 10,
    data: { roleName: g.name, previousRoleIds: [] },
    error: null,
  };
  f.repository.saveOperation(op);
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)).toMatchObject({
    channelId: channel,
    roleId: role,
    state: 'active',
  });
  expect(f.repository.operations()[0]?.status).toBe('completed');
  expect(f.community.createChannel).toHaveBeenCalledTimes(1);
});
test('an archive failure blocks the game until an explicit repair normalizes permissions', async () => {
  f.repository.close();
  f = fixture(0);
  const g = f.add(game());
  f.community.move.mockRejectedValueOnce(new Error('permission'));
  await f.nexus.synchronize();
  expect(f.repository.game(g.id)?.blocked).toBe(true);
  await f.nexus.synchronize();
  expect(f.community.move).toHaveBeenCalledTimes(1);
  await f.nexus.repair(admin, g.id, g.channelId!, g.roleId!);
  expect(f.community.repairResources).toHaveBeenCalled();
  expect(f.repository.game(g.id)?.blocked).toBe(false);
});
function saturateRoles(): void {
  while (f.community.world.roles.length < 245)
    f.community.world.roles.push({
      id: `filler-${f.community.world.roles.length}`,
      name: 'Other',
      members: [],
      managed: false,
      permissions: '0',
      mentionable: false,
      references: [],
      editable: true,
    });
}
test('role recycling preserves subscriber preferences, recreates a new role and restores surviving members', async () => {
  const archived = f.add(game({ state: 'archived' }));
  f.community.world.roles[0]!.members = [member.id, 'departed'];
  saturateRoles();
  await f.nexus.create(admin, 1);
  expect(f.repository.game(archived.id)?.roleState).toBe('recycled');
  expect(f.repository.subscribers(archived.id)).toEqual(['departed', member.id].sort());
  // Free a disposable non-game role so reactivation does not need another victim.
  f.community.world.roles.pop();
  await f.nexus.activate(member, archived.id);
  const restored = f.repository.game(archived.id)!;
  expect(restored.roleId).not.toBe(archived.roleId);
  expect(f.community.setSubscription).toHaveBeenCalledWith(restored.roleId, member.id, true);
  expect(f.community.setSubscription).not.toHaveBeenCalledWith(restored.roleId, 'departed', true);
});
test.each(['permissions', 'references', 'managed', 'editable'] as const)(
  'a role with unsafe %s cannot be recycled',
  async (field) => {
    const g = f.add(game({ state: 'archived' }));
    const role = f.community.world.roles[0]!;
    if (field === 'permissions') role.permissions = '8';
    if (field === 'references') role.references = ['onboarding:x'];
    if (field === 'managed') role.managed = true;
    if (field === 'editable') role.editable = false;
    saturateRoles();
    await expect(f.nexus.create(member, 1)).rejects.toMatchObject({ code: 'capacity' });
    expect(f.community.deleteRole).not.toHaveBeenCalled();
    expect(f.repository.game(g.id)?.roleState).toBe('present');
  },
);
test('catalogue and active-category limits cause no partially created channel', async () => {
  for (let i = 0; i < 150; i++) f.repository.saveGame(game({ state: 'archived' }));
  await expect(f.nexus.create(member, 1)).rejects.toMatchObject({ code: 'capacity' });
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('a full active category rejects a revival without spending quota', async () => {
  const g = f.add(game({ state: 'archived' }));
  for (let i = 0; i < 50; i++)
    f.community.world.channels.push({
      id: `other${i}`,
      name: 'Other',
      type: 0,
      parentId: activeId,
      topic: null,
    });
  await expect(f.nexus.activate(member, g.id)).rejects.toMatchObject({ code: 'capacity' });
  expect(f.repository.cooldown(member.id)).toBeNull();
});
test('notification and membership subscriptions do not reactivate an archived game', async () => {
  const g = f.add(game({ state: 'archived' }));
  await f.nexus.subscribe(member, g.id, true);
  expect(f.repository.game(g.id)?.state).toBe('archived');
  await expect(f.nexus.notify(member, g.id, 'hello')).rejects.toMatchObject({ code: 'blocked' });
});
test('notification sends are serialized and throttled per user and game', async () => {
  const g = f.add(game());
  const results = await Promise.allSettled([
    f.nexus.notify(member, g.id, 'hello'),
    f.nexus.notify(member, g.id, 'again'),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  expect(f.community.notify).toHaveBeenCalledTimes(1);
});
test('proposal review enforces admin rights and requester membership', async () => {
  const p = await f.nexus.propose(
    member,
    'Wardogs',
    'https://store.steampowered.com/app/123',
    'fr',
  );
  await expect(f.nexus.approve(member, member, p.id, asset)).rejects.toMatchObject({
    code: 'adminOnly',
  });
  await expect(
    f.nexus.approve(admin, { ...member, member: false }, p.id, asset),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const approved = await f.nexus.approve(admin, member, p.id, asset);
  expect(f.repository.proposal(p.id)).toMatchObject({ status: 'accepted', gameId: approved.id });
  expect(approved.rawgId).toBeNull();
});
test('proposal status is private and refusal records a reason without creating resources', async () => {
  const p = await f.nexus.propose(member, 'Wardogs', 'https://example.com/game', 'en');
  await f.nexus.reject(admin, p.id, 'Please confirm the edition.');
  expect(f.repository.proposal(p.id)?.reason).toBe('Please confirm the edition.');
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test.each([
  'http://example.com',
  'https://localhost/x',
  'https://127.0.0.1',
  'https://user:pass@example.com',
])('rejects invalid proposal links %s', async (url) => {
  await expect(f.nexus.propose(member, 'Test', url, 'fr')).rejects.toMatchObject({
    code: 'invalidInput',
  });
});
test('admin edits and blocks serialize with game creation', async () => {
  const g = await f.nexus.create(member, 123);
  await Promise.all([
    f.nexus.edit(admin, g.id, 'Project Zomboid', ['PZ']),
    f.nexus.block(admin, g.id, true),
  ]);
  expect(f.repository.game(g.id)).toMatchObject({
    name: 'Project Zomboid',
    aliases: ['PZ'],
    blocked: true,
  });
});
test('retiring an archived entry frees its catalogue slot while retaining resources and subscribers', async () => {
  const g = f.add(game({ state: 'archived' }));
  f.repository.subscribe(g.id, member.id, true);
  await f.nexus.retire(admin, g.id);
  expect(f.repository.games()).toHaveLength(0);
  expect(f.repository.games(true)).toHaveLength(1);
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.community.deleteRole).not.toHaveBeenCalled();
});
test('a recovered creation keeps its original 48-hour deadline across downtime', async () => {
  const g = game({
    state: 'unavailable',
    awaitingActivity: true,
    lastActivityAt: null,
    activatedAt: now - 3 * DAY,
  });
  f.repository.saveGame(g);
  f.community.add({ ...g, state: 'active' });
  f.repository.saveOperation({
    id: 'crash',
    kind: 'create',
    gameId: g.id,
    actorId: member.id,
    status: 'pending',
    startedAt: now - 3 * DAY,
    data: {},
    error: null,
  });
  await f.nexus.synchronize();
  expect(f.repository.game(g.id)?.state).toBe('archived');
  expect(f.repository.game(g.id)?.activatedAt).toBe(now - 3 * DAY);
});
test('an interrupted revival is not silently declared successful when permissions cannot be proven', async () => {
  const g = f.add(game());
  f.repository.saveOperation({
    id: 'crash',
    kind: 'activate',
    gameId: g.id,
    actorId: member.id,
    status: 'pending',
    startedAt: now,
    data: {},
    error: null,
  });
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)?.blocked).toBe(true);
  expect(f.repository.operations()[0]?.status).toBe('review');
});
test('a member with a recent partial creation cannot flood other game creations', async () => {
  f.community.createRole.mockRejectedValueOnce(new Error('network'));
  await expect(f.nexus.create(member, 1)).rejects.toMatchObject({ code: 'partial' });
  await expect(f.nexus.create(member, 2)).rejects.toMatchObject({ code: 'inProgress' });
  expect(f.community.createChannel).toHaveBeenCalledTimes(1);
});
test('a shared pending proposal is reported without exposing another member’s private proposal', async () => {
  await f.nexus.propose(member, 'Wardogs', 'https://example.com', 'fr');
  await expect(
    f.nexus.propose(admin, 'Wardogs', 'https://example.com', 'en'),
  ).rejects.toMatchObject({ code: 'alreadyProposed' });
});
test('an administrator can ask for details and the owner can amend the same proposal without spending activation quota', async () => {
  const p = await f.nexus.propose(member, 'Wardogs', 'https://example.com', 'fr');
  await f.nexus.clarify(admin, p.id, 'Which studio?');
  expect(f.repository.proposal(p.id)).toMatchObject({
    status: 'needs_info',
    reason: 'Which studio?',
  });
  await expect(
    f.nexus.amendProposal(admin, p.id, 'Wardogs', 'https://example.com'),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const updated = await f.nexus.amendProposal(
    member,
    p.id,
    'WARDOGS (BULKHEAD)',
    'https://example.com/official',
  );
  expect(updated).toMatchObject({ id: p.id, status: 'pending', reason: null });
  expect(f.repository.proposals()).toHaveLength(1);
  expect(f.repository.cooldown(member.id)).toBeNull();
});
test('a failed role deletion cannot be treated as a completed recycle by subscription or revival', async () => {
  const g = f.add(game({ state: 'archived' }));
  saturateRoles();
  f.community.deleteRole.mockRejectedValueOnce(new Error('network'));
  await expect(f.nexus.create(admin, 1)).rejects.toMatchObject({ code: 'partial' });
  await expect(f.nexus.subscribe(member, g.id, false)).rejects.toMatchObject({
    code: 'needsReview',
  });
  await expect(f.nexus.activate(member, g.id)).rejects.toMatchObject({ code: 'needsReview' });
  expect(f.community.createRole).not.toHaveBeenCalled();
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)).toMatchObject({ blocked: true, roleState: 'present' });
});

test('admins can submit repeated game requests immediately while members retain the rolling 24-hour limit', async () => {
  const administrator = { ...admin, member: true };
  const first = await f.nexus.propose(administrator, 'Admin game 1', 'https://example.com/1', 'fr');
  const second = await f.nexus.propose(
    administrator,
    'Admin game 2',
    'https://example.com/2',
    'fr',
  );
  expect(first.id).not.toBe(second.id);
  expect(f.repository.cooldown(admin.id)).toBeNull();
  await f.nexus.propose(member, 'Member game 1', 'https://example.com/m1', 'fr');
  await expect(
    f.nexus.propose(member, 'Member game 2', 'https://example.com/m2', 'fr'),
  ).rejects.toMatchObject({ code: 'proposalCooldown' });
  f.clock.at += DAY;
  await expect(
    f.nexus.propose(member, 'Member game 2', 'https://example.com/m2', 'fr'),
  ).resolves.toMatchObject({ status: 'pending' });
});
test('admins bypass the request queue anti-abuse threshold but cannot create duplicate requests', async () => {
  for (let i = 0; i < 50; i++)
    f.repository.saveProposal({
      id: `seed-${i}`,
      actorId: member.id,
      name: `Seed ${i}`,
      url: 'https://example.com',
      createdAt: now - 2 * DAY,
      status: 'pending',
      reason: null,
      gameId: null,
      locale: 'fr',
    });
  await expect(
    f.nexus.propose(admin, 'Admin test game', 'https://example.com/admin', 'fr'),
  ).resolves.toMatchObject({ actorId: admin.id });
  await expect(
    f.nexus.propose(member, 'Member test game', 'https://example.com/member', 'fr'),
  ).rejects.toMatchObject({ code: 'capacity' });
  await expect(f.nexus.propose(admin, 'Seed 1', 'https://example.com', 'fr')).rejects.toMatchObject(
    { code: 'alreadyProposed' },
  );
});
test('admin access does not waive request cooldown after the admin role is removed', async () => {
  await f.nexus.propose(admin, 'Admin game', 'https://example.com', 'fr');
  await expect(
    f.nexus.propose(
      { ...admin, admin: false, member: true },
      'Another game',
      'https://example.com/other',
      'fr',
    ),
  ).rejects.toMatchObject({ code: 'proposalCooldown' });
});
