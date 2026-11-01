import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { document } from '../components/document.mjs';
import { pagePath, siteRoutes, languages } from '../lib/routes.mjs';
import { renderSitemap } from '../lib/seo.mjs';
import { landing } from '../pages/landing.mjs';
import { legal } from '../pages/legal.mjs';
import { notFound } from '../pages/not-found.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const json = async (file) => JSON.parse(await readFile(join(root, file), 'utf8'));
const config = await json('config.json');
const catalogue = await json('content/games.json');
const revisions = Object.fromEntries(
  await Promise.all(
    ['site.css', 'site.js', 'emblem.svg', 'social/community-11efo.jpg'].map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(join(root, 'assets', file)))
        .digest('hex')
        .slice(0, 12),
    ]),
  ),
);
const asset = (file) => `/assets/${file}?v=${revisions[file]}`;
const routes = siteRoutes();

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'assets'), join(output, 'assets'), { recursive: true });
for (const language of languages) {
  const t = await json(`locales/${language}.json`);
  const context = {
    config,
    catalogue,
    t,
    asset,
    prefix: pagePath(language),
    otherPrefix: pagePath(language === 'fr' ? 'en' : 'fr'),
    legalPath: (type) => pagePath(language, type),
  };
  for (const route of routes.filter((route) => route.language === language)) {
    const directory = join(output, route.path);
    await mkdir(directory, { recursive: true });
    const content = route.type === 'home' ? landing(context) : legal(context, route.type);
    await writeFile(join(directory, 'index.html'), document(context, route.type, content));
  }
  await writeFile(
    join(output, language === 'fr' ? '404.html' : 'en/404.html'),
    document(context, '404', notFound(context)),
  );
}
await writeFile(join(output, 'CNAME'), `${new URL(config.origin).hostname}\n`);
await writeFile(join(output, '.nojekyll'), '');
await writeFile(
  join(output, 'robots.txt'),
  `User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`,
);
await writeFile(join(output, 'sitemap.xml'), renderSitemap(config.origin, routes));
console.log(`Built ${routes.length} static pages and two error pages in site/dist.`);
