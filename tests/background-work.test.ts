import { setImmediate } from 'node:timers/promises';
import { eventFixture } from './event-helpers.js';
import { fixture, game, member, admin, now } from './helpers.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test.each(['inventory', 'messages'] as const)(
  'event %s reads allow a member subscription to complete',
  async (phase) => {
    const f = eventFixture(),
      entered = deferred(),
      release = deferred();
    const tasks: Promise<unknown>[] = [];
    try {
      await f.create();
      if (phase === 'inventory')
        f.eventCommunity.inspect.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return structuredClone(f.eventCommunity.world);
        });
      else
        f.eventCommunity.messageStatus.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return 'present';
        });
      tasks.push(f.events.synchronize());
      await entered.promise;
      let subscribed = false;
      tasks.push(
        f.nexus.subscribe(member, f.parent.id, true).then(() => {
          subscribed = true;
        }),
      );
      await setImmediate();
      expect(subscribed).toBe(true);
      expect(f.repository.subscribers(f.parent.id)).toContain(member.id);
    } finally {
      release.resolve();
      await Promise.allSettled(tasks);
      f.repository.close();
    }
  },
);

test('a repaired message during an event scan cannot be overwritten by its old missing-message result', async () => {
  const f = eventFixture(),
    entered = deferred(),
    release = deferred();
  let scan: Promise<void> | undefined;
  try {
    const event = await f.create();
    f.eventCommunity.messageStatus.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'missing';
    });
    scan = f.events.synchronize();
    await entered.promise;
    await f.nexus.mutex.run(async () => {
      const repaired = f.repository.event(event.id)!;
      repaired.messageId = 'replacement';
      repaired.pinned = true;
      repaired.issue = null;
      f.repository.saveEvent(repaired);
    });
    release.resolve();
    await scan;
    expect(f.repository.event(event.id)).toMatchObject({
      messageId: 'replacement',
      pinned: true,
      issue: null,
    });
  } finally {
    release.resolve();
    await scan;
    f.repository.close();
  }
});

test('a repair that keeps the same message and fields still invalidates an older missing-message read', async () => {
  const f = eventFixture(),
    entered = deferred(),
    release = deferred();
  let scan: Promise<void> | undefined;
  try {
    const event = await f.create();
    f.eventCommunity.messageStatus.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'missing';
    });
    scan = f.events.synchronize();
    await entered.promise;
    await f.events.execute(
      admin,
      await f.events.plan(admin, { kind: 'repair', eventId: event.id }),
    );
    expect(f.repository.event(event.id)).toEqual(event);
    release.resolve();
    await scan;
    expect(f.repository.event(event.id)?.issue).toBeNull();
  } finally {
    release.resolve();
    await scan;
    f.repository.close();
  }
});

test('a manual move during event message reads is observed by the final inventory', async () => {
  const f = eventFixture(),
    entered = deferred(),
    release = deferred();
  let scan: Promise<void> | undefined;
  try {
    const event = await f.create();
    f.eventCommunity.messageStatus.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'present';
    });
    scan = f.events.synchronize();
    await entered.promise;
    f.eventCommunity.world.channels.find((c) => c.id === event.channelId)!.parentId = 'outside';
    release.resolve();
    await scan;
    expect(f.repository.event(event.id)?.issue).toBe('e.channelMissing');
    expect(f.eventCommunity.createChannel).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await scan;
    f.repository.close();
  }
});

test('shutdown cancels event reads before another event or any observation is saved', async () => {
  const f = eventFixture(),
    entered = deferred(),
    release = deferred(),
    abort = new AbortController();
  try {
    const first = await f.create();
    await f.create('Second event');
    f.eventCommunity.messageStatus.mockClear();
    f.eventCommunity.messageStatus.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'missing';
    });
    const scan = f.events.synchronize(abort.signal);
    const rejected = scan.catch((error) => error);
    await entered.promise;
    abort.abort();
    release.resolve();
    expect(await rejected).toBe(abort.signal.reason);
    expect(f.eventCommunity.messageStatus).toHaveBeenCalledTimes(1);
    expect(f.repository.event(first.id)?.issue).toBeNull();
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test('concurrent announcement deliveries join one send while member subscriptions proceed', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  const tasks: Promise<unknown>[] = [];
  try {
    const g = f.add(game({ rawgId: 123 }));
    f.repository.set(`new-game-announcement:${g.id}`, { status: 'pending', createdAt: now });
    f.community.announceNewGame.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'one-message';
    });
    tasks.push(f.nexus.deliverNewGameAnnouncements());
    await entered.promise;
    tasks.push(f.nexus.deliverNewGameAnnouncements(), f.nexus.create(member, g.rawgId!));
    let subscribed = false;
    tasks.push(
      f.nexus.subscribe(member, g.id, true).then(() => {
        subscribed = true;
      }),
    );
    await setImmediate();
    expect(subscribed).toBe(true);
    expect(f.repository.get(`new-game-announcement:${g.id}`)).toMatchObject({ status: 'sending' });
    release.resolve();
    await Promise.all(tasks);
    expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
    expect(f.community.alert).not.toHaveBeenCalled();
    expect(f.repository.get(`new-game-announcement:${g.id}`)).toMatchObject({
      status: 'sent',
      messageId: 'one-message',
    });
  } finally {
    release.resolve();
    await Promise.allSettled(tasks);
    f.repository.close();
  }
});

test('a new creation releases the application mutex before its discovery announcement', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  const tasks: Promise<unknown>[] = [];
  try {
    const other = f.add(game({ rawgId: 456 }));
    f.community.announceNewGame.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'one-message';
    });
    tasks.push(f.nexus.create(member, 123));
    await entered.promise;
    let subscribed = false;
    tasks.push(
      f.nexus.subscribe(member, other.id, true).then(() => {
        subscribed = true;
      }),
    );
    await setImmediate();
    expect(subscribed).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled(tasks);
    f.repository.close();
  }
});

test('shutdown does not claim the next announcement after its current send completes', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred(),
    abort = new AbortController();
  try {
    for (const id of ['a', 'b']) {
      f.add(
        game({ id, rawgId: id === 'a' ? 1 : 2, channelId: `${id}-channel`, roleId: `${id}-role` }),
      );
      f.repository.set(`new-game-announcement:${id}`, { status: 'pending', createdAt: now });
    }
    f.community.announceNewGame.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'one-message';
    });
    const batch = f.nexus.deliverNewGameAnnouncements(abort.signal);
    const rejected = batch.catch((error) => error);
    await entered.promise;
    abort.abort();
    release.resolve();
    expect(await rejected).toBe(abort.signal.reason);
    expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
    expect(f.repository.get('new-game-announcement:a')).toMatchObject({ status: 'sent' });
    expect(f.repository.get('new-game-announcement:b')).toMatchObject({ status: 'pending' });
  } finally {
    release.resolve();
    f.repository.close();
  }
});

test('an announcement waiting behind another send rereads its game before claiming it', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  let batch: Promise<void> | undefined;
  try {
    for (const id of ['a', 'b']) {
      f.add(
        game({ id, rawgId: id === 'a' ? 1 : 2, channelId: `${id}-channel`, roleId: `${id}-role` }),
      );
      f.repository.set(`new-game-announcement:${id}`, { status: 'pending', createdAt: now });
    }
    f.community.announceNewGame.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return 'one-message';
    });
    batch = f.nexus.deliverNewGameAnnouncements();
    await entered.promise;
    await f.nexus.mutex.run(async () => {
      const archived = f.repository.game('b')!;
      archived.state = 'archived';
      f.repository.saveGame(archived);
    });
    release.resolve();
    await batch;
    expect(f.community.announceNewGame).toHaveBeenCalledTimes(1);
    expect(f.repository.get('new-game-announcement:b')).toMatchObject({ status: 'review' });
  } finally {
    release.resolve();
    await batch;
    f.repository.close();
  }
});
