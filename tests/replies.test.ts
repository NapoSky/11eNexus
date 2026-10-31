import { MessageFlags } from 'discord.js';
import { Replies } from '../src/presentation/replies.js';
import type { View } from '../src/presentation/views.js';
import { setImmediate } from 'node:timers/promises';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function interaction(messageId = 'personal', userId = 'member') {
  return {
    user: { id: userId },
    message: { id: messageId, flags: { has: (f: number) => f === MessageFlags.Ephemeral } },
    editReply: jest.fn(async (_options: unknown): Promise<unknown> => ({ id: messageId })),
  };
}
const payload = { components: [] } as unknown as View;
const begin = (replies: Replies, i: ReturnType<typeof interaction>) => replies.begin(i as never);

test('edits already in flight finish before a newer controller writes its navigation', async () => {
  const replies = new Replies(),
    old = interaction(),
    next = interaction();
  const entered = deferred(),
    release = deferred();
  const visible: string[] = [];
  old.editReply.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    visible.push('old admin');
  });
  next.editReply.mockImplementation(async () => {
    visible.push('new member');
  });
  const oldReply = begin(replies, old),
    oldWrite = oldReply.write(payload);
  await entered.promise;
  const nextReply = begin(replies, next),
    nextWrite = nextReply.write(payload);
  await setImmediate();
  expect(next.editReply).not.toHaveBeenCalled();
  expect(oldReply.signal.aborted).toBe(true);
  release.resolve();
  await Promise.all([oldWrite, nextWrite]);
  expect(visible).toEqual(['old admin', 'new member']);
  await oldReply.write(payload);
  expect(old.editReply).toHaveBeenCalledTimes(1);
});

test('a failed HTTP edit does not prevent the next screen from being written', async () => {
  const replies = new Replies(),
    old = interaction(),
    next = interaction();
  old.editReply.mockRejectedValueOnce(new Error('expired HTTP request'));
  await expect(begin(replies, old).write(payload)).rejects.toThrow();
  await begin(replies, next).write(payload);
  expect(next.editReply).toHaveBeenCalledTimes(1);
});

test('messages and owners keep independent navigation generations', async () => {
  const replies = new Replies(),
    first = interaction(),
    otherMessage = interaction('other'),
    otherOwner = interaction('personal', 'other');
  const firstReply = begin(replies, first);
  await begin(replies, otherMessage).write(payload);
  await begin(replies, otherOwner).write(payload);
  expect(firstReply.current()).toBe(true);
  await firstReply.write(payload);
  expect(first.editReply).toHaveBeenCalledTimes(1);
});

test('a public entrypoint binds its new private message for subsequent navigation', async () => {
  const replies = new Replies(),
    entry = interaction();
  Object.assign(entry, { message: undefined });
  const initial = begin(replies, entry);
  await initial.write(payload);
  const next = interaction();
  await begin(replies, next).write(payload);
  expect(initial.current()).toBe(false);
  await initial.write(payload);
  expect(entry.editReply).toHaveBeenCalledTimes(1);
});

test('the acknowledgement message ID also serializes the first in-flight public-entry edit', async () => {
  const replies = new Replies(),
    entry = interaction(),
    next = interaction();
  Object.assign(entry, { message: undefined });
  const initial = begin(replies, entry),
    entered = deferred(),
    release = deferred();
  initial.bind('personal');
  entry.editReply.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const firstWrite = initial.write(payload);
  await entered.promise;
  const nextWrite = begin(replies, next).write(payload);
  await setImmediate();
  expect(next.editReply).not.toHaveBeenCalled();
  release.resolve();
  await Promise.all([firstWrite, nextWrite]);
  expect(initial.current()).toBe(false);
  expect(next.editReply).toHaveBeenCalledTimes(1);
});
