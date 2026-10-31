import { imageWork } from './image-work.js';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DomainError, type Asset } from '../domain/model.js';
export async function discordAttachment(
  urlString: string,
  roleIcon = false,
  signal?: AbortSignal,
): Promise<Asset> {
  const url = new URL(urlString);
  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !(
      url.pathname.startsWith('/attachments/') ||
      url.pathname.startsWith('/ephemeral-attachments/') ||
      (roleIcon && url.pathname.startsWith('/role-icons/'))
    )
  )
    throw new DomainError('invalidImage');
  return imageWork.run(async () => {
    const response = await fetch(url, {
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
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 5_000_000) throw new DomainError('invalidImage');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    signal?.throwIfAborted();
    const original = Buffer.concat(chunks);
    if (
      !(original[0] === 0x89 && original.subarray(1, 4).toString() === 'PNG') &&
      !(original[0] === 0xff && original[1] === 0xd8) &&
      !(
        original.subarray(0, 4).toString() === 'RIFF' &&
        original.subarray(8, 12).toString() === 'WEBP'
      )
    )
      throw new DomainError('invalidImage');
    try {
      const bytes = await sharp(original, { limitInputPixels: 16_000_000, animated: false })
        .rotate()
        .resize(64, 64, { fit: 'contain', background: '#00000000' })
        .png()
        .toBuffer();
      signal?.throwIfAborted();
      return {
        id: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        mime: 'image/png',
        source: url.origin + url.pathname,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch {
      signal?.throwIfAborted();
      throw new DomainError('invalidImage');
    }
  }, signal);
}
