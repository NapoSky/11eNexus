import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { jsonScript } from '../lib/html.mjs';

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
assert.ok(sitemap.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
const sitemapEntries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)];
assert.equal(sitemapEntries.length, routes.length, 'Only canonical pages belong in the sitemap');
const titles = new Set();
const descriptions = new Set();
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
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  const description = tagAttributes(html, 'meta').find(
    (tag) => tag.name === 'description',
  )?.content;
  assert.ok(title?.length >= 20 && title.length <= 85, `Unhelpful page title: ${route}`);
  assert.ok(
    description?.length >= 60 && description.length <= 180,
    `Unhelpful meta description: ${route}`,
  );
  assert.ok(!titles.has(title), `Duplicate title: ${route}`);
  assert.ok(!descriptions.has(description), `Duplicate description: ${route}`);
  titles.add(title);
  descriptions.add(description);
  const metadata = tagAttributes(html, 'meta');
  assert.equal(
    metadata.find((tag) => tag.name === 'robots')?.content,
    'index, follow, max-image-preview:large',
  );
  assert.equal(
    metadata.find((tag) => tag.property === 'og:url')?.content,
    `${config.origin}${route}`,
  );
  assert.equal(metadata.find((tag) => tag.property === 'og:image:width')?.content, '1200');
  assert.equal(metadata.find((tag) => tag.property === 'og:image:height')?.content, '630');
  assert.equal(metadata.find((tag) => tag.name === 'twitter:card')?.content, 'summary_large_image');
  assert.ok(metadata.find((tag) => tag.name === 'twitter:image:alt')?.content);

  const language = route.startsWith('/en/') ? 'en' : 'fr';
  const suffix = route.replace(/^\/en\//, '/');
  const expectedAlternates = [
    ['fr', `${config.origin}${suffix}`],
    ['en', `${config.origin}/en${suffix}`],
    ['x-default', `${config.origin}${suffix}`],
  ];
  const alternates = tagAttributes(html, 'link').filter((tag) => tag.rel === 'alternate');
  const entry = sitemapEntries.find((match) =>
    match[1].includes(`<loc>${config.origin}${route}</loc>`),
  )?.[1];
  const xmlAlternates = tagAttributes(entry, 'xhtml:link');
  assert.equal(alternates.length, 3);
  assert.equal(xmlAlternates.length, 3);
  for (const [hreflang, href] of expectedAlternates) {
    assert.ok(
      alternates.some((tag) => tag.hreflang === hreflang && tag.href === href),
      `Wrong hreflang: ${route}`,
    );
    assert.ok(
      xmlAlternates.some((tag) => tag.hreflang === hreflang && tag.href === href),
      `Wrong sitemap language: ${route}`,
    );
  }

  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, `One structured-data graph required: ${route}`);
  const data = JSON.parse(scripts[0][1]);
  assert.equal(data['@context'], 'https://schema.org');
  const graph = data['@graph'];
  assert.equal(new Set(graph.map((node) => node['@id'])).size, graph.length);
  const website = graph.find((node) => node['@type'] === 'WebSite');
  assert.equal(website.name, '11e Multigaming');
  assert.equal(website.url, `${config.origin}/`);
  const organization = graph.find((node) => node['@type'] === 'Organization');
  assert.equal(organization.name, website.name);
  assert.equal(organization.url, website.url);
  assert.ok(organization.logo.width >= 112 && organization.logo.height >= 112);
  const page = graph.find((node) => node['@type'] === 'WebPage');
  assert.equal(page.url, `${config.origin}${route}`);
  assert.equal(page.inLanguage, language);
  assert.equal(page.isPartOf['@id'], website['@id']);
  assert.equal(page.about['@id'], organization['@id']);
  assert.ok(
    !graph.some((node) =>
      ['FAQPage', 'Review', 'AggregateRating', 'SearchAction'].includes(node['@type']),
    ),
    'Do not advertise unsupported search features',
  );
  if (route === '/' || route === '/en/') {
    const list = graph.find((node) => node['@type'] === 'ItemList');
    assert.equal(list.numberOfItems, catalogue.games.length);
    assert.deepEqual(
      list.itemListElement.map((item) => item.name),
      catalogue.games.map((game) => game.name),
    );
    for (const [index, item] of list.itemListElement.entries()) {
      assert.equal(item.position, index + 1);
      assert.ok(
        html.includes(`id="${new URL(item.url).hash.slice(1)}"`),
        'Structured game data must match real content',
      );
      assert.ok(
        html.includes(`data-name="${escapeAttribute(item.name)}"`),
        'The full game catalogue must be in the source HTML',
      );
    }
    assert.match(html, /<h1[^>]*>[\s\S]*?11e[\s\S]*?MULTIGAMING[\s\S]*?<\/h1>/);
    const locale = locales.find((value) => value.lang === language);
    for (const item of locale.faq.items)
      assert.ok(
        html.includes(escapeAttribute(item.question)),
        'FAQ content must be rendered statically',
      );
    assert.equal(
      tagAttributes(html, 'img').filter((image) => image.class?.includes('hero-scene')).length,
      1,
      'Load only the initial hero image',
    );
    assert.match(html, /class="hero-scene[^\"]*"[^>]*loading="eager"[^>]*fetchpriority="high"/);
  } else {
    const breadcrumbs = graph.find((node) => node['@type'] === 'BreadcrumbList');
    assert.equal(breadcrumbs.itemListElement.length, 2);
    assert.equal(
      breadcrumbs.itemListElement[0].item,
      `${config.origin}${language === 'fr' ? '/' : '/en/'}`,
    );
    assert.equal(breadcrumbs.itemListElement[1].item, page.url);
    assert.ok(html.includes('id="breadcrumb"'), 'Breadcrumbs must be visible on the page');
    assert.ok(!html.includes('<script src='), 'Legal pages need no client-side JavaScript');
  }
  for (const image of tagAttributes(html, 'img')) {
    assert.ok(
      'alt' in image && Number(image.width) > 0 && Number(image.height) > 0,
      'Images need alternatives and intrinsic dimensions',
    );
  }
}

for (const path of ['404.html', 'en/404.html']) {
  const html = await readFile(join(output, path), 'utf8');
  assert.equal(
    tagAttributes(html, 'meta').find((tag) => tag.name === 'robots')?.content,
    'noindex, follow',
  );
  assert.ok(
    !tagAttributes(html, 'link').some((tag) => ['canonical', 'alternate'].includes(tag.rel)),
    'Error pages must not identify as translated homepages',
  );
  assert.ok(
    !html.includes('application/ld+json'),
    'Do not advertise an error page as normal content',
  );
  assert.ok(!sitemap.includes(path));
}
const robots = await readFile(join(output, 'robots.txt'), 'utf8');
assert.equal(robots, `User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`);
const injection = { title: '</script><img src=x onerror=alert(1)>\u2028\u2029' };
assert.ok(!jsonScript(injection).includes('<'));
assert.deepEqual(JSON.parse(jsonScript(injection)), injection, 'JSON-LD must safely preserve text');
const logo = await readFile(join(output, 'assets/social/emblem.png'));
assert.equal(logo.readUInt32BE(16), 256);
assert.equal(logo.readUInt32BE(20), 256);
for (const language of ['fr', 'en']) {
  const jpeg = await readFile(join(output, `assets/social/community-${language}.jpg`));
  assert.deepEqual(
    jpegDimensions(jpeg),
    { width: 1200, height: 630 },
    'Sharing images must match their declared dimensions',
  );
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
    if (url.search) {
      assert.match(
        url.search,
        /^\?v=[a-f0-9]{12}$/,
        'Only content revisions belong in static asset URLs',
      );
      const content = await readFile(join(output, url.pathname));
      assert.equal(
        url.searchParams.get('v'),
        createHash('sha256').update(content).digest('hex').slice(0, 12),
      );
    }
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
  `Checked ${routes.length} routes, SEO metadata, structured data, hreflang, sitemap, errors, FR/EN parity, local links and public artifact (${Math.round(totalBytes / 1024)} KB).`,
);

function tagAttributes(source, name) {
  return [...source.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)].map((attribute) => [
        attribute[1],
        attribute[2],
      ]),
    ),
  );
}

function escapeAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jpegDimensions(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'A JPEG sharing image is required');
  let offset = 2;
  while (offset + 8 < bytes.length) {
    assert.equal(bytes[offset], 0xff, 'Invalid JPEG marker');
    const marker = bytes[offset + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  assert.fail('JPEG dimensions not found');
}

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
