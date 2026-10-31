import { setImmediate } from 'node:timers/promises';
import { ImageWork } from '../src/infrastructure/image-work.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('queued image requests do not start their download until a slot is free', async () => {
  const work = new ImageWork(2, 1),
    release = deferred();
  const download = jest.fn(async () => {
    await release.promise;
    return 'image';
  });
  const first = work.run(download),
    second = work.run(download),
    queued = work.run(download);
  await setImmediate();
  expect(download).toHaveBeenCalledTimes(2);
  expect(work.stats()).toEqual({ active: 2, queued: 1 });
  await expect(work.run(download)).rejects.toMatchObject({ code: 'imageBusy' });
  release.resolve();
  expect(await Promise.all([first, second, queued])).toEqual(['image', 'image', 'image']);
  await setImmediate();
  expect(work.stats()).toEqual({ active: 0, queued: 0 });
});

test('leaving a menu removes its queued image before any bytes are downloaded', async () => {
  const work = new ImageWork(1, 1),
    release = deferred(),
    cancelled = new AbortController();
  const active = work.run(async () => release.promise);
  const download = jest.fn(async () => 'unused');
  const queued = work.run(download, cancelled.signal);
  cancelled.abort();
  await expect(queued).rejects.toBe(cancelled.signal.reason);
  expect(download).not.toHaveBeenCalled();
  expect(work.stats().queued).toBe(0);
  release.resolve();
  await active;
});

test('a failed image releases its slot for the next request', async () => {
  const work = new ImageWork(1, 1),
    release = deferred();
  const failed = work.run(async () => {
    await release.promise;
    throw new Error('invalid image');
  });
  const queued = work.run(async () => 'next');
  const result = expect(failed).rejects.toThrow('invalid image');
  release.resolve();
  await result;
  expect(await queued).toBe('next');
});
