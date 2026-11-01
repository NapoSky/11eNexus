// Optional authoring tool. The dependency-free CI build copies the committed exports.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), '11e-social-fonts-'));
await mkdir(join(temporary, 'cache'));
const fontDirectory = join(root, 'assets/fonts').replace(/&/g, '&amp;').replace(/</g, '&lt;');
await writeFile(
  join(temporary, 'fonts.conf'),
  `<fontconfig><dir>${fontDirectory}</dir><cachedir>${join(temporary, 'cache')}</cachedir></fontconfig>`,
);
process.env.FONTCONFIG_FILE = join(temporary, 'fonts.conf');
const { default: sharp } = await import('sharp');
try {
  const destination = join(root, 'assets/social');
  await mkdir(destination, { recursive: true });
  const image = await sharp(join(root, 'assets/games/valheim.webp'))
    .resize(1200, 630, { fit: 'cover' })
    .modulate({ brightness: 0.45, saturation: 0.7 })
    .toBuffer();
  const emblem = await sharp(join(root, 'assets/emblem.svg')).resize(90, 90).png().toBuffer();
  await sharp(join(root, 'assets/emblem.svg'))
    .resize(256, 256)
    .png()
    .toFile(join(destination, 'emblem.png'));
  const shade = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><linearGradient id="shade"><stop stop-color="#07090e" stop-opacity=".92"/><stop offset="1" stop-color="#07090e" stop-opacity=".35"/></linearGradient><linearGradient id="line"><stop stop-color="#326ff0"/><stop offset=".5" stop-color="#07090e"/><stop offset="1" stop-color="#ef263c"/></linearGradient></defs><rect width="1200" height="630" fill="url(#shade)"/><path d="M64 29H1136M64 601H1136" stroke="url(#line)" stroke-width="3"/></svg>`,
  );
  for (const language of ['fr', 'en']) {
    const t = JSON.parse(await readFile(join(root, `locales/${language}.json`), 'utf8'));
    const layers = [
      { input: shade, left: 0, top: 0 },
      { input: emblem, left: 60, top: 64 },
      { input: await label('11e MULTIGAMING', 42), left: 175, top: 67 },
      {
        input: await label(
          language === 'fr' ? 'COMMUNAUTÉ GAMING FR / EN' : 'FR / EN GAMING COMMUNITY',
          20,
          true,
          '#dccbad',
        ),
        left: 177,
        top: 122,
      },
      { input: await label(t.hero.line1, 94), left: 64, top: 238 },
      { input: await label(t.hero.line2, 94), left: 64, top: 345 },
      {
        input: await label(
          language === 'fr'
            ? 'Coopération · Survie · Stratégie · Discord'
            : 'Co-op · Survival · Strategy · Discord',
          24,
          true,
          '#c2cde0',
        ),
        left: 68,
        top: 538,
      },
    ];
    await sharp(image)
      .composite(layers)
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(join(destination, `community-${language}.jpg`));
  }
  console.log('Exported two 1200×630 social cards and a 256×256 organization logo.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function label(text, size, body = false, color = '#f5f5f2') {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return sharp({
    text: {
      text: `<span foreground="${color}">${safe}</span>`,
      font: `${body ? 'DM Sans' : 'Barlow Condensed Bold'} ${size}`,
      fontfile: join(
        root,
        body ? 'assets/fonts/dm-sans.ttf' : 'assets/fonts/barlow-condensed-bold.ttf',
      ),
      rgba: true,
    },
  })
    .png()
    .toBuffer();
}
