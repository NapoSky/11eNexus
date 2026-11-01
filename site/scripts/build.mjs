import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const json = async (file) => JSON.parse(await readFile(join(root, file), 'utf8'));
const config = await json('config.json');
const catalogue = await json('content/games.json');
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const multiline = (value) => escape(value).replaceAll('\n', '<br>');
const arrow = '<span aria-hidden="true">↗</span>';
const discord =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M19.8 5a18 18 0 0 0-4.4-1.4l-.6 1.2a16 16 0 0 0-5.6 0l-.6-1.2A18 18 0 0 0 4.2 5C1.4 9.2.6 13.3 1 17.3a18 18 0 0 0 5.5 2.8l1.1-1.8-1.7-.9.4-.3c3.6 1.7 7.8 1.7 11.4 0l.4.3-1.7.9 1.1 1.8a18 18 0 0 0 5.5-2.8c.5-4.6-.8-8.6-3.2-12.3ZM8.4 14.8c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7.2 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"/></svg>';

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'assets'), join(output, 'assets'), { recursive: true });
const pages = [];
for (const lang of ['fr', 'en']) {
  const t = await json(`locales/${lang}.json`);
  const prefix = lang === 'fr' ? '/' : '/en/';
  const otherPrefix = lang === 'fr' ? '/en/' : '/';
  const legalPath = (name) => `${prefix}nexus/${name}/`;
  const footer = `<footer class="footer wrap"><div class="footer-top"><a class="brand" href="${prefix}"><img src="/assets/emblem.svg" width="44" height="44" alt=""><span>LE 11e<small>${escape(t.footer.tagline)}</small></span></a><nav aria-label="${escape(t.legal.toc)}"><a href="${escape(config.discord)}">${t.footer.discord} ${arrow}</a><a href="${escape(config.regiment)}">${t.footer.foxhole} ${arrow}</a><a href="${escape(config.repository)}">${t.footer.source} ${arrow}</a></nav></div><div class="footer-bottom"><span>© 2026 · LE 11e</span><span>${escape(t.footer.copyright)}</span><nav aria-label="Nexus"><a href="${legalPath('terms')}">${escape(t.footer.terms)}</a><a href="${legalPath('privacy')}">${escape(t.footer.privacy)}</a><a href="${legalPath('credits')}">${escape(t.footer.credits)}</a></nav></div></footer>`;
  const header = (suffix = '') =>
    `<a class="skip-link" href="#main">${t.skip}</a><header class="header"><div class="nav-wrap wrap"><a class="brand" href="${prefix}" aria-label="Le 11e"><img src="/assets/emblem.svg" width="44" height="44" alt=""><span>LE 11e<small>${t.brand}</small></span></a><nav class="desktop-nav" aria-label="${escape(t.nav.menu)}"><a href="${prefix}#community">${t.nav.community}</a><a href="${prefix}#games">${t.nav.games}</a><a href="${prefix}#origins">${t.nav.foxhole}</a></nav><div class="nav-actions"><a class="language" href="${otherPrefix}${suffix}" lang="${lang === 'fr' ? 'en' : 'fr'}" hreflang="${lang === 'fr' ? 'en' : 'fr'}" aria-label="${lang === 'fr' ? 'Read in English' : 'Lire en français'}"><span ${lang === 'fr' ? 'class="selected"' : ''}>FR</span><span class="language-separator">/</span><span ${lang === 'en' ? 'class="selected"' : ''}>EN</span></a><a class="button button-small nav-join" href="${config.discord}">${discord}<span>${t.nav.join}</span>${arrow}</a></div><details class="mobile-menu"><summary aria-label="${t.nav.menu}"><span></span><span></span></summary><nav aria-label="${t.nav.menu}"><a href="${prefix}#community">${t.nav.community}</a><a href="${prefix}#games">${t.nav.games}</a><a href="${prefix}#origins">${t.nav.foxhole}</a><a href="${config.discord}">${t.nav.join} ${arrow}</a></nav></details></div></header>`;
  const shell = (title, body, suffix = '', description = t.description) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta name="theme-color" content="#101210"><meta name="referrer" content="strict-origin-when-cross-origin"><link rel="canonical" href="${config.origin}${prefix}${suffix}"><link rel="alternate" hreflang="fr" href="${config.origin}/${suffix}"><link rel="alternate" hreflang="en" href="${config.origin}/en/${suffix}"><link rel="alternate" hreflang="x-default" href="${config.origin}/${suffix}"><meta property="og:type" content="website"><meta property="og:site_name" content="Le 11e"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${config.origin}${prefix}${suffix}"><meta property="og:image" content="${config.origin}/assets/games/helldivers-2.webp"><meta property="og:image:alt" content="Helldivers 2 — Arrowhead Game Studios / Sony Interactive Entertainment"><meta property="og:locale" content="${lang === 'fr' ? 'fr_FR' : 'en_GB'}"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/assets/emblem.svg" type="image/svg+xml"><link rel="preload" href="/assets/fonts/barlow-condensed-bold.ttf" as="font" type="font/ttf" crossorigin><link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script></head><body>${header(suffix)}${body}${footer}</body></html>\n`;
  const heroGames = ['helldivers-2', 'valheim', 'stellaris'];
  const gameRows = catalogue.games
    .map(
      (g) =>
        `<a class="catalogue-game" data-active="${g.active}" data-genre="${escape(g.genre)}" data-name="${escape(g.name)}" href="${config.discord}" aria-label="${escape(g.name)} — ${escape(t.catalogue.onDiscord)}"><span class="game-dot ${g.active ? 'active' : ''}" aria-hidden="true"></span><span>${escape(g.name)}<small>${escape(t.catalogue.genres[g.genre])}</small></span><span class="game-arrow" aria-hidden="true">↗</span></a>`,
    )
    .join('');
  const body = `<main id="main">
<section class="hero" aria-labelledby="hero-title"><div class="hero-art" aria-hidden="true">${heroGames.map((slug, i) => `<img src="/assets/games/${slug}.webp" width="1920" height="620" alt="" class="hero-scene ${i === 0 ? 'is-current' : ''}" data-scene="${slug}" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}>`).join('')}</div><div class="hero-grid" aria-hidden="true"></div><div class="hero-content wrap"><p class="eyebrow"><span class="tiny-cross" aria-hidden="true">✳</span> ${t.hero.eyebrow}</p><h1 id="hero-title">${t.hero.line1}<br><span>${t.hero.line2}</span></h1><p class="hero-description">${t.hero.body}</p><div class="hero-actions"><a class="button" href="${config.discord}">${discord}${t.hero.primary}${arrow}</a><a class="text-link" href="#games">${t.hero.secondary}<span aria-hidden="true">↓</span></a></div><p class="hero-footnote">${t.hero.footnote}</p></div><div class="hero-bottom wrap"><a class="scroll-cue" href="#community"><span aria-hidden="true">↓</span>${t.hero.scroll}</a><div class="scene-controls" data-enhance hidden><span>${t.hero.caption}</span><div role="group" aria-label="${t.hero.switch}">${heroGames.map((slug, i) => `<button type="button" data-hero="${slug}" aria-pressed="${i === 0}" aria-label="${t.hero.switch} : ${t.featured.cards[i].name}"><span class="scene-number">0${i + 1}</span> ${t.featured.cards[i].name}</button>`).join('')}</div></div></div></section>
<div class="community-strip"><div class="wrap"><div><strong>${catalogue.games.length}</strong><span>${t.strip.games}</span></div><div><strong>${catalogue.games.filter((g) => g.active).length}</strong><span>${t.strip.active}</span></div><div><strong>FR<span class="stat-slash">/</span>EN</strong><span>${t.strip.languages}</span></div><p><span aria-hidden="true">✳</span>${t.strip.spirit}</p></div></div>
<section class="section community wrap" id="community"><div class="section-heading"><div><p class="eyebrow">${t.community.eyebrow}</p><h2>${multiline(t.community.title)}</h2></div><p class="section-description">${t.community.body}</p></div><div class="spirit-grid">${t.community.items.map((item) => `<article><span class="item-number">${item.number}<span aria-hidden="true">/</span></span><h3>${item.title}</h3><p>${item.body}</p></article>`).join('')}</div></section>
<section class="section featured" id="games"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">${t.featured.eyebrow}</p><h2>${t.featured.title}</h2><p class="section-description">${t.featured.body}</p></div><a class="text-link" href="#catalogue">${t.featured.link}${arrow}</a></div><div class="featured-grid">${t.featured.cards.map((card, i) => `<a class="game-card game-card-${i + 1}" href="${config.discord}" aria-label="${card.name} — ${t.featured.discover}"><img src="/assets/games/${card.slug}.webp" width="1920" height="620" loading="lazy" decoding="async" alt=""><div class="card-top"><span>0${i + 1} /</span><span class="card-icon" aria-hidden="true">↗</span></div><div class="card-content"><p class="eyebrow">${card.genre}</p><h3>${card.name}</h3><p>${card.line}</p></div></a>`).join('')}</div></div></section>
<section class="section catalogue wrap" id="catalogue"><div class="section-heading"><div><p class="eyebrow">${t.catalogue.eyebrow}</p><h2>${t.catalogue.title}</h2></div><p class="section-description">${t.catalogue.body}</p></div><form class="catalogue-toolbar" data-enhance hidden role="search"><div class="catalogue-tabs" role="group" aria-label="${t.nav.games}"><button type="button" data-filter="active" aria-pressed="true"><span class="live-dot" aria-hidden="true"></span>${t.catalogue.active}</button><button type="button" data-filter="all" aria-pressed="false">${t.catalogue.all}<span class="tab-count">${catalogue.games.length}</span></button></div><div class="catalogue-inputs"><label class="search-field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><span class="sr-only">${t.catalogue.search}</span><input type="search" name="q" placeholder="${t.catalogue.placeholder}" autocomplete="off"></label><label><span class="sr-only">${t.catalogue.genre}</span><select name="genre"><option value="all">${t.catalogue.genre}</option>${Object.entries(
    t.catalogue.genres,
  )
    .map(([key, label]) => `<option value="${key}">${escape(label)}</option>`)
    .join(
      '',
    )}</select></label></div></form><p class="catalogue-count" aria-live="polite" aria-atomic="true"><span data-result-count>${catalogue.games.length}</span> ${t.catalogue.count}</p><div class="catalogue-grid">${gameRows}</div><p class="empty-message" hidden>${t.catalogue.empty}</p><p class="snapshot"><span class="game-dot active" aria-hidden="true"></span>${t.catalogue.snapshot}</p></section>
<section class="origins" id="origins"><div class="origins-image"><img src="/assets/games/foxhole.webp" alt="Foxhole — 11e Régiment de Callahan" width="1920" height="1080" loading="lazy" decoding="async"><span>${t.origins.caption}</span></div><div class="origins-content"><p class="eyebrow">${t.origins.eyebrow}</p><h2>${multiline(t.origins.title)}</h2><p>${t.origins.body}</p><p>${t.origins.body2}</p><a class="text-link" href="${config.regiment}">${t.origins.cta}${arrow}</a></div></section>
<section class="join-section"><div class="join-art" aria-hidden="true"><img src="/assets/games/deep-rock-galactic.webp" alt="" loading="lazy" width="1920" height="620"></div><div class="wrap join-content"><p class="eyebrow">${t.join.eyebrow}</p><h2>${multiline(t.join.title)}</h2><p>${t.join.body}</p><a class="button" href="${config.discord}">${discord}${t.join.cta}${arrow}</a><p class="join-note">${t.join.note}</p></div><span class="join-watermark" aria-hidden="true">11e</span></section>
</main>`;
  await save(prefix, shell(t.title, body));
  for (const type of ['terms', 'privacy', 'credits']) {
    const content = t.legal[type];
    const suffix = `nexus/${type}/`;
    const related = `<div class="legal-links"><a href="${legalPath('terms')}">${t.footer.terms}</a><a href="${legalPath('privacy')}">${t.footer.privacy}</a><a href="${legalPath('credits')}">${t.footer.credits}</a></div>`;
    const links =
      type === 'credits'
        ? `<ul class="resource-links">${t.featured.cards.map((c) => `<li><a href="https://store.steampowered.com/app/${{ 'helldivers-2': '553850', valheim: '892970', stellaris: '281990', barotrauma: '602960' }[c.slug]}/">${c.name} — Steam ${arrow}</a></li>`).join('')}<li><a href="https://store.steampowered.com/app/548430/">Deep Rock Galactic — Steam ${arrow}</a></li><li><a href="${config.regiment}">11e Régiment de Callahan ${arrow}</a></li><li><a href="/assets/fonts/barlow-LICENSE.txt">Barlow Condensed — SIL OFL 1.1</a></li><li><a href="/assets/fonts/dm-sans-LICENSE.txt">DM Sans — SIL OFL 1.1</a></li></ul>`
        : `<ul class="resource-links"><li><a href="${config.contact}">${t.legal.contact} — GitHub Issues ${arrow}</a></li><li><a href="${config.discord}">Discord — Le 11e ${arrow}</a></li><li><a href="https://discord.com/terms">Discord — Terms of Service ${arrow}</a></li><li><a href="https://discord.com/guidelines">Discord — Community Guidelines ${arrow}</a></li><li><a href="https://discord.com/privacy">Discord — Privacy ${arrow}</a></li><li><a href="https://rawg.io/privacy_policy">RAWG — Privacy ${arrow}</a></li><li><a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub — Privacy ${arrow}</a></li><li><a href="https://www.cnil.fr/fr/mes-demarches/les-droits-pour-maitriser-vos-donnees-personnelles">CNIL ${arrow}</a></li></ul>`;
    const legalBody = `<main id="main" class="legal-page wrap"><a class="back-link" href="${prefix}">← ${t.legal.back}</a><p class="eyebrow">${t.legal.eyebrow}</p><h1>${content.title}</h1><p class="legal-date">${t.legal.date}</p><p class="legal-intro">${escape(content.intro)}</p>${related}<div class="legal-layout"><aside><nav aria-label="${t.legal.toc}">${content.sections.map((section, i) => `<a href="#section-${i + 1}">${section.title}</a>`).join('')}</nav></aside><article class="legal-article">${content.sections.map((section, i) => `<section id="section-${i + 1}"><h2>${i + 1}. ${escape(section.title)}</h2>${section.paragraphs.map((p) => `<p>${escape(p)}</p>`).join('')}</section>`).join('')}${links}</article></div></main>`;
    await save(
      `${prefix}${suffix}`,
      shell(`${content.title} — 11eNexus`, legalBody, suffix, content.intro),
    );
  }
  const notFound = `<main id="main" class="not-found wrap"><p class="eyebrow">404 / LE 11e</p><h1>${t.notFound.title}</h1><p>${t.notFound.body}</p><a class="button" href="${prefix}">${t.notFound.cta}${arrow}</a></main>`;
  await writeFile(
    join(output, lang === 'fr' ? '404.html' : 'en/404.html'),
    shell(`${t.notFound.title} — Le 11e`, notFound),
  );
}
await writeFile(join(output, 'CNAME'), `${new URL(config.origin).hostname}\n`);
await writeFile(join(output, '.nojekyll'), '');
await writeFile(
  join(output, 'robots.txt'),
  `User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`,
);
await writeFile(
  join(output, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((path) => `<url><loc>${config.origin}${path}</loc></url>`).join('')}</urlset>\n`,
);
console.log(`Built ${pages.length} static pages and two error pages in site/dist.`);

async function save(path, content) {
  const directory = join(output, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), content);
  pages.push(path);
}
