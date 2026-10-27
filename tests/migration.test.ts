import {
  applyPlan,
  buildPlan,
  parseManifest,
  prepareRoleIcons,
  type Manifest,
} from '../src/application/migration.js';
import { activeId, fixture, game, member, asset } from './helpers.js';

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
function withCreation(parent?: string): Manifest {
  const entry = manifest.entries[0]!;
  return {
    ...manifest,
    entries: [
      {
        confirmed: true,
        name: entry.name,
        channelId: entry.channelId,
        state: entry.state,
        createRole: true,
        ...(parent ? { iconRoleId: parent } : { rawgId: 123 }),
      },
    ],
  };
}
test('a missing notification role is created on application, keeping the existing channel and no initial subscribers', async () => {
  f.community.world.roles = [];
  const m = parseManifest(withCreation());
  const initial = buildPlan(m, f.community.world, f.repository, 150, activeId);
  expect(initial.errors).toEqual([]);
  expect(initial.roleCreations).toHaveLength(1);
  expect(f.community.createRole).not.toHaveBeenCalled();
  const plan = await prepareRoleIcons(initial, f.repository, f.community, f.catalogue);
  expect(plan.errors).toEqual([]);
  expect(plan.games[0]?.assetId).toBe(asset.id);
  await applyPlan(plan, f.repository, f.community);
  const g = f.repository.games()[0]!;
  expect(g).toMatchObject({
    channelId: m.entries[0]?.channelId,
    state: 'active',
    roleState: 'present',
    canRecycle: true,
  });
  expect(g.roleId).toBeTruthy();
  expect(f.repository.subscribers(g.id)).toEqual([]);
  expect(f.community.createChannel).not.toHaveBeenCalled();
  expect(f.community.setSubscription).not.toHaveBeenCalled();
  expect(f.community.createRole).toHaveBeenCalledTimes(1);
  expect(f.community.removeGameOptions).toHaveBeenCalledWith([g.roleId], [g.channelId]);
  await applyPlan(plan, f.repository, f.community);
  expect(f.community.createRole).toHaveBeenCalledTimes(1);
});
test('a new role can reuse a parent icon without copying its subscribers', async () => {
  const parent = manifest.entries[0]!.roleId!;
  const initial = buildPlan(
    parseManifest(withCreation(parent)),
    f.community.world,
    f.repository,
    150,
    activeId,
  );
  const plan = await prepareRoleIcons(initial, f.repository, f.community, f.catalogue);
  expect(plan.errors).toEqual([]);
  expect(f.catalogue.get).not.toHaveBeenCalled();
  expect(f.community.importRoleAsset).toHaveBeenCalledWith(parent);
  await applyPlan(plan, f.repository, f.community);
  expect(f.repository.subscribers(f.repository.games()[0]!.id)).toEqual([]);
  expect(f.community.world.roles.find((r) => r.id === parent)?.members).toEqual([member.id]);
});
test('a missing image prevents all Discord mutations, including archive adoption', async () => {
  f.catalogue.image = async () => null;
  const m = { ...withCreation(), archiveCategoryIds: [f.community.world.archiveCategoryIds[0]!] };
  const initial = buildPlan(m, f.community.world, f.repository, 150, activeId);
  await expect(applyPlan(initial, f.repository, f.community)).rejects.toMatchObject({
    code: 'invalidImage',
  });
  const plan = await prepareRoleIcons(initial, f.repository, f.community, f.catalogue);
  expect(plan.errors.join('\n')).toContain('icon unavailable');
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'invalidInput',
  });
  expect(f.community.adoptArchives).not.toHaveBeenCalled();
  expect(f.community.createRole).not.toHaveBeenCalled();
  expect(f.repository.games()).toHaveLength(0);
});
test('new role capacity and icon support are checked before fetching images or creating anything', async () => {
  f.community.world.roleIcons = false;
  let initial = buildPlan(withCreation(), f.community.world, f.repository, 150, activeId);
  expect(initial.errors.join('\n')).toContain('icons');
  await prepareRoleIcons(initial, f.repository, f.community, f.catalogue);
  expect(f.catalogue.get).not.toHaveBeenCalled();
  f.community.world.roleIcons = true;
  while (f.community.world.roles.length < 245)
    f.community.world.roles.push({
      ...f.community.world.roles[0]!,
      id: `filler-${f.community.world.roles.length}`,
    });
  initial = buildPlan(withCreation(), f.community.world, f.repository, 150, activeId);
  expect(initial.errors.join('\n')).toContain('role capacity');
});
test('creation manifests require exactly one role mode and a verified icon source', () => {
  expect(() => parseManifest(withCreation())).not.toThrow();
  const base = withCreation().entries[0]!;
  for (const entry of [
    { ...base, roleId: manifest.entries[0]!.roleId },
    { ...base, rawgId: undefined },
    { ...base, createRole: false },
    { ...base, iconRoleId: 'invalid' },
    { ...manifest.entries[0], iconRoleId: manifest.entries[0]!.roleId },
  ])
    expect(() => parseManifest({ ...manifest, entries: [entry] })).toThrow('invalidInput');
});
test('an interrupted role creation is recovered for review and explicitly reattached without duplication', async () => {
  const roleId = '100000000000000150';
  const initial = buildPlan(withCreation(), f.community.world, f.repository, 150, activeId);
  const plan = await prepareRoleIcons(initial, f.repository, f.community, f.catalogue);
  f.community.createRole.mockImplementationOnce(async (g) => {
    f.community.world.roles.push({
      id: roleId,
      name: g.name,
      members: [],
      managed: false,
      permissions: '0',
      mentionable: false,
      references: [],
      editable: true,
    });
    throw new Error('timeout after create');
  });
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'partial',
  });
  await f.nexus.synchronize(false);
  const g = f.repository.games()[0]!;
  expect(g).toMatchObject({ blocked: true, roleId });
  expect(
    buildPlan(withCreation(), f.community.world, f.repository, 150, activeId).errors.join('\n'),
  ).toContain('previous role creation');
  const repaired = buildPlan(
    { ...manifest, entries: [{ ...manifest.entries[0]!, roleId }] },
    f.community.world,
    f.repository,
    150,
    activeId,
  );
  expect(repaired.errors).toEqual([]);
  await applyPlan(repaired, f.repository, f.community);
  await f.nexus.synchronize(false);
  expect(f.repository.game(g.id)).toMatchObject({ blocked: false, roleId, state: 'active' });
  expect(f.repository.operations().every((o) => o.status === 'completed')).toBe(true);
  expect(f.community.createRole).toHaveBeenCalledTimes(1);
});
test('retrying a role-creation failure with unchanged Discord still requires review', async () => {
  const plan = await prepareRoleIcons(
    buildPlan(withCreation(), f.community.world, f.repository, 150, activeId),
    f.repository,
    f.community,
    f.catalogue,
  );
  f.community.createRole.mockRejectedValueOnce(new Error('network'));
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'partial',
  });
  await expect(applyPlan(plan, f.repository, f.community)).rejects.toMatchObject({
    code: 'needsReview',
  });
  expect(f.community.createRole).toHaveBeenCalledTimes(1);
});
