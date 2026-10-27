import {
  ComponentType,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
} from 'discord.js';
import { Views, ownedSession, session, type View } from '../src/presentation/views.js';
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
function components(view: View) {
  return JSON.parse(
    JSON.stringify(view.components),
  ) as APIActionRowComponent<APIComponentInMessageActionRow>[];
}
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
  const first = components(views.browse(member, 'fr'));
  const last = components(views.browse(member, 'en', 'active', 7));
  expect(first).toHaveLength(3);
  expect(first[0]?.components[0]?.type).toBe(ComponentType.StringSelect);
  const firstSelect = first[0]!.components[0]!;
  const lastSelect = last[0]!.components[0]!;
  if (
    firstSelect.type !== ComponentType.StringSelect ||
    lastSelect.type !== ComponentType.StringSelect
  )
    throw new Error('select expected');
  expect(firstSelect.options).toHaveLength(20);
  expect(lastSelect.options).toHaveLength(10);
  expect(new Set([...firstSelect.options, ...lastSelect.options].map((o) => o.value)).size).toBe(
    30,
  );
  expect(first[2]?.components).toHaveLength(4);
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
    const first = components(views.browse(member, language, 'archived', 0))[0]!.components[0]!;
    const last = components(views.browse(member, language, 'archived', 2))[0]!.components[0]!;
    if (first.type !== ComponentType.StringSelect || last.type !== ComponentType.StringSelect)
      throw new Error('select expected');
    expect(first.options).toHaveLength(20);
    expect(last.options).toHaveLength(1);
    expect(new Set([...first.options, ...last.options].map((o) => o.value)).size).toBe(21);
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
  const view = components(views.proposals(member, 'fr', false, 2));
  const select = view[0]!.components[0]!;
  if (select.type !== ComponentType.StringSelect) throw new Error('select');
  expect(select.options).toHaveLength(5);
  expect(components(views.proposals(outsider, 'en'))).toHaveLength(1);
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
  const row = components(view)[0]!;
  expect(row.components[0]).toMatchObject({ disabled: true });
  expect(JSON.stringify(row)).toContain('nx:manual:');
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
