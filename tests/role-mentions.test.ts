import { enableRoleMentions, planRoleMentions } from '../src/application/role-mentions.js';
import { fixture, game, member } from './helpers.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.repository.close());

test('preview lists only catalogue roles and never changes Discord', async () => {
  const active = f.add(game({ name: 'Alpha' }));
  const archived = f.add(game({ name: 'Beta', state: 'archived' }));
  f.community.world.roles.push({ ...f.community.world.roles[0]!, id: 'unrelated' });
  const report = await enableRoleMentions(f.repository, f.community, false);
  expect(new Set(report.changes.map((c) => c.roleId))).toEqual(
    new Set([active.roleId, archived.roleId]),
  );
  expect(report.updated).toEqual([]);
  expect(report.errors).toEqual([]);
  expect(f.community.prepareImportedRole).not.toHaveBeenCalled();
});

test('application preserves roles, subscriptions and channels and is safe to rerun', async () => {
  const g = f.add(game());
  f.repository.subscribe(g.id, member.id, true);
  f.community.world.roles[0]!.members = [member.id];
  const channels = structuredClone(f.community.world.channels);
  const first = await enableRoleMentions(f.repository, f.community, true);
  const second = await enableRoleMentions(f.repository, f.community, true);
  expect(first.updated).toEqual([{ game: g.name, roleId: g.roleId }]);
  expect(second.changes).toEqual([]);
  expect(second.alreadyMentionable).toBe(1);
  expect(f.community.prepareImportedRole).toHaveBeenCalledTimes(1);
  expect(f.repository.game(g.id)).toEqual(g);
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(f.community.world.roles[0]!.members).toEqual([member.id]);
  expect(f.community.world.channels).toEqual(channels);
  expect(f.community.createRole).not.toHaveBeenCalled();
  expect(f.community.setSubscription).not.toHaveBeenCalled();
});

test.each([{ managed: true }, { editable: false }, { permissions: '8' }])(
  'all roles are checked before any mutation when a role is unsafe: %p',
  async (unsafe) => {
    f.add(game());
    f.add(game());
    Object.assign(f.community.world.roles[1]!, unsafe);
    const report = await enableRoleMentions(f.repository, f.community, true);
    expect(report.errors).toHaveLength(1);
    expect(f.community.prepareImportedRole).not.toHaveBeenCalled();
  },
);

test('an incomplete snapshot prevents changes', async () => {
  f.add(game());
  f.community.world.complete = false;
  const report = await enableRoleMentions(f.repository, f.community, true);
  expect(report.errors).toHaveLength(1);
  expect(f.community.prepareImportedRole).not.toHaveBeenCalled();
});

test('missing, recycled and retired resources are left alone', async () => {
  const missing = f.add(game());
  f.add(game({ retired: true }));
  f.add(game({ roleState: 'recycled', roleId: null }));
  f.community.world.roles = f.community.world.roles.filter((r) => r.id !== missing.roleId);
  const report = await enableRoleMentions(f.repository, f.community, true);
  expect(report.skipped).toHaveLength(2);
  expect(report.changes).toEqual([]);
  expect(f.community.prepareImportedRole).not.toHaveBeenCalled();
  expect(f.community.createRole).not.toHaveBeenCalled();
});

test('a partial failure reports confirmed progress and reruns only the remaining roles', async () => {
  f.add(game({ id: 'game-a', name: 'Alpha' }));
  const second = f.add(game({ id: 'game-b', name: 'Beta' }));
  const third = f.add(game({ id: 'game-c', name: 'Gamma' }));
  const real = f.community.prepareImportedRole.getMockImplementation()!;
  f.community.prepareImportedRole
    .mockImplementationOnce(real)
    .mockRejectedValueOnce(new Error('private request details'));
  const partial = await enableRoleMentions(f.repository, f.community, true);
  expect(partial.updated).toHaveLength(1);
  expect(partial.errors).toHaveLength(1);
  expect(JSON.stringify(partial)).not.toContain('private request details');
  expect(f.community.prepareImportedRole).toHaveBeenCalledTimes(2);
  const retry = await enableRoleMentions(f.repository, f.community, true);
  expect(retry.errors).toEqual([]);
  expect(retry.updated.map((c) => c.roleId)).toEqual([second.roleId, third.roleId]);
});

test('a shared role is listed once', () => {
  const g = f.add(game());
  const report = planRoleMentions([g, { ...g, id: 'duplicate' }], f.community.world);
  expect(report.changes).toHaveLength(1);
});
