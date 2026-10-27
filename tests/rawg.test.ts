import sharp from 'sharp';
import { Rawg } from '../src/infrastructure/rawg.js';
import { Store } from '../src/infrastructure/store.js';
import type { Candidate } from '../src/domain/model.js';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => store.close());
const response = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const candidate: Candidate = {
  id: 1,
  name: 'Game',
  released: null,
  studio: '',
  url: 'https://rawg.io/games/1',
  imageUrl: 'https://media.rawg.io/test.png',
};
test('search preserves exact provider identities and caches without pagination secrets', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(
    response({
      results: [{ id: 1, name: 'Wardogs', released: '2020-01-01' }],
      next: 'https://api.rawg.io/api/games?key=SECRET',
    }),
  );
  const rawg = new Rawg('SECRET', store, fetcher);
  expect((await rawg.search('Wardogs'))[0]?.id).toBe(1);
  await rawg.search('Wardogs');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(
      store.get(`rawg:/games:${JSON.stringify({ search: 'Wardogs', page_size: '10' })}`),
    ),
  ).not.toContain('SECRET');
});
test('monthly free-tier guard stops requests before going over the local budget', async () => {
  store.set(`rawg-budget:${new Date().toISOString().slice(0, 7)}`, 18000);
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  await expect(new Rawg('KEY', store, fetcher).search('Game')).rejects.toMatchObject({
    code: 'catalogueUnavailable',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
test('an absent key or failed provider returns a domain error without leaking the key', async () => {
  await expect(new Rawg('', store).search('Game')).rejects.toMatchObject({
    code: 'catalogueUnavailable',
  });
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockRejectedValue(new Error('https://api.rawg.io/?key=SECRET'));
  await expect(new Rawg('SECRET', store, fetcher).get(1)).rejects.toMatchObject({
    message: 'catalogueUnavailable',
  });
});
test('missing edition art uses the parent image while preserving the edition ID', async () => {
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(response({ id: 1, name: 'Game DLC', parents_count: 1 }))
    .mockResolvedValueOnce(
      response({ results: [{ id: 2, name: 'Game', background_image: candidate.imageUrl }] }),
    );
  expect(await new Rawg('KEY', store, fetcher).get(1)).toMatchObject({
    id: 1,
    parentId: 2,
    imageUrl: candidate.imageUrl,
  });
});
test('provider images become a persistent small PNG asset', async () => {
  const png = await sharp({
    create: { width: 100, height: 80, channels: 4, background: '#557c5b' },
  })
    .png()
    .toBuffer();
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response(png));
  const asset = await new Rawg('KEY', store, fetcher).image(candidate);
  expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await sharp(Buffer.from(asset!.bytes)).metadata()).toMatchObject({
    format: 'png',
    width: 64,
    height: 64,
  });
});
test.each([
  'http://media.rawg.io/a',
  'https://localhost/a',
  'https://media.rawg.io.evil.org/a',
  'https://user:pass@media.rawg.io/a',
])('rejects unsafe image origins: %s', async (imageUrl) => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  await expect(
    new Rawg('KEY', store, fetcher).image({ ...candidate, imageUrl }),
  ).rejects.toMatchObject({ code: 'invalidImage' });
  expect(fetcher).not.toHaveBeenCalled();
});
test('oversized response is rejected before decoding', async () => {
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response('huge', { headers: { 'content-length': '5000001' } }));
  await expect(new Rawg('KEY', store, fetcher).image(candidate)).rejects.toMatchObject({
    code: 'invalidImage',
  });
});
