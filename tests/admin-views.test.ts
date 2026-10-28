import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { AdminViews, type AdminDraft, type AdminRoute } from '../src/presentation/admin-views.js';
import { Administration } from '../src/application/administration.js';
import { languagesReady, translator } from '../src/presentation/i18n.js';
import { admin, asset, fixture, game, member } from './helpers.js';
import { actionId, assertUniqueCustomIds, controls, nodes, select } from './component-helpers.js';
let f: ReturnType<typeof fixture>, views: AdminViews;
beforeEach(async () => {
  await languagesReady;
  f = fixture();
  views = new AdminViews(f.repository, '100000000000000000');
});
afterEach(() => f.repository.close());
const catalogue: AdminRoute = { page: 'catalogue', filter: 'all', query: '', index: 0 };

test.each(['fr', 'en'] as const)(
  '%s admin screens serialize with real V2 builders, safe mentions and Discord limits',
  async (language) => {
    for (let i = 0; i < 150; i++)
      f.add(
        game({
          name: `Game ${i.toString().padStart(3, '0')}`,
          state: i < 15 ? 'active' : 'archived',
        }),
      );
    for (let i = 0; i < 45; i++)
      f.repository.saveProposal({
        id: `p${i}`,
        actorId: member.id,
        name: `Request ${i}`,
        url: 'https://example.com',
        status: i < 40 ? 'pending' : 'rejected',
        reason: null,
        gameId: null,
        createdAt: i,
        locale: language,
      });
    const g = f.repository.games()[0]!,
      draft: AdminDraft = {
        name: 'Manual game',
        url: 'https://example.com',
        rawgId: null,
        assetId: asset.id,
        back: catalogue,
      };
    const service = new Administration(f.nexus, () => f.clock.now()),
      preview = await service.inspect(admin),
      plan = await service.plan(admin, { kind: 'block', gameId: g.id });
    const routes: AdminRoute[] = [
      { page: 'home' },
      { page: 'requests', filter: 'open', query: '', index: 0 },
      { page: 'requests', filter: 'all', query: '', index: 2 },
      {
        page: 'request',
        id: 'p0',
        back: { page: 'requests', filter: 'open', query: '', index: 0 },
      },
      { page: 'game', id: g.id, back: catalogue },
      { page: 'prepare', draft },
      {
        page: 'results',
        draft,
        query: 'Game',
        items: [{ id: 123, name: 'Game', studio: 'Studio', released: null }],
      },
      { page: 'results', draft, query: 'Unknown', items: [] },
      { page: 'parents', draft, query: '', index: 7 },
      {
        page: 'attach',
        proposalId: 'p0',
        query: 'Game',
        index: 7,
        back: { page: 'request', id: 'p0', back: { page: 'home' } },
      },
      { page: 'repair', id: g.id, back: catalogue },
      { page: 'maintenance' },
      { page: 'status' },
      { page: 'maintenance', progress: { phase: 'waiting', current: 0, total: 0 } },
      { page: 'maintenance', progress: { phase: 'resources', current: 0, total: 0 } },
      { page: 'maintenance', progress: { phase: 'activity', current: 150, total: 150 } },
      { page: 'maintenance', preview },
      { page: 'panels', target: 'staff' },
      { page: 'panels', target: 'member', channelId: '123', channelName: 'panel' },
      { page: 'confirm', plan, details: ['Review this game'], back: { page: 'prepare', draft } },
    ];
    for (const filter of ['all', 'active', 'archived', 'unavailable', 'retired'])
      for (let index = 0; index < 8; index++)
        routes.push({ page: 'catalogue', filter, query: '', index });
    for (const route of routes) {
      const view = views.render(admin, language, route),
        components = nodes(view);
      assertUniqueCustomIds(view);
      expect(view.flags).toBe(MessageFlags.IsComponentsV2);
      expect(view.allowedMentions).toEqual({ parse: [] });
      expect(view).not.toHaveProperty('content');
      expect(view).not.toHaveProperty('embeds');
      expect(components.length).toBeLessThanOrEqual(40);
      expect(
        components
          .filter((n) => n.type === ComponentType.TextDisplay)
          .map((n) => n.content)
          .join('').length,
      ).toBeLessThanOrEqual(4000);
      for (const node of components) {
        if (node.type === ComponentType.ActionRow)
          expect(node.components!.length).toBeLessThanOrEqual(
            node.components![0]!.type === ComponentType.Button ? 5 : 1,
          );
        if (node.options) expect(node.options.length).toBeLessThanOrEqual(25);
        if (node.custom_id) expect(node.custom_id.length).toBeLessThanOrEqual(100);
      }
      if (route.page !== 'home') {
        expect(actionId(view, 'back', 'na')).toBeDefined();
        expect(actionId(view, 'home', 'na')).toBeDefined();
      }
    }
  },
);
test('all 150 catalogue entries and parent icons are reachable, with page clamping after removals', () => {
  for (let i = 0; i < 150; i++) f.add(game({ name: `Game ${i.toString().padStart(3, '0')}` }));
  const first = select(views.render(admin, 'fr', catalogue)),
    last = select(
      views.render(admin, 'en', {
        ...catalogue,
        page: 'catalogue',
        filter: 'all',
        query: '',
        index: 7,
      }),
    );
  expect(first).toHaveLength(20);
  expect(last).toHaveLength(10);
  expect(new Set([...first, ...last].map((o) => o.value)).size).toBe(30);
  const clamped = views.render(admin, 'fr', {
    page: 'catalogue',
    filter: 'all',
    query: 'Game 149',
    index: 7,
  });
  expect(select(clamped)).toHaveLength(1);
  const s = f.repository.session(actionId(clamped, 'game', 'na').split(':')[2]!)!;
  expect(s.data.route).toMatchObject({ query: 'Game 149', index: 0 });
});
test('retired entries are explicitly separated from available catalogue games', () => {
  const current = f.add(game({ name: 'Available' })),
    retired = f.add(game({ name: 'Retired', retired: true }));
  expect(select(views.render(admin, 'fr', catalogue)).map((o) => o.value)).toEqual([current.id]);
  expect(
    select(
      views.render(admin, 'fr', { page: 'catalogue', filter: 'retired', query: '', index: 0 }),
    ).map((o) => o.value),
  ).toEqual([retired.id]);
  const detail = views.render(admin, 'fr', { page: 'game', id: retired.id, back: catalogue });
  expect(JSON.stringify(detail)).toContain(translator('fr')('a.retiredHelp'));
  expect(
    controls(detail).filter(
      (n) => !['back', 'home'].some((a) => n.custom_id!.startsWith(`na:${a}:`)),
    ),
  ).toHaveLength(0);
});
test('helpers and colors distinguish navigation, actions and destructive decisions', () => {
  const g = f.add(game()),
    p = {
      id: 'p',
      actorId: member.id,
      name: 'Game',
      url: 'https://example.com',
      status: 'pending' as const,
      reason: null,
      gameId: null,
      createdAt: 1,
      locale: 'fr' as const,
    };
  f.repository.saveProposal(p);
  const detail = views.render(admin, 'fr', {
      page: 'request',
      id: p.id,
      back: { page: 'requests', filter: 'open', query: '', index: 0 },
    }),
    buttons = controls(detail);
  expect(buttons.find((n) => n.custom_id?.includes(':approve:'))?.style).toBe(ButtonStyle.Success);
  expect(buttons.find((n) => n.custom_id?.includes(':clarify:'))?.style).toBe(ButtonStyle.Primary);
  expect(buttons.find((n) => n.custom_id?.includes(':reject:'))?.style).toBe(ButtonStyle.Danger);
  expect(
    buttons
      .filter((n) => /:(home|back):/.test(n.custom_id!))
      .every((n) => n.style === ButtonStyle.Secondary),
  ).toBe(true);
  expect(
    JSON.stringify(views.render(admin, 'fr', { page: 'game', id: g.id, back: catalogue })),
  ).toContain(translator('fr')('a.gameHelp'));
  const empty = views.render(admin, 'en', {
    page: 'requests',
    filter: 'open',
    query: 'Nothing',
    index: 0,
  });
  expect(JSON.stringify(empty)).toContain(translator('en')('noAdminRequests'));
  expect(nodes(empty).some((n) => n.type === ComponentType.StringSelect)).toBe(false);
});
test('long rotation reviews remain below text limits and expose every game through pagination', async () => {
  const service = new Administration(f.nexus, () => f.clock.now()),
    plan = await service.plan(admin, { kind: 'rotate' });
  const details = Array.from({ length: 50 }, (_, i) => `${i}: ${'_'.repeat(100)}`),
    route: AdminRoute = { page: 'confirm', plan, details, back: { page: 'maintenance' }, index: 0 };
  const first = views.render(admin, 'fr', route),
    last = views.render(admin, 'fr', { ...route, index: 4 });
  expect(JSON.stringify(first)).toContain('0:');
  expect(JSON.stringify(first)).not.toContain('49:');
  expect(JSON.stringify(last)).toContain('49:');
  expect(actionId(first, 'next', 'na')).toBeDefined();
  expect(
    nodes(first)
      .filter((n) => n.type === ComponentType.TextDisplay)
      .map((n) => n.content)
      .join('').length,
  ).toBeLessThanOrEqual(4000);
});
test('members cannot render sensitive admin data directly', () => {
  expect(() => views.render(member, 'fr')).toThrow('adminOnly');
});

test('long legacy aliases stay readable and their full edit review remains paginated', async () => {
  const aliases = Array.from({ length: 20 }, (_, i) => `${i}${'_'.repeat(98)}`),
    g = f.add(game({ aliases })),
    view = views.render(admin, 'fr', { page: 'game', id: g.id, back: catalogue });
  const text = nodes(view)
    .filter((n) => n.type === ComponentType.TextDisplay)
    .map((n) => n.content)
    .join('');
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain('15 autres alias');
  expect(view.files).toHaveLength(1);
  expect(JSON.stringify(view.components)).toContain('attachment://game.png');
});
