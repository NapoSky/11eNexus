import {
  applyPlan,
  buildPlan,
  parseManifest,
  type Manifest,
} from '../src/application/migration.js';
import { activeId, fixture, game, member } from './helpers.js';

let f: ReturnType<typeof fixture>;
const manifest: Manifest = {
  version: 1,
  removeGameOptions: true,
  entries: [
    {
      confirmed: true,
      name: 'Project Zomboid',
      channelId: '100000000000000101',
      roleId: '100000000000000102',
      state: 'active',
      rawgId: 123,
    },
  ],
};
beforeEach(() => {
  f = fixture();
  f.community.add(
    game({
      name: 'Project Zomboid',
      channelId: manifest.entries[0]!.channelId,
      roleId: manifest.entries[0]!.roleId,
    }),
  );
  f.community.world.roles[0]!.members = [member.id];
});
afterEach(() => f.repository.close());
test('reviewed import preserves channel IDs and subscriptions; only affected onboarding options are targeted', async () => {
  const plan = buildPlan(manifest, f.community.world, f.repository, 150, activeId);
  expect(plan.errors).toEqual([]);
  expect(f.community.move).not.toHaveBeenCalled();
  await applyPlan(plan, f.repository, f.community);
  const g = f.repository.games()[0]!;
  expect(g.channelId).toBe(manifest.entries[0]?.channelId);
  expect(f.repository.subscribers(g.id)).toEqual([member.id]);
  expect(g.canRecycle).toBe(false);
  expect(f.community.removeGameOptions).toHaveBeenCalledWith([g.roleId], [g.channelId]);
  await applyPlan(plan, f.repository, f.community);
  expect(f.community.move).toHaveBeenCalledTimes(1);
});
test('unsafe legacy roles or duplicate identities prevent application before mutation', async () => {
  f.community.world.roles[0]!.permissions = '8';
  const plan = buildPlan(
    { ...manifest, entries: [...manifest.entries, ...manifest.entries] },
    f.community.world,
    f.repository,
    150,
    activeId,
  );
  expect(plan.errors.length).toBeGreaterThan(0);
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'invalidInput',
  });
  expect(f.community.move).not.toHaveBeenCalled();
});
test('a stale or edited plan cannot be applied', async () => {
  const plan = buildPlan(manifest, f.community.world, f.repository, 150, activeId);
  f.community.world.channels[0]!.name = 'Changed';
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'incomplete',
  });
  plan.games[0]!.name = 'Tampered';
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'invalidInput',
  });
});
test('membership changes after planning are imported from the fresh observation', async () => {
  const plan = buildPlan(manifest, f.community.world, f.repository, 150, activeId);
  f.community.world.roles[0]!.members = [];
  await applyPlan(plan, f.repository, f.community);
  expect(f.repository.subscribers(f.repository.games()[0]!.id)).toEqual([]);
});
test('partial imports retain history, block the game and leave onboarding unchanged', async () => {
  const plan = buildPlan(manifest, f.community.world, f.repository, 150, activeId);
  f.community.move.mockRejectedValueOnce(new Error('network'));
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'partial',
  });
  await f.nexus.synchronize(false);
  expect(f.repository.games()[0]?.blocked).toBe(true);
  expect(f.repository.operations()[0]?.status).toBe('review');
  expect(f.community.removeGameOptions).not.toHaveBeenCalled();
});
test('manifests require an explicit confirmation and actual snowflake IDs', () => {
  expect(() =>
    parseManifest({ ...manifest, entries: [{ ...manifest.entries[0], confirmed: false }] }),
  ).toThrow();
  expect(() =>
    parseManifest({ ...manifest, entries: [{ ...manifest.entries[0], roleId: 'oops' }] }),
  ).toThrow();
});
test('a reviewed standby category becomes archive one without losing channel IDs', async () => {
  const id = '100000000000000200';
  f.community.world.channels.push({ id, name: 'Standby', type: 4, parentId: null, topic: null });
  const m = { ...manifest, archiveCategoryIds: [id] };
  const plan = buildPlan(m, f.community.world, f.repository, 150, activeId);
  expect(plan.errors).toEqual([]);
  expect(plan.changes.join('\n')).toContain('including channels outside the catalogue');
  await applyPlan(plan, f.repository, f.community);
  expect(f.community.adoptArchives).toHaveBeenCalledWith([id], plan.digest);
  expect(f.repository.get('archiveAdoption')).toMatchObject({ status: 'completed' });
  await applyPlan(plan, f.repository, f.community);
  expect(f.community.adoptArchives).toHaveBeenCalledTimes(1);
});
test('a partial archive adoption stops import and rotation until reviewed', async () => {
  const id = '100000000000000200';
  f.community.world.channels.push({ id, name: 'Standby', type: 4, parentId: null, topic: null });
  const plan = buildPlan(
    { ...manifest, archiveCategoryIds: [id] },
    f.community.world,
    f.repository,
    150,
    activeId,
  );
  f.community.adoptArchives.mockRejectedValueOnce(new Error('network'));
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'partial',
  });
  expect(f.repository.games()).toHaveLength(0);
  expect(f.repository.get('archiveAdoption')).toMatchObject({ status: 'review' });
  await expect(f.nexus.synchronize()).rejects.toMatchObject({ code: 'needsReview' });
});
test('archive reuse rejects the active category, excess categories, and nontextual children before changes', () => {
  expect(
    buildPlan(
      { ...manifest, archiveCategoryIds: [activeId] },
      f.community.world,
      f.repository,
      150,
      activeId,
    ).errors,
  ).not.toEqual([]);
  const id = '100000000000000200';
  f.community.world.channels.push(
    { id, name: 'Standby', type: 4, parentId: null, topic: null },
    { id: '100000000000000201', name: 'Voice', type: 2, parentId: id, topic: null },
  );
  expect(
    buildPlan(
      { ...manifest, archiveCategoryIds: [id] },
      f.community.world,
      f.repository,
      150,
      activeId,
    ).errors.join('\n'),
  ).toContain('non-textual');
  expect(() => parseManifest({ ...manifest, archiveCategoryIds: ['wrong'] })).toThrow(
    'invalidInput',
  );
  expect(() => parseManifest({ ...manifest, archiveCategoryIds: [id, id] })).toThrow(
    'invalidInput',
  );
});
