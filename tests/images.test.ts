import sharp from 'sharp';
import { discordAttachment } from '../src/infrastructure/images.js';
afterEach(() => jest.restoreAllMocks());
test('Discord attachments become deterministic PNG assets without signed query parameters', async () => {
  const png = await sharp({ create: { width: 40, height: 70, channels: 4, background: '#557c5b' } })
    .png()
    .toBuffer();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png));
  const a = await discordAttachment(
    'https://cdn.discordapp.com/attachments/123/456/icon.png?ex=SIGNED',
  );
  const b = await discordAttachment(
    'https://cdn.discordapp.com/attachments/123/456/icon.png?ex=OTHER',
  );
  expect(a.id).toBe(b.id);
  expect(a.source).not.toContain('?');
  expect(await sharp(Buffer.from(a.bytes)).metadata()).toMatchObject({
    width: 64,
    height: 64,
    format: 'png',
  });
});
test.each([
  'https://evil.org/attachments/x',
  'https://cdn.discordapp.com.evil.org/attachments/x',
  'http://cdn.discordapp.com/attachments/x',
  'https://cdn.discordapp.com/avatars/x',
  'https://cdn.discordapp.com/role-icons/x',
])('only Discord attachment origins and permitted paths are fetched: %s', async (url) => {
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await expect(discordAttachment(url)).rejects.toMatchObject({ code: 'invalidImage' });
  expect(fetcher).not.toHaveBeenCalled();
});
test('SVG attachments are rejected before image rendering', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  await expect(
    discordAttachment('https://cdn.discordapp.com/attachments/1/2/icon.svg'),
  ).rejects.toMatchObject({ code: 'invalidImage' });
});
test('streaming limits cannot be bypassed by omitting Content-Length', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5_000_001));
      controller.close();
    },
  });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
  await expect(
    discordAttachment('https://cdn.discordapp.com/attachments/1/2/icon.png'),
  ).rejects.toMatchObject({ code: 'invalidImage' });
});

test('a rejected image response cancels its unread body instead of keeping the download open', async () => {
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(stream, { headers: { 'content-length': '5000001' } }));
  await expect(
    discordAttachment('https://cdn.discordapp.com/attachments/1/2/large.png'),
  ).rejects.toMatchObject({ code: 'invalidImage' });
  expect(cancel).toHaveBeenCalledTimes(1);
});
