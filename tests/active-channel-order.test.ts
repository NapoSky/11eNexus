import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import {
  ActiveChannelOrder,
  activeChannelPositions,
} from '../src/infrastructure/active-channel-order.js';

const channel = (id: string, name: string, rawPosition: number, type = 0, parentId = 'active') => ({
  id,
  name,
  rawPosition,
  type,
  parentId,
  guild: { id: 'guild' },
});

test('orders all textual channels and forums by visible name, ignoring accents/case with natural numbers', () => {
  const input = [
    channel('1', 'Zulu', 19),
    channel('2', 'Éco-forum', 32, 15),
    channel('3', 'alpha-10', 75),
    channel('4', 'ÁLPHA-2', 100),
    channel('5', 'a-voice', 1, 2),
    channel('6', 'a-archived-game', 2, 0, 'archive'),
    channel('7', 'beta-media', 77, 16),
    channel('8', 'delta-news', 78, 5),
  ];
  const before = structuredClone(input);
  expect(activeChannelPositions(input, 'active')).toEqual([
    { channel: '4', position: 0 },
    { channel: '3', position: 1 },
    { channel: '7', position: 2 },
    { channel: '8', position: 3 },
    { channel: '2', position: 4 },
    { channel: '1', position: 5 },
  ]);
  expect(input).toEqual(before);
});

test('ties in Discord positions and equivalent names have a stable snowflake order', () => {
  expect(
    activeChannelPositions([channel('10', 'Zulu', 0), channel('2', 'Alpha', 0)], 'active'),
  ).toEqual([]);
  expect(
    activeChannelPositions([channel('10', 'ALPHA', 0), channel('2', 'álpha', 1)], 'active'),
  ).toEqual([
    { channel: '2', position: 0 },
    { channel: '10', position: 1 },
  ]);
});

test('empty, singleton and already alphabetical categories need no write despite sparse positions', () => {
  for (const input of [
    [],
    [channel('1', 'alpha', 100)],
    [channel('1', 'alpha', 19), channel('2', 'beta', 100)],
  ])
    expect(activeChannelPositions(input, 'active')).toEqual([]);
});

function listener(sort = jest.fn(async () => {})) {
  const events = new EventEmitter();
  const warn = jest.fn();
  const order = new ActiveChannelOrder(events as unknown as Client, 'guild', 'active', sort, {
    warn,
  });
  order.listen();
  return { events, order, sort, warn };
}
afterEach(() => jest.useRealTimers());
test('event ordering follows the category created after the runtime listener was installed', async () => {
  jest.useFakeTimers();
  const events = new EventEmitter(),
    sort = jest.fn(async () => {});
  let categoryId: string | null = null;
  const order = new ActiveChannelOrder(
    events as unknown as Client,
    'guild',
    () => categoryId,
    sort,
  );
  order.listen();
  events.emit(Events.ChannelCreate, channel('1', 'Zulu', 1, 0, 'event-active'));
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).not.toHaveBeenCalled();
  categoryId = 'event-active';
  events.emit(Events.ChannelCreate, channel('1', 'Zulu', 1, 0, 'event-active'));
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).toHaveBeenCalledTimes(1);
  await order.stop();
});

test('bursts of creation, rename, moves and deletion coalesce; unrelated updates are ignored', async () => {
  jest.useFakeTimers();
  const f = listener(),
    active = channel('1', 'zulu', 1);
  f.events.emit(Events.ChannelCreate, active);
  f.events.emit(Events.ChannelUpdate, active, { ...active, name: 'alpha' });
  f.events.emit(Events.ChannelUpdate, active, { ...active, parentId: 'archive' });
  f.events.emit(Events.ChannelDelete, active);
  await jest.advanceTimersByTimeAsync(1999);
  expect(f.sort).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(f.sort).toHaveBeenCalledTimes(1);
  f.events.emit(Events.ChannelUpdate, active, { ...active, topic: 'new topic' });
  f.events.emit(Events.ChannelCreate, { ...active, guild: { id: 'other' } });
  f.events.emit(Events.ChannelCreate, { ...active, parentId: 'archive' });
  f.events.emit(Events.ChannelDelete, { id: 'dm' });
  f.events.emit(Events.ChannelCreate, channel('9', 'voice', 0, 2));
  await jest.advanceTimersByTimeAsync(2000);
  expect(f.sort).toHaveBeenCalledTimes(1);
  await f.order.stop();
});

test('position changes and explicit periodic checks trigger another check, including after errors', async () => {
  jest.useFakeTimers();
  const sort = jest.fn(async () => {});
  sort.mockRejectedValueOnce(new Error('private failure'));
  const f = listener(sort),
    active = channel('1', 'alpha', 1);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  expect(f.warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'active_channel_order_failed' }),
  );
  f.events.emit(Events.ChannelUpdate, active, { ...active, rawPosition: 2 });
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).toHaveBeenCalledTimes(2);
  await f.order.stop();
});

test('sorts never overlap and shutdown waits for the running check and cancels queued work', async () => {
  jest.useFakeTimers();
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sort = jest.fn(() => first),
    f = listener(sort);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).toHaveBeenCalledTimes(1);
  f.order.request();
  await jest.advanceTimersByTimeAsync(2000);
  let stopped = false;
  const stop = f.order.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stop;
  f.order.request();
  f.events.emit(Events.ChannelCreate, channel('1', 'alpha', 0));
  await jest.advanceTimersByTimeAsync(2000);
  expect(sort).toHaveBeenCalledTimes(1);
  expect(f.events.listenerCount(Events.ChannelUpdate)).toBe(0);
});
