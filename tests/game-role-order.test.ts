import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { GAME_ROLE_MARKER } from '../src/application/resource-audit.js';
import { gameRolePositions, GameRoleOrder } from '../src/infrastructure/game-role-order.js';

const role = (id: string, name: string, position: number, managed = false) => ({
  id,
  name,
  position,
  rawPosition: position,
  managed,
  permissions: { bitfield: 0n },
  guild: { id: 'guild' },
});
const marker = role(GAME_ROLE_MARKER, 'Jeux réguliers', 9);
test('sorts top to bottom including untracked roles, with accents, natural numbers and stable duplicate names', () => {
  const input = [
    marker,
    role('1', 'Zulu', 8),
    role('2', 'éco', 7),
    role('3', 'Alpha 10', 6),
    role('4', 'Álpha 2', 5),
    role('5', 'ALPHA 2', 4),
    role('6', 'Integration', 3, true),
    role('7', 'Staff', 10),
    role('guild', '@everyone', 0),
  ];
  const before = structuredClone(input);
  expect(gameRolePositions(input, 'guild')).toEqual([
    { role: 'guild', position: 0 },
    { role: '6', position: 3 },
    { role: '1', position: 4 },
    { role: '2', position: 5 },
    { role: '3', position: 6 },
    { role: '5', position: 7 },
    { role: '4', position: 8 },
    { role: GAME_ROLE_MARKER, position: 9 },
    { role: '7', position: 10 },
  ]);
  expect(input).toEqual(before);
});
test('duplicate raw positions are normalized with anchors so games cannot cross the marker or bot', () => {
  const raw = [
    { id: '1000', name: '@everyone', rawPosition: 0, managed: false },
    { id: '1', name: 'Zulu', rawPosition: 1, managed: false },
    { id: '2', name: 'Alpha', rawPosition: 1, managed: false },
    { id: '3', name: 'Beta', rawPosition: 2, managed: false },
    { id: '4', name: 'Aardvark', rawPosition: 1, managed: false },
    { id: GAME_ROLE_MARKER, name: 'Marker', rawPosition: 3, managed: false },
    { id: '2001', name: 'Staff', rawPosition: 4, managed: false },
    { id: '2000', name: 'Bot', rawPosition: 5, managed: true },
  ];
  const snapshot = () =>
    [...raw]
      .sort((a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
      .map((r, position) => ({ ...r, position }));
  const before = snapshot();
  const positions = gameRolePositions(before, '1000');
  expect(positions).toHaveLength(raw.length);
  for (const p of positions) raw.find((r) => r.id === p.role)!.rawPosition = p.position;
  const after = snapshot();
  expect(
    after
      .slice(1, 5)
      .reverse()
      .map((r) => r.name),
  ).toEqual(['Aardvark', 'Alpha', 'Beta', 'Zulu']);
  for (const id of ['1000', GAME_ROLE_MARKER, '2001', '2000'])
    expect(after.find((r) => r.id === id)!.position).toBe(
      before.find((r) => r.id === id)!.position,
    );
  expect(gameRolePositions(after, '1000')).toEqual([]);
});
test('a correct order, empty block and singleton never write, including managed-role gaps', () => {
  for (const input of [
    [marker],
    [marker, role('1', 'Zulu', 1)],
    [marker, role('1', 'Alpha', 8), role('2', 'Bot', 7, true), role('3', 'Zulu', 1)],
  ])
    expect(gameRolePositions(input, 'guild')).toEqual([]);
});
test('missing or invalid marker and invalid effective positions fail closed', () => {
  for (const input of [
    [],
    [{ ...marker, managed: true }],
    [{ ...marker, position: Number.NaN }],
    [marker, role('1', 'Alpha', 9)],
  ])
    expect(() => gameRolePositions(input, 'guild')).toThrow('configuration');
});
function listener(sort = jest.fn(async () => {})) {
  const events = new EventEmitter(),
    warn = jest.fn();
  const order = new GameRoleOrder(events as unknown as Client, 'guild', sort, { warn });
  order.listen();
  return { events, order, sort, warn };
}
afterEach(() => jest.useRealTimers());
test('role creates, deletions, renames, position and permission changes are debounced; icon and other guild updates are ignored', async () => {
  jest.useFakeTimers();
  const f = listener(),
    r = role('1', 'Zulu', 1);
  f.events.emit(Events.GuildRoleCreate, r);
  f.events.emit(Events.GuildRoleDelete, r);
  f.events.emit(Events.GuildRoleUpdate, r, { ...r, name: 'Alpha' });
  f.events.emit(Events.GuildRoleUpdate, r, { ...r, rawPosition: 2 });
  f.events.emit(Events.GuildRoleUpdate, r, { ...r, permissions: { bitfield: 1n } });
  await jest.advanceTimersByTimeAsync(1999);
  expect(f.sort).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(f.sort).toHaveBeenCalledTimes(1);
  f.events.emit(Events.GuildRoleCreate, { ...r, guild: { id: 'other' } });
  f.events.emit(Events.GuildRoleUpdate, r, { ...r, icon: 'new' });
  await jest.advanceTimersByTimeAsync(2000);
  expect(f.sort).toHaveBeenCalledTimes(1);
  await f.order.stop();
});
test('periodic checks recover from failure, never overlap and stop drains work and removes listeners', async () => {
  jest.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sort = jest.fn(async () => {});
  sort.mockRejectedValueOnce(new Error('private message'));
  const f = listener(sort);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'game_role_order_failed' }));
  sort.mockImplementationOnce(() => pending);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).toHaveBeenCalledTimes(2);
  const stopping = f.order.stop();
  release();
  await stopping;
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).toHaveBeenCalledTimes(2);
  expect(f.events.listenerCount(Events.GuildRoleUpdate)).toBe(0);
});
