import { ComponentType, MessageFlags, ButtonStyle } from 'discord.js';
import { nodes, controls, select, actionId } from './component-helpers.js';
import { Views, ownedSession, session, editView, type View } from '../src/presentation/views.js';
import { commands } from '../src/presentation/commands.js';
import { locale, translator, languagesReady } from '../src/presentation/i18n.js';
import fr from '../src/locales/fr.json';
import en from '../src/locales/en.json';
import { admin, fixture, game, member, outsider } from './helpers.js';

let f: ReturnType<typeof fixture>;
let views: Views;
beforeEach(async () => {
  await languagesReady;
  f = fixture();
  views = new Views(f.repository, '100000000000000000');
});
afterEach(() => f.repository.close());
test('FR/EN keys and interpolation placeholders are identical with English fallback', () => {
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[])
    expect(fr[key].match(/{{[^}]+}}/g) || []).toEqual(en[key].match(/{{[^}]+}}/g) || []);
  expect(locale('fr-CA')).toBe('fr');
  expect(locale('de')).toBe('en');
  expect(translator('fr')('cooldown', { minutes: 42 })).toContain('42');
});
test('150 games fit within Discord component limits and are paginated 20 at a time', () => {
  for (let i = 0; i < 150; i++)
    f.repository.saveGame(game({ name: `Game ${i.toString().padStart(3, '0')}` }));
  const first = select(views.browse(member, 'fr'));
  const last = select(views.browse(member, 'en', 'active', 7));
  expect(first).toHaveLength(20);
  expect(last).toHaveLength(10);
  expect(new Set([...first, ...last].map((o) => o.value)).size).toBe(30);
});
test.each(['fr', 'en'] as const)(
  'the %s catalogue distinguishes active games from the full import and paginates archives',
  (language) => {
    for (let i = 0; i < 15; i++) f.add(game({ name: `Active ${i}` }));
    for (let i = 0; i < 41; i++) f.add(game({ name: `Archived ${i}`, state: 'archived' }));
    const active = JSON.stringify(views.browse(member, language));
    expect(active).toContain('56');
    expect(active).toContain('15');
    expect(active).toContain('41');
    expect(active).not.toContain('Archived 0');
    const first = select(views.browse(member, language, 'archived', 0));
    const last = select(views.browse(member, language, 'archived', 2));
    expect(first).toHaveLength(20);
    expect(last).toHaveLength(1);
    expect(new Set([...first, ...last].map((o) => o.value)).size).toBe(21);
  },
);
test('a personal interaction cannot be reused by another user and expires after 15 minutes', () => {
  const s = session(f.repository, member.id, 'game', { gameId: 'x' });
  expect(ownedSession(f.repository, member.id, s.id)).toEqual(s);
  expect(() => ownedSession(f.repository, outsider.id, s.id)).toThrow('expired');
  f.repository.saveSession({ ...s, expiresAt: Date.now() - 1 });
  expect(() => ownedSession(f.repository, member.id, s.id)).toThrow('expired');
});
test('all proposals remain reachable after the first 20 and are isolated by requester', () => {
  for (let i = 0; i < 45; i++)
    f.repository.saveProposal({
      id: `p${i}`,
      actorId: member.id,
      name: `Game ${i}`,
      url: 'https://example.com',
      createdAt: i,
      status: 'pending',
      reason: null,
      gameId: null,
      locale: 'fr',
    });
  expect(select(views.proposals(member, 'fr', false, 2))).toHaveLength(5);
  expect(
    nodes(views.proposals(outsider, 'en')).some((n) => n.type === ComponentType.StringSelect),
  ).toBe(false);
  expect(() => views.proposals(member, 'fr', true)).toThrow('adminOnly');
});
test('a game card does not conflate channel visibility and notification preference', () => {
  const g = f.add(game({ name: 'Project Zomboid', state: 'archived' }));
  const view = views.game(member, 'fr', g.id);
  const text = JSON.stringify(view);
  expect(text).toContain('nx:activate:');
  expect(text).toContain('nx:subscribe:');
  expect(text).not.toContain('nx:notify:');
  expect(text).not.toContain('discord.com/channels');
  expect(view.allowedMentions).toEqual({ parse: [] });
});
test.each(['fr', 'en'] as const)(
  'the %s game card identifies the role to mention without pinging it',
  (language) => {
    const g = f.add(game());
    const view = views.game(member, language, g.id);
    expect(JSON.stringify(view)).toContain(`<@&${g.roleId}>`);
    expect(view.allowedMentions).toEqual({ parse: [] });
  },
);
test('an accepted proposal links to its active channel while another member cannot view it', () => {
  const g = f.add(game());
  const p = {
    id: 'p',
    actorId: member.id,
    name: 'Game',
    url: 'https://example.com',
    createdAt: 1,
    status: 'accepted' as const,
    reason: null,
    gameId: g.id,
    locale: 'fr' as const,
  };
  expect(JSON.stringify(views.proposal(member, 'fr', p))).toContain(g.channelId);
  expect(() => views.proposal(outsider, 'fr', p)).toThrow('forbidden');
  expect(() => views.proposal(admin, 'fr', p)).not.toThrow();
});
test('a missing image disables creation and leaves the manual review path available', () => {
  const view = views.candidate(
    member,
    'en',
    {
      id: 1,
      name: 'Wardogs',
      studio: 'Studio',
      released: null,
      imageUrl: null,
      url: 'https://rawg.io/games/1',
    },
    null,
  );
  expect(controls(view).find((n) => n.custom_id?.startsWith('nx:create:'))).toMatchObject({
    disabled: true,
  });
  expect(JSON.stringify(view)).toContain('nx:manual:');
});
test('all command and option descriptions are localized in French', () => {
  function check(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.description === 'string')
      expect(object.description_localizations).toHaveProperty('fr');
    if (Array.isArray(object.options)) for (const option of object.options) check(option);
  }
  for (const command of commands()) check(command);
});
test('a request for details offers an owner-only amendment action', () => {
  const p = {
    id: 'proposal',
    actorId: member.id,
    name: 'Game',
    url: 'https://example.com',
    createdAt: 1,
    status: 'needs_info' as const,
    reason: 'Which edition?',
    gameId: null,
    locale: 'en' as const,
  };
  expect(JSON.stringify(views.proposal(member, 'en', p))).toContain('nx:amend:');
  expect(JSON.stringify(views.proposal(admin, 'fr', p))).not.toContain('nx:amend:');
});

test.each(['fr', 'en'] as const)(
  '%s screens serialize as valid V2 messages within Discord limits',
  (language) => {
    for (let i = 0; i < 150; i++)
      f.add(game({ name: `Game ${i}`, state: i < 15 ? 'active' : 'archived', assetId: 'asset' }));
    const g = f.repository.games()[0]!;
    const candidate = {
      id: 123,
      name: 'Example game',
      studio: 'Studio',
      released: '2026-01-01',
      imageUrl: null,
      url: 'https://rawg.io/games/123',
    };
    const proposal = {
      id: 'p',
      actorId: member.id,
      name: 'A game',
      url: 'https://example.com',
      createdAt: 1,
      status: 'needs_info' as const,
      reason: 'Which edition?',
      gameId: null,
      locale: language,
    };
    const screens: View[] = [
      views.panel(),
      views.movedPanel('123'),
      views.home(member, language),
      views.home(admin, language),
      views.game(member, language, g.id),
      views.candidates(member, language, 'Example', [candidate]),
      views.candidates(member, language, 'Unknown', []),
      views.candidate(member, language, candidate, 'asset'),
      views.candidate(member, language, candidate, null),
      views.proposals(member, language),
      views.proposals(admin, language, true),
      views.proposal(member, language, proposal),
      views.feedback(language, 'Try again', true),
    ];
    for (const mode of ['active', 'archived', 'all', 'subscribed'] as const) {
      for (let page = 0; page < 8; page++)
        screens.push(views.browse(admin, language, mode, page, 'Game'));
    }
    for (const screen of screens) {
      expect(screen.flags).toBe(MessageFlags.IsComponentsV2);
      expect(screen).not.toHaveProperty('content');
      expect(screen).not.toHaveProperty('embeds');
      const serialized = nodes(screen);
      expect(serialized.length).toBeLessThanOrEqual(40);
      expect(
        serialized
          .filter((n) => n.type === ComponentType.TextDisplay)
          .map((n) => n.content)
          .join('').length,
      ).toBeLessThanOrEqual(4000);
      for (const n of serialized) {
        if (n.type === ComponentType.ActionRow) {
          expect(n.components!.length).toBeLessThanOrEqual(
            n.components?.[0]?.type === ComponentType.StringSelect ? 1 : 5,
          );
        }
        if (n.custom_id) expect(n.custom_id.length).toBeLessThanOrEqual(100);
        if (n.options) expect(n.options.length).toBeLessThanOrEqual(25);
      }
      expect(screen.allowedMentions).toEqual({ parse: [] });
      expect(editView(screen)).toMatchObject({
        content: null,
        embeds: [],
        attachments: [],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  },
);

test('navigation is gray, adding/subscribing green, revival blue and unsubscribing red', () => {
  const g = f.add(game({ state: 'archived' }));
  const card = views.game(member, 'fr', g.id);
  const buttons = controls(card);
  expect(buttons.find((n) => n.custom_id?.includes(':activate:'))?.style).toBe(ButtonStyle.Primary);
  expect(buttons.find((n) => n.custom_id?.includes(':subscribe:'))?.style).toBe(
    ButtonStyle.Success,
  );
  for (const action of ['back', 'home'])
    expect(buttons.find((n) => n.custom_id?.includes(`:${action}:`))?.style).toBe(
      ButtonStyle.Secondary,
    );
  f.repository.subscribe(g.id, member.id, true);
  expect(
    controls(views.game(member, 'fr', g.id)).find((n) => n.custom_id?.includes(':unsubscribe:'))
      ?.style,
  ).toBe(ButtonStyle.Danger);
  const catalogue = controls(views.browse(member, 'fr', 'all', 0, 'game'));
  expect(
    catalogue
      .filter((n) => n.custom_id?.includes(':browse-'))
      .every((n) => n.style === ButtonStyle.Secondary),
  ).toBe(true);
  expect(catalogue.find((n) => n.custom_id?.includes(':propose:'))?.style).toBe(
    ButtonStyle.Success,
  );
  expect(catalogue.find((n) => n.custom_id?.includes(':clear:'))?.style).toBe(
    ButtonStyle.Secondary,
  );
});

test.each(['fr', 'en'] as const)(
  '%s empty views explain a next step and always offer home',
  (language) => {
    for (const mode of ['active', 'archived', 'all', 'subscribed'] as const) {
      const screen = views.browse(member, language, mode);
      expect(JSON.stringify(screen)).toContain(translator(language)(`emptyHelp_${mode}`));
      expect(controls(screen).some((n) => n.custom_id?.includes(':home:'))).toBe(true);
      expect(controls(screen).some((n) => n.custom_id?.includes(':propose:'))).toBe(true);
      expect(nodes(screen).some((n) => n.type === ComponentType.StringSelect)).toBe(false);
    }
    const emptySearch = views.browse(member, language, 'all', 0, 'Not found');
    expect(JSON.stringify(emptySearch)).toContain(translator(language)('emptySearchHelp'));
    expect(actionId(emptySearch, 'clear')).toBeDefined();
  },
);

test('quota and unavailable resources are explained before a disabled action', () => {
  const g = f.add(game({ state: 'archived' }));
  f.repository.setCooldown(member.id, Date.now());
  const screen = views.game(member, 'fr', g.id);
  expect(controls(screen).find((n) => n.custom_id?.includes(':activate:'))?.disabled).toBe(true);
  expect(JSON.stringify(screen)).toContain('minutes');
  expect(controls(screen).find((n) => n.custom_id?.includes(':subscribe:'))?.disabled).toBe(false);
  const missing = f.add(game({ state: 'archived', roleState: 'missing' }));
  const unavailable = views.game(member, 'fr', missing.id);
  expect(JSON.stringify(unavailable)).toContain(translator('fr')('gameNeedsHelp'));
  expect(
    controls(unavailable)
      .filter((n) => /:(activate|subscribe):/.test(n.custom_id!))
      .every((n) => n.disabled),
  ).toBe(true);
});

test('accepted archived requests open a game card without linking a hidden channel', () => {
  const g = f.add(game({ state: 'archived' }));
  const p = {
    id: 'p',
    actorId: member.id,
    name: 'Game',
    url: 'https://example.com',
    createdAt: 1,
    status: 'accepted' as const,
    reason: null,
    gameId: g.id,
    locale: 'fr' as const,
  };
  const screen = views.proposal(member, 'fr', p);
  expect(actionId(screen, 'proposal-game')).toBeDefined();
  expect(JSON.stringify(screen)).not.toContain('discord.com/channels');
  expect(controls(views.home(member, 'fr')).some((n) => n.custom_id?.includes(':admin:'))).toBe(
    false,
  );
  expect(controls(views.home(admin, 'fr')).some((n) => n.custom_id?.includes(':admin:'))).toBe(
    true,
  );
});
