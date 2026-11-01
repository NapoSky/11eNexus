import { multiline, arrow } from '../lib/html.mjs';
import { heritage } from '../components/heritage.mjs';

export function origins({ t, config }) {
  return `<section class="origins" id="origins"><div class="origins-image"><img src="/assets/games/foxhole.webp" alt="Foxhole — 11e Régiment de Callahan" width="1920" height="887" loading="lazy" decoding="async"><span>${t.origins.caption}</span></div><div class="origins-content"><p class="eyebrow">${t.origins.eyebrow}</p><h2>${multiline(t.origins.title)}</h2><p>${t.origins.body}</p><p>${t.origins.body2}</p><a class="text-link" href="${config.regiment}">${t.origins.cta}${arrow}</a></div>${heritage(t)}</section>`;
}
