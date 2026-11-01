import { escapeHtml as escape, arrow } from '../lib/html.mjs';

export function featured({ t, config }) {
  return `<section class="section featured" id="games"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">${t.featured.eyebrow}</p><h2>${t.featured.title}</h2><p class="section-description">${t.featured.body}</p></div><a class="text-link" href="#catalogue">${t.featured.link}${arrow}</a></div><div class="featured-grid">${t.featured.cards.map((card, i) => `<a class="game-card game-card-${i + 1}" href="${config.discord}" title="${escape(card.name)} — ${escape(t.featured.discover)}"><img src="/assets/games/${card.slug}.webp" width="1920" height="620" loading="lazy" decoding="async" alt="${escape(card.imageAlt)}"><div class="card-top"><span>0${i + 1} /</span><span class="card-icon" aria-hidden="true">↗</span></div><div class="card-content"><p class="eyebrow">${card.genre}</p><h3>${card.name}</h3><p>${card.line}</p></div></a>`).join('')}</div></div></section>`;
}
