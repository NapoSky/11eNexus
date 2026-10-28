import { Administration } from '../src/application/administration.js';
import { DAY } from '../src/domain/model.js';
import { admin, asset, fixture, game, member, outsider } from './helpers.js';
let f: ReturnType<typeof fixture>;
let service: Administration;
beforeEach(() => {
  f = fixture();
  service = new Administration(f.nexus, () => f.clock.now(), '100000000000000000');
});
afterEach(() => {
  jest.restoreAllMocks();
  f.repository.close();
});
const changes = () => f.repository.db.prepare('SELECT total_changes() AS n').get()!.n;

test('diagnostic and preparing reconciliation do not write SQL, move channels, change roles or alert staff', async () => {
  const g = f.add(game());
  f.community.world.roles[0]!.members = [member.id];
  const before = changes();
  const preview = await service.inspect(admin);
  expect(preview.changes).toContainEqual({ name: g.name, kind: 'subscriptions', count: 1 });
  await service.plan(admin, { kind: 'reconcile' }, preview);
  expect(changes()).toBe(before);
  expect(f.community.move).not.toHaveBeenCalled();
  expect(f.community.setSubscription).not.toHaveBeenCalled();
  expect(f.community.alert).not.toHaveBeenCalled();
});
test('reconciliation updates observed subscriptions without applying inactivity rotation', async () => {
  const g = f.add(game());
  f.community.world.roles[0]!.members = [member.id];
  const preview = await service.inspect(admin),
    plan = await service.plan(admin, { kind: 'reconcile' }, preview);
  await service.execute(admin, plan);
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.repository.game(g.id)?.state).toBe('active');
  expect(f.community.move).not.toHaveBeenCalled();
  expect(f.repository.get('lastReconciliation')).toEqual({ at: f.clock.now(), rotation: false });
});
test('rotation respects the protected baseline and excludes incomplete human histories', async () => {
  for (let i = 0; i < 17; i++)
    f.add(
      game({
        name: `Game ${i.toString().padStart(2, '0')}`,
        lastActivityAt: f.clock.now() - (40 + i) * DAY,
      }),
    );
  const incomplete = f.repository.games().find((g) => g.name === 'Game 16')!;
  f.community.observations.set(incomplete.id, { at: null, complete: false });
  const preview = await service.inspect(admin);
  expect(preview.candidates).toHaveLength(1);
  expect(preview.unverified).toEqual([incomplete.name]);
  const plan = await service.plan(admin, { kind: 'rotate' }, preview);
  await service.execute(admin, plan);
  expect(f.community.move).toHaveBeenCalledTimes(1);
  expect(f.repository.games().filter((g) => g.state === 'active')).toHaveLength(16);
});
test('new human activity invalidates a prepared rotation before any mutation', async () => {
  f = (() => {
    f.repository.close();
    return fixture(0);
  })();
  service = new Administration(f.nexus, () => f.clock.now());
  const g = f.add(game());
  const preview = await service.inspect(admin),
    plan = await service.plan(admin, { kind: 'rotate' }, preview);
  f.community.observations.set(g.id, { at: f.clock.now(), complete: true });
  const before = changes();
  await expect(service.execute(admin, plan)).rejects.toMatchObject({ code: 'staleAction' });
  expect(changes()).toBe(before);
  expect(f.community.move).not.toHaveBeenCalled();
});
test('confirmations are bound to their admin, expire and cannot run twice even concurrently', async () => {
  const g = f.add(game({ state: 'archived' }));
  const plan = await service.plan(admin, { kind: 'activate', gameId: g.id });
  await expect(service.execute({ ...admin, id: 'other-admin' }, plan)).rejects.toMatchObject({
    code: 'staleAction',
  });
  const results = await Promise.allSettled([
    service.execute(admin, plan),
    service.execute(admin, plan),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.community.move).toHaveBeenCalledTimes(1);
  const second = await service.plan(admin, { kind: 'archive', gameId: g.id });
  f.clock.at += 5 * 60000;
  await expect(service.execute(admin, second)).rejects.toMatchObject({ code: 'staleAction' });
  expect(f.community.move).toHaveBeenCalledTimes(1);
});
test('Discord permissions and changed associations invalidate a confirmation', async () => {
  const g = f.add(game({ state: 'archived' })),
    plan = await service.plan(admin, { kind: 'activate', gameId: g.id });
  f.community.world.roles[0]!.permissions = '8';
  await expect(service.execute(admin, plan)).rejects.toMatchObject({ code: 'staleAction' });
  expect(f.community.move).not.toHaveBeenCalled();
});
test.each([member, outsider])(
  'non-admin %s cannot inspect, prepare or apply actions',
  async (actor) => {
    const g = f.add(game());
    await expect(service.inspect(actor)).rejects.toMatchObject({ code: 'adminOnly' });
    await expect(service.plan(actor, { kind: 'block', gameId: g.id })).rejects.toMatchObject({
      code: 'adminOnly',
    });
    const plan = await service.plan(admin, { kind: 'block', gameId: g.id });
    await expect(service.execute(actor, plan)).rejects.toMatchObject({ code: 'adminOnly' });
  },
);
test('manual approval bypasses member quota and records the admin and beneficiary separately', async () => {
  const proposal = await f.nexus.propose(member, 'Manual game', 'https://example.com/manual', 'fr');
  f.repository.setCooldown(member.id, f.clock.now());
  f.repository.setCooldown(admin.id, f.clock.now());
  const plan = await service.plan(admin, {
    kind: 'create',
    proposalId: proposal.id,
    input: { name: proposal.name, url: proposal.url, rawgId: null, assetId: asset.id },
  });
  await service.execute(admin, plan, member);
  const p = f.repository.proposal(proposal.id)!;
  expect(p.status).toBe('accepted');
  expect(f.repository.subscribers(p.gameId!)).toEqual([]);
  const op = f.repository.operations().find((o) => o.kind === 'create')!;
  expect(op.actorId).toBe(admin.id);
  expect(op.data).toMatchObject({ beneficiaryId: member.id, administrative: true });
  expect(f.repository.cooldown(member.id)).toBe(f.clock.now());
  expect(f.community.notify).not.toHaveBeenCalled();
});
test('an admin can add and revive multiple games without spending the member quota', async () => {
  f.repository.setCooldown(admin.id, f.clock.now());
  for (let i = 0; i < 2; i++) {
    const plan = await service.plan(admin, {
      kind: 'create',
      input: { name: `Manual ${i}`, url: 'https://example.com', rawgId: null, assetId: asset.id },
    });
    await service.execute(admin, plan);
  }
  const g = f.add(game({ state: 'archived' }));
  await service.execute(admin, await service.plan(admin, { kind: 'activate', gameId: g.id }));
  expect(f.repository.games()).toHaveLength(3);
  expect(f.repository.game(g.id)?.state).toBe('active');
});
test('approval cannot overwrite another admin’s refusal or a member amendment', async () => {
  const p = await f.nexus.propose(member, 'Game', 'https://example.com', 'fr');
  const plan = await service.plan(admin, {
    kind: 'create',
    proposalId: p.id,
    input: { name: p.name, url: p.url, rawgId: null, assetId: asset.id },
  });
  await f.nexus.reject(admin, p.id, 'Already exists');
  await expect(service.execute(admin, plan, member)).rejects.toMatchObject({ code: 'staleAction' });
  expect(f.community.createChannel).not.toHaveBeenCalled();
});
test('linking a request to an existing archived game creates no resources or subscriptions', async () => {
  const g = f.add(game({ state: 'archived' })),
    p = await f.nexus.propose(member, 'Known game', 'https://example.com', 'fr');
  await service.execute(
    admin,
    await service.plan(admin, { kind: 'attach', proposalId: p.id, gameId: g.id }),
  );
  expect(f.repository.proposal(p.id)).toMatchObject({ status: 'accepted', gameId: g.id });
  expect(f.repository.game(g.id)?.state).toBe('archived');
  expect(f.community.createRole).not.toHaveBeenCalled();
  expect(f.community.createChannel).not.toHaveBeenCalled();
  expect(f.repository.subscribers(g.id)).toEqual([]);
});
test('manual archive and retirement preserve channels, roles and subscriptions', async () => {
  const g = f.add(game());
  f.repository.subscribe(g.id, member.id, true);
  await service.execute(admin, await service.plan(admin, { kind: 'archive', gameId: g.id }));
  await service.execute(admin, await service.plan(admin, { kind: 'retire', gameId: g.id }));
  expect(f.repository.games()).toHaveLength(0);
  expect(f.repository.game(g.id)).toMatchObject({
    retired: true,
    channelId: g.channelId,
    roleId: g.roleId,
  });
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.community.world.channels.some((c) => c.id === g.channelId)).toBe(true);
  expect(f.community.deleteRole).not.toHaveBeenCalled();
});
test('renaming Discord resources is opt-in; partial renames are journalled and blocked', async () => {
  const g = f.add(game());
  await service.execute(
    admin,
    await service.plan(admin, {
      kind: 'edit',
      gameId: g.id,
      name: 'New name',
      aliases: ['old'],
      align: false,
    }),
  );
  expect(f.community.renameGame).not.toHaveBeenCalled();
  f.community.renameGame.mockRejectedValueOnce(new Error('Role update failed'));
  await expect(
    service.execute(
      admin,
      await service.plan(admin, {
        kind: 'edit',
        gameId: g.id,
        name: 'Aligned',
        aliases: [],
        align: true,
      }),
    ),
  ).rejects.toMatchObject({ code: 'partial' });
  expect(f.repository.game(g.id)).toMatchObject({ name: 'New name', blocked: true });
  expect(f.repository.operations().find((o) => o.kind === 'rename')?.status).toBe('review');
  await expect(f.nexus.block(admin, g.id, false)).rejects.toMatchObject({ code: 'needsReview' });
});
test('repair reuses selected resources and observes Discord subscribers without creating or replaying roles', async () => {
  const g = f.add(game({ blocked: true }));
  f.community.world.roles[0]!.members = [member.id];
  const plan = await service.plan(admin, {
    kind: 'repair',
    gameId: g.id,
    channelId: g.channelId!,
    roleId: g.roleId!,
  });
  await service.execute(admin, plan);
  expect(f.repository.game(g.id)?.blocked).toBe(false);
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.community.repairResources).toHaveBeenCalledTimes(1);
  expect(f.community.createRole).not.toHaveBeenCalled();
  expect(f.community.setSubscription).not.toHaveBeenCalled();
});
test('repair preview rejects global-permission roles, resource conflicts and channels outside the game categories', async () => {
  const g = f.add(game()),
    other = f.add(game());
  await expect(
    service.plan(admin, {
      kind: 'repair',
      gameId: g.id,
      channelId: other.channelId!,
      roleId: g.roleId!,
    }),
  ).rejects.toMatchObject({ code: 'repairConflict' });
  f.community.world.roles[0]!.permissions = '8';
  await expect(
    service.plan(admin, {
      kind: 'repair',
      gameId: g.id,
      channelId: g.channelId!,
      roleId: g.roleId!,
    }),
  ).rejects.toMatchObject({ code: 'repairRolePermissions' });
});
test('capacity, duplicate identity and missing icons are blocked during the review without writes', async () => {
  f.add(game({ name: 'Known', rawgId: 123 }));
  const input = { name: 'Known', rawgId: 123, url: 'https://example.com', assetId: asset.id };
  const before = changes();
  await expect(service.plan(admin, { kind: 'create', input })).rejects.toMatchObject({
    code: 'duplicateGame',
  });
  f.community.world.roleIcons = false;
  await expect(
    service.plan(admin, { kind: 'create', input: { ...input, name: 'Different', rawgId: 234 } }),
  ).rejects.toMatchObject({ code: 'iconsUnavailable' });
  expect(changes()).toBe(before);
  expect(f.community.alert).not.toHaveBeenCalled();
});

test('repair cannot expose a role used by private channels through self-service subscriptions', async () => {
  const g = f.add(game());
  f.community.world.roles[0]!.references = ['private-staff-room'];
  await expect(
    service.plan(admin, {
      kind: 'repair',
      gameId: g.id,
      channelId: g.channelId!,
      roleId: g.roleId!,
    }),
  ).rejects.toMatchObject({ code: 'repairRoleReferences' });
  await expect(f.nexus.repair(admin, g.id, g.channelId!, g.roleId!)).rejects.toMatchObject({
    code: 'invalidInput',
  });
  expect(f.community.repairResources).not.toHaveBeenCalled();
});
