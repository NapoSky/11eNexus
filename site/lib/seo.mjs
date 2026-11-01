import { escapeHtml as escape, jsonScript } from './html.mjs';
import { languageLinks, pagePath } from './routes.mjs';

export function pageMetadata({ config, t, asset }, type) {
  const error = type === '404';
  return {
    type,
    title: error
      ? `${t.notFound.title} — Le 11e`
      : type === 'home'
        ? t.title
        : `${t.legal[type].title} — 11eNexus`,
    description: error
      ? t.notFound.body
      : type === 'home'
        ? t.description
        : t.legal[type].description,
    canonical: error ? null : `${config.origin}${pagePath(t.lang, type)}`,
    image: `${config.origin}${asset('social/community-11efo.jpg')}`,
    robots: error ? 'noindex, follow' : 'index, follow, max-image-preview:large',
  };
}

export function structuredData({ config, t, catalogue }, metadata) {
  if (metadata.type === '404') return null;
  const websiteId = `${config.origin}/#website`;
  const organizationId = `${config.origin}/#organization`;
  const page = {
    '@type': 'WebPage',
    '@id': `${metadata.canonical}#webpage`,
    url: metadata.canonical,
    name: metadata.title,
    description: metadata.description,
    inLanguage: t.lang,
    isPartOf: { '@id': websiteId },
    about: { '@id': organizationId },
    primaryImageOfPage: { '@type': 'ImageObject', url: metadata.image, width: 1200, height: 630 },
  };
  const graph = [
    {
      '@type': 'Organization',
      '@id': organizationId,
      name: '11e Multigaming',
      alternateName: 'Le 11e',
      url: `${config.origin}/`,
      logo: {
        '@type': 'ImageObject',
        url: `${config.origin}/assets/social/emblem.png`,
        width: 256,
        height: 256,
      },
      sameAs: [config.discord],
    },
    {
      '@type': 'WebSite',
      '@id': websiteId,
      name: '11e Multigaming',
      alternateName: 'Le 11e',
      url: `${config.origin}/`,
      inLanguage: ['fr', 'en'],
      publisher: { '@id': organizationId },
    },
    page,
  ];
  if (metadata.type === 'home') {
    const listId = `${metadata.canonical}#catalogue`;
    page.mainEntity = [{ '@id': organizationId }, { '@id': listId }];
    graph.push({
      '@type': 'ItemList',
      '@id': listId,
      name: t.catalogue.title,
      numberOfItems: catalogue.games.length,
      itemListElement: catalogue.games.map((game, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: game.name,
        url: `${metadata.canonical}#game-${game.slug}`,
      })),
    });
  } else {
    const breadcrumbId = `${metadata.canonical}#breadcrumb`;
    page.breadcrumb = { '@id': breadcrumbId };
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': breadcrumbId,
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: t.seo.home,
          item: `${config.origin}${pagePath(t.lang)}`,
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: t.legal[metadata.type].title,
          item: metadata.canonical,
        },
      ],
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function renderHead(context, type) {
  const { config, t, asset } = context;
  const metadata = pageMetadata(context, type);
  const data = structuredData(context, metadata);
  const locale = t.lang === 'fr' ? 'fr_FR' : 'en_GB';
  return `<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>${escape(metadata.title)}</title>
    <meta name="description" content="${escape(metadata.description)}">
    <meta name="robots" content="${metadata.robots}">
    <meta name="theme-color" content="#07090e">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    ${
      metadata.canonical
        ? `<link rel="canonical" href="${escape(metadata.canonical)}">${languageLinks(
            config.origin,
            type,
          )
            .map(
              (link) =>
                `<link rel="alternate" hreflang="${link.language}" href="${escape(link.url)}">`,
            )
            .join('')}`
        : ''
    }
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="11e Multigaming">
    <meta property="og:title" content="${escape(metadata.title)}">
    <meta property="og:description" content="${escape(metadata.description)}">
    ${metadata.canonical ? `<meta property="og:url" content="${escape(metadata.canonical)}">` : ''}
    <meta property="og:image" content="${escape(metadata.image)}">
    <meta property="og:image:type" content="image/jpeg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escape(t.seo.imageAlt)}">
    <meta property="og:locale" content="${locale}">
    <meta property="og:locale:alternate" content="${t.lang === 'fr' ? 'en_GB' : 'fr_FR'}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escape(metadata.title)}">
    <meta name="twitter:description" content="${escape(metadata.description)}">
    <meta name="twitter:image" content="${escape(metadata.image)}">
    <meta name="twitter:image:alt" content="${escape(t.seo.imageAlt)}">
    <link rel="icon" href="${asset('emblem.svg')}" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/assets/social/emblem.png">
    <link rel="preload" href="/assets/fonts/barlow-condensed-bold.ttf" as="font" type="font/ttf" crossorigin>
    <link rel="preload" href="/assets/fonts/dm-sans.ttf" as="font" type="font/ttf" crossorigin>
    <link rel="stylesheet" href="${asset('site.css')}">
    ${type === 'home' ? `<script src="${asset('site.js')}" defer></script>` : ''}
    ${data ? `<script type="application/ld+json">${jsonScript(data)}</script>` : ''}
  </head>`;
}

export function renderSitemap(origin, routes) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${routes
  .map(
    (route) =>
      `<url><loc>${escape(`${origin}${route.path}`)}</loc>${languageLinks(origin, route.type)
        .map(
          (link) =>
            `<xhtml:link rel="alternate" hreflang="${link.language}" href="${escape(link.url)}"/>`,
        )
        .join('')}</url>`,
  )
  .join('\n')}
</urlset>\n`;
}
