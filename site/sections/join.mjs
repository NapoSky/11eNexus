import { multiline, arrow, discord } from '../lib/html.mjs';

export function join({ t, config }) {
  return `<section class="join-section"><div class="join-art" aria-hidden="true"><img src="/assets/games/deep-rock-galactic.webp" alt="" loading="lazy" width="1920" height="620"></div><div class="wrap join-content"><p class="eyebrow">${t.join.eyebrow}</p><h2>${multiline(t.join.title)}</h2><p>${t.join.body}</p><a class="button" href="${config.discord}">${discord}${t.join.cta}${arrow}</a><p class="join-note">${t.join.note}</p></div><span class="join-watermark" aria-hidden="true">11e</span></section>`;
}
