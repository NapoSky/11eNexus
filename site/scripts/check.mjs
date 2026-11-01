import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const json = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const config = await json('config.json');
const locales = await Promise.all(['fr', 'en'].map((lang) => json(`locales/${lang}.json`)));
const catalogue = await json('content/games.json');
const files = await walk(output);
const relativeFiles = files.map((path) => path.slice(output.length + 1));
const routes = [
  '/',
  '/en/',
  '/nexus/terms/',
  '/nexus/privacy/',
  '/nexus/credits/',
  '/en/nexus/terms/',
  '/en/nexus/privacy/',
  '/en/nexus/credits/',
];

assert.deepEqual(keys(locales[0]), keys(locales[1]), 'FR/EN translation structure differs');
assert.equal(
  new Set(catalogue.games.map((game) => game.slug)).size,
  catalogue.games.length,
  'Duplicate catalogue entries',
);
assert.equal(
  new Set(catalogue.games.map((game) => game.name)).size,
  catalogue.games.length,
  'Duplicate game names',
);
assert.match(catalogue.updated, /^\d{4}-\d{2}-\d{2}$/);
for (const game of catalogue.games) {
  assert.deepEqual(
    Object.keys(game).sort(),
    ['active', 'genre', 'name', 'slug'],
    'Only editorial fields belong in the public catalogue',
  );
  assert.match(game.slug, /^[a-z0-9-]+$/);
  assert.ok(game.name && typeof game.active === 'boolean');
  assert.ok(
    locales.every((locale) => locale.catalogue.genres[game.genre]),
    `Missing genre translation: ${game.genre}`,
  );
}
assert.equal(await readFile(join(output, 'CNAME'), 'utf8'), `${new URL(config.origin).hostname}\n`);
assert.ok(relativeFiles.includes('.nojekyll'));
const sitemap = await readFile(join(output, 'sitemap.xml'), 'utf8');
for (const route of routes) {
  const html = await readFile(join(output, route, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`<html lang="${route.startsWith('/en/') ? 'en' : 'fr'}"`));
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `One main heading required: ${route}`);
  assert.ok(
    html.includes(`rel="canonical" href="${config.origin}${route}"`),
    `Wrong canonical: ${route}`,
  );
  assert.ok(
    html.includes('hreflang="fr"') && html.includes('hreflang="en"'),
    `Missing alternate language: ${route}`,
  );
  assert.ok(
    html.includes(config.contact) || !/\/nexus\/(terms|privacy)\//.test(route),
    `Missing operator contact: ${route}`,
  );
  assert.ok(sitemap.includes(`${config.origin}${route}</loc>`), `Missing sitemap route: ${route}`);
}

let totalBytes = 0;
for (const file of files) {
  const relative = file.slice(output.length + 1);
  assert.ok(
    relative.startsWith('assets/') ||
      routes.some((route) => relative === `${route.slice(1)}index.html`) ||
      ['404.html', 'en/404.html', 'CNAME', '.nojekyll', 'robots.txt', 'sitemap.xml'].includes(
        relative,
      ),
    `Unexpected published file: ${relative}`,
  );
  assert.doesNotMatch(
    relative,
    /(?:^|\/)(?:\.git|\.env|data|drafts|backups|node_modules|src)(?:\b|\/)|\.(?:sqlite|db|csv|map)$/i,
    `Private artifact: ${relative}`,
  );
  totalBytes += (await stat(file)).size;
  if (!['.html', '.css', '.js', '.svg', '.xml'].includes(extname(file))) continue;
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(
    source,
    /\b(?:BOT_TOKEN|RAWG_API_KEY|DATABASE_PATH)\b|\b\d{17,20}\b/,
    `Private runtime data in ${relative}`,
  );
  if (extname(file) === '.js') {
    assert.doesNotMatch(
      source,
      /\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|sendBeacon)\b|document\.cookie/,
      'No visitor tracking or runtime API access',
    );
  }
  if (extname(file) !== '.html') continue;
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `Duplicate anchor IDs in ${relative}`);
  for (const match of source.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const url = new URL(match[1], `${config.origin}/${relative}`);
    assert.equal(url.protocol, 'https:', `Insecure link in ${relative}`);
    if (url.origin !== config.origin) continue;
    const target = decodeURIComponent(url.pathname);
    const targetFile = join(output, target, target.endsWith('/') ? 'index.html' : '');
    await stat(targetFile).catch(() => assert.fail(`Broken local link ${match[1]} in ${relative}`));
    if (url.hash && extname(targetFile) === '.html') {
      const targetHtml = await readFile(targetFile, 'utf8');
      assert.ok(
        targetHtml.includes(`id="${url.hash.slice(1)}"`),
        `Missing anchor ${match[1]} in ${relative}`,
      );
    }
  }
  for (const match of source.matchAll(
    /<(?:script|img|iframe)\b[^>]*src="([^"]+)"|<link\b[^>]*rel="(?:stylesheet|preload|icon)"[^>]*href="([^"]+)"/g,
  )) {
    const resource = match[1] || match[2];
    assert.ok(
      resource.startsWith('/') && !resource.startsWith('//'),
      `External automatic resource: ${resource}`,
    );
  }
}
assert.ok(totalBytes < 3_000_000, `Static artifact exceeds 3 MB: ${totalBytes}`);
console.log(
  `Checked ${routes.length} routes, FR/EN parity, local links, catalogue and public artifact (${Math.round(totalBytes / 1024)} KB).`,
);

function keys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => keys(child, `${prefix}.${key}`))
    .sort();
}
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
    ),
  );
  return children.flat();
}
