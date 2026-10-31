import { Client } from 'discord.js';
import { Shutdown } from '../src/infrastructure/shutdown.js';
import { fixture, member } from './helpers.js';
import { setImmediate } from 'node:timers/promises';

const log = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('an accepted creation keeps REST authorization and its lease until its final step is complete', async () => {
  const f = fixture(),
    client = new Client({ intents: [] }),
    entered = deferred(),
    release = deferred();
  client.rest.setToken('synthetic-offline-only');
  const request = { method: 'GET', fullRoute: '/users/@me' };
  const prepare = () =>
    (
      client.rest as unknown as { resolveRequest(request: unknown): Promise<unknown> }
    ).resolveRequest(request);
  const owner = 'runtime-owner';
  f.repository.acquireLease(owner, Date.now());
  const original = f.community.createRole.getMockImplementation()!;
  f.community.createRole.mockImplementationOnce(async (g) => {
    entered.resolve();
    await release.promise;
    await prepare();
    return original(g);
  });
  const creation = f.nexus.create(member, 123);
  await entered.promise;
  const stopIntake = jest.fn(),
    disconnect = jest.fn(() => client.destroy()),
    exit = jest.fn();
  let closed = false;
  const closeStorage = jest.fn(() => {
    f.repository.releaseLease(owner);
    f.repository.close();
    closed = true;
  });
  const shutdown = new Shutdown(
    {
      stopIntake,
      drain: () => [creation],
      drainMutations: () => f.nexus.mutex.run(async () => {}),
      disconnect,
      closeStorage,
      exit,
    },
    log,
  );
  try {
    const pending = shutdown.run();
    expect(shutdown.run()).toBe(pending);
    expect(shutdown.stopping).toBe(true);
    expect(f.repository.acquireLease('other-owner', Date.now())).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    release.resolve();
    expect((await creation).state).toBe('active');
    await pending;
    expect(stopIntake).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(closeStorage).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await expect(prepare()).rejects.toThrow();
  } finally {
    release.resolve();
    await client.destroy();
    if (!closed) f.repository.close();
  }
});

test('the shutdown deadline does not release storage underneath unfinished work', async () => {
  jest.useFakeTimers();
  const release = deferred(),
    exit = jest.fn(),
    disconnect = jest.fn(async () => {}),
    closeStorage = jest.fn();
  const shutdown = new Shutdown(
    {
      stopIntake() {},
      drain: () => [release.promise],
      drainMutations: async () => {},
      disconnect,
      closeStorage,
      exit,
    },
    log,
    55000,
  );
  try {
    const pending = shutdown.run();
    await jest.advanceTimersByTimeAsync(55000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(closeStorage).not.toHaveBeenCalled();
    release.resolve();
    await pending;
    expect(closeStorage).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('a failed drain still waits for the other accepted task and exits with failure', async () => {
  const release = deferred(),
    disconnect = jest.fn(async () => {}),
    closeStorage = jest.fn(),
    exit = jest.fn();
  const shutdown = new Shutdown(
    {
      stopIntake() {},
      drain: () => [Promise.reject(new Error('failed task')), release.promise],
      drainMutations: async () => {},
      disconnect,
      closeStorage,
      exit,
    },
    log,
  );
  const pending = shutdown.run();
  await setImmediate();
  expect(disconnect).not.toHaveBeenCalled();
  release.resolve();
  await pending;
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(closeStorage).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
});

test('a later fatal stop request upgrades the exit code without repeating cleanup', async () => {
  const release = deferred(),
    exit = jest.fn(),
    closeStorage = jest.fn();
  const shutdown = new Shutdown(
    {
      stopIntake() {},
      drain: () => [release.promise],
      drainMutations: async () => {},
      disconnect: async () => {},
      closeStorage,
      exit,
    },
    log,
  );
  const first = shutdown.run();
  expect(shutdown.run(1)).toBe(first);
  release.resolve();
  await first;
  expect(exit).toHaveBeenCalledWith(1);
  expect(closeStorage).toHaveBeenCalledTimes(1);
});
