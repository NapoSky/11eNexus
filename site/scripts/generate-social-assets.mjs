// Optional authoring tool. The dependency-free CI build copies the committed exports.
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const source = process.argv[2];
if (!source) {
  console.error('Usage: node site/scripts/generate-social-assets.mjs <community-artwork>');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'assets/social');
await mkdir(destination, { recursive: true });
await sharp(resolve(source))
  .rotate()
  .resize(1200, 630, { fit: 'contain', background: '#07090e' })
  .flatten({ background: '#07090e' })
  .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
  .toFile(join(destination, 'community-11efo.jpg'));
await sharp(join(root, 'assets/emblem.svg'))
  .resize(256, 256)
  .png()
  .toFile(join(destination, 'emblem.png'));
console.log('Exported the complete community artwork at 1200×630 and a 256×256 logo.');
