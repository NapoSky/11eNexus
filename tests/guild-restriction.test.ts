import { EventEmitter } from 'node:events';
import { Collection, Events, type Client, type Guild } from 'discord.js';
import { NEXUS_GUILD_ID } from '../src/infrastructure/config.js';
import { GuildRestriction } from '../src/infrastructure/guild-restriction.js';

function fixture(initiallyReady = false) {
  let ready = initiallyReady;
  const events = new EventEmitter();
  const cache = new Collection<string, Guild>();
  const client = Object.assign(events, { guilds: { cache }, isReady: () => ready });
  const log = { info: jest.fn(), warn: jest.fn() };
  const restriction = new GuildRestriction(client as unknown as Client, log);
  const guild = (id: string) => {
    const value = {
      id,
      leave: jest.fn(async (): Promise<void> => {
        cache.delete(id);
      }),
    };
    cache.set(id, value as unknown as Guild);
    return value;
  };
  return {
    events,
    cache,
    log,
    restriction,
    guild,
    ready() {
      ready = true;
      events.emit(Events.ClientReady);
    },
  };
}

test('the startup scan leaves every other guild and never leaves the 11e', async () => {
  const f = fixture();
  const allowed = f.guild(NEXUS_GUILD_ID);
  const first = f.guild('100000000000000001');
  const second = f.guild('100000000000000002');
  f.restriction.listen();
  expect(first.leave).not.toHaveBeenCalled();
  f.ready();
  await f.restriction.drain();
  expect(allowed.leave).not.toHaveBeenCalled();
  expect(first.leave).toHaveBeenCalledTimes(1);
  expect(second.leave).toHaveBeenCalledTimes(1);
  expect([...f.cache.keys()]).toEqual([NEXUS_GUILD_ID]);
  expect(f.log.info).toHaveBeenCalledWith({
    event: 'unauthorized_guild_left',
    guildId: first.id,
  });
});

test('late installation of the listener still cleans an already connected client', async () => {
  const f = fixture(true);
  const foreign = f.guild('100000000000000001');
  f.restriction.listen();
  await f.restriction.drain();
  expect(foreign.leave).toHaveBeenCalledTimes(1);
});

test('new installations outside the 11e are left immediately, including when the 11e is absent', async () => {
  const f = fixture(true);
  f.restriction.listen();
  const allowed = f.guild(NEXUS_GUILD_ID);
  f.events.emit(Events.GuildCreate, allowed);
  const foreign = f.guild('100000000000000001');
  f.cache.delete(NEXUS_GUILD_ID);
  f.events.emit(Events.GuildCreate, foreign);
  await f.restriction.drain();
  expect(allowed.leave).not.toHaveBeenCalled();
  expect(foreign.leave).toHaveBeenCalledTimes(1);
});

test('construction alone never mutates Discord or registers runtime listeners', async () => {
  const f = fixture(true);
  const foreign = f.guild('100000000000000001');
  f.events.emit(Events.ClientReady);
  f.events.emit(Events.GuildCreate, foreign);
  await f.restriction.drain();
  expect(foreign.leave).not.toHaveBeenCalled();
  expect(f.events.listenerCount(Events.GuildCreate)).toBe(0);
});

test('repeated listener registration is harmless and repeated ready events protect the 11e', async () => {
  const f = fixture();
  const allowed = f.guild(NEXUS_GUILD_ID);
  f.restriction.listen();
  f.restriction.listen();
  f.ready();
  f.ready();
  await f.restriction.drain();
  expect(f.events.listenerCount(Events.ClientReady)).toBe(1);
  expect(f.events.listenerCount(Events.GuildCreate)).toBe(1);
  expect(allowed.leave).not.toHaveBeenCalled();
});

test('an overlapping startup scan, periodic scan and join event share one leave request', async () => {
  const f = fixture(true);
  const foreign = f.guild('100000000000000001');
  let release!: () => void;
  foreign.leave.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
  f.restriction.listen();
  f.events.emit(Events.GuildCreate, foreign);
  const scan = f.restriction.enforce();
  await Promise.resolve();
  expect(foreign.leave).toHaveBeenCalledTimes(1);
  release();
  await scan;
  await f.restriction.drain();
  expect(foreign.leave).toHaveBeenCalledTimes(1);
});

test('a failed leave is logged, does not block other departures and is retried on the next scan', async () => {
  const f = fixture(true);
  const allowed = f.guild(NEXUS_GUILD_ID);
  const failed = f.guild('100000000000000001');
  const other = f.guild('100000000000000002');
  const error = Object.assign(new Error('synthetic private error'), { code: 50013 });
  failed.leave.mockRejectedValueOnce(error);
  f.restriction.listen();
  await f.restriction.drain();
  expect(f.log.warn).toHaveBeenCalledWith({
    event: 'unauthorized_guild_leave_failed',
    guildId: failed.id,
    err: error,
  });
  expect(other.leave).toHaveBeenCalledTimes(1);
  await f.restriction.enforce();
  expect(failed.leave).toHaveBeenCalledTimes(2);
  expect(other.leave).toHaveBeenCalledTimes(1);
  expect(allowed.leave).not.toHaveBeenCalled();
});

test('a periodic scan while disconnected does not send requests', async () => {
  const f = fixture();
  const foreign = f.guild('100000000000000001');
  await f.restriction.enforce();
  expect(foreign.leave).not.toHaveBeenCalled();
});

test('shutdown unregisters listeners and drains a departure before Discord is disconnected', async () => {
  const f = fixture(true);
  const foreign = f.guild('100000000000000001');
  let release!: () => void;
  foreign.leave.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
  f.restriction.listen();
  await Promise.resolve();
  f.restriction.stopAccepting();
  let drained = false;
  const drain = f.restriction.drain().then(() => (drained = true));
  const later = f.guild('100000000000000002');
  f.events.emit(Events.GuildCreate, later);
  f.ready();
  f.restriction.listen();
  await f.restriction.enforce();
  expect(f.events.listenerCount(Events.ClientReady)).toBe(0);
  expect(f.events.listenerCount(Events.GuildCreate)).toBe(0);
  expect(later.leave).not.toHaveBeenCalled();
  expect(drained).toBe(false);
  release();
  await drain;
  expect(drained).toBe(true);
});

test('shutdown cancels a departure that has not started yet', async () => {
  const f = fixture(true);
  const foreign = f.guild('100000000000000001');
  f.restriction.listen();
  f.restriction.stopAccepting();
  await f.restriction.drain();
  expect(foreign.leave).not.toHaveBeenCalled();
});
