import { multiline } from '../lib/html.mjs';

export function community({ t }) {
  return `<section class="section community wrap" id="community"><div class="section-heading"><div><p class="eyebrow">${t.community.eyebrow}</p><h2>${multiline(t.community.title)}</h2></div><p class="section-description">${t.community.body}</p></div><div class="spirit-grid">${t.community.items.map((item) => `<article><span class="item-number">${item.number}<span aria-hidden="true">/</span></span><h3>${item.title}</h3><p>${item.body}</p></article>`).join('')}</div></section>`;
}
