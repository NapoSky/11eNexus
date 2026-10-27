import { archiveCandidates, channelName, DAY, normalize } from '../src/domain/model.js';
import { game, now } from './helpers.js';

test('30 days inclusively, preserving the fifteen most recently active established games', () => {
  const games = Array.from({ length: 20 }, (_, i) =>
    game({ id: String(i).padStart(2, '0'), lastActivityAt: now - (30 + i) * DAY }),
  );
  expect(archiveCandidates(games, now, 15).map((g) => g.id)).toEqual([
    '15',
    '16',
    '17',
    '18',
    '19',
  ]);
  expect(archiveCandidates(games, now, 0)).toHaveLength(20);
  expect(archiveCandidates([game({ lastActivityAt: now - 30 * DAY + 1 })], now, 0)).toHaveLength(0);
});
test('48-hour provisional activations do not displace or get protected by the baseline', () => {
  const normal = Array.from({ length: 15 }, () => game());
  const expired = game({ awaitingActivity: true, activatedAt: now - 2 * DAY });
  const fresh = game({ awaitingActivity: true, activatedAt: now - 2 * DAY + 1 });
  expect(archiveCandidates([...normal, expired, fresh], now, 15)).toEqual([expired]);
});
test('blocked and nonactive games are never automatically moved', () => {
  expect(
    archiveCandidates(
      [game({ blocked: true }), game({ state: 'archived' }), game({ state: 'unavailable' })],
      now,
      0,
    ),
  ).toEqual([]);
});
test('normalized aliases support accents and keep nonlatin game names', () => {
  expect(normalize('  Éco: 2 — 雪  ')).toBe('eco 2 雪');
  expect(channelName('Project Zomboid!')).toBe('project-zomboid');
});
