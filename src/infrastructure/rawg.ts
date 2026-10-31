import { imageWork } from './image-work.js';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Asset, Candidate } from '../domain/model.js';
import { DomainError } from '../domain/model.js';
import type { Catalogue, Repository } from '../application/ports.js';

interface RawGame {
  id: number;
  name: string;
  released?: string;
  background_image?: string;
  developers?: { name: string }[];
  parents_count?: number;
}
// Cache only fields used by Nexus. RAWG pagination URLs can contain the API key.
function publicData(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new DomainError('catalogueUnavailable');
  if ('results' in value) {
    if (!Array.isArray(value.results)) throw new DomainError('catalogueUnavailable');
    return { results: value.results.slice(0, 10).map(publicData) };
  }
  const game = value as RawGame;
  return {
    id: game.id,
    name: game.name,
    released: game.released,
    background_image: game.background_image,
    developers: game.developers?.map((d) => ({ name: d.name })),
    parents_count: game.parents_count,
  };
}
export class Rawg implements Catalogue {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly key: string,
    private readonly repository: Repository,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.key) throw new DomainError('catalogueUnavailable');
    const cacheKey = `rawg:${path}:${JSON.stringify(params)}`;
    const cached = this.repository.get<{ expires: number; data: unknown }>(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.data;
    const existing = this.pending.get(cacheKey);
    if (existing) return existing;
    const task = this.remoteRequest(path, params, cacheKey);
    this.pending.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.pending.delete(cacheKey);
    }
  }
  private async remoteRequest(
    path: string,
    params: Record<string, string>,
    cacheKey: string,
  ): Promise<unknown> {
    const month = new Date().toISOString().slice(0, 7);
    const budgetKey = `rawg-budget:${month}`;
    const used = this.repository.get<number>(budgetKey) || 0;
    if (used >= 18000) throw new DomainError('catalogueUnavailable');
    this.repository.set(budgetKey, used + 1);
    const response = await this.fetcher(
      `https://api.rawg.io/api${path}?${new URLSearchParams({ ...params, key: this.key })}`,
      { signal: AbortSignal.timeout(10000), redirect: 'error' },
    ).catch(() => {
      throw new DomainError('catalogueUnavailable');
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DomainError('catalogueUnavailable');
    }
    let data: unknown;
    try {
      data = publicData(await response.json());
    } catch {
      throw new DomainError('catalogueUnavailable');
    }
    this.repository.set(cacheKey, { expires: Date.now() + 600000, data });
    return data;
  }
  private candidate(game: RawGame): Candidate {
    if (
      !Number.isSafeInteger(game.id) ||
      game.id < 1 ||
      typeof game.name !== 'string' ||
      game.name.length > 250
    )
      throw new DomainError('catalogueUnavailable');
    return {
      id: game.id,
      name: game.name,
      released: game.released || null,
      studio: game.developers?.map((d) => d.name).join(', ') || '',
      imageUrl: game.background_image || null,
      url: `https://rawg.io/games/${game.id}`,
    };
  }
  async search(query: string): Promise<Candidate[]> {
    if (!query.trim() || query.length > 100) throw new DomainError('invalidInput');
    const data = (await this.request('/games', { search: query.trim(), page_size: '10' })) as {
      results?: RawGame[];
    };
    if (!Array.isArray(data.results)) throw new DomainError('catalogueUnavailable');
    return data.results.map((g) => this.candidate(g));
  }
  async get(id: number): Promise<Candidate> {
    if (!Number.isSafeInteger(id) || id < 1) throw new DomainError('invalidInput');
    const game = (await this.request(`/games/${id}`)) as RawGame;
    const candidate = this.candidate(game);
    if (!candidate.imageUrl && game.parents_count) {
      const parents = (await this.request(`/games/${id}/parent-games`, { page_size: '10' })) as {
        results: RawGame[];
      };
      const parent = parents.results.find((p) => p.background_image);
      if (parent) {
        candidate.imageUrl = parent.background_image!;
        candidate.parentId = parent.id;
      }
    }
    return candidate;
  }
  async image(candidate: Candidate, signal?: AbortSignal): Promise<Asset | null> {
    if (!candidate.imageUrl) return null;
    const source = candidate.imageUrl;
    const url = new URL(candidate.imageUrl);
    // Provider-owned origins only: no user supplied URL fetching, no redirects/private IPs.
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'media.rawg.io' ||
      url.username ||
      url.password ||
      url.port
    )
      throw new DomainError('invalidImage');
    return imageWork.run(async () => {
      const response = await this.fetcher(url, {
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
        redirect: 'error',
      }).catch(() => {
        signal?.throwIfAborted();
        throw new DomainError('invalidImage');
      });
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get('content-length') || 0) > 5_000_000
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new DomainError('invalidImage');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 5_000_000) throw new DomainError('invalidImage');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      signal?.throwIfAborted();
      try {
        const bytes = await sharp(Buffer.concat(chunks), {
          limitInputPixels: 16_000_000,
          animated: false,
        })
          .rotate()
          .resize(64, 64, { fit: 'contain', background: '#00000000' })
          .png()
          .toBuffer();
        signal?.throwIfAborted();
        if (bytes.length > 256 * 1024) throw new Error('Image limit');
        return {
          id: createHash('sha256').update(bytes).digest('hex'),
          bytes,
          mime: 'image/png',
          source,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      } catch {
        signal?.throwIfAborted();
        throw new DomainError('invalidImage');
      }
    }, signal);
  }
}
