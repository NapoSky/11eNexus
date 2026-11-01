import { escapeHtml as escape } from '../lib/html.mjs';

export function heritage(t) {
  const copy = t.origins.heritage;
  return `<aside class="fo-heritage" aria-labelledby="fo-title">
    <figure class="fo-archive"><img src="/assets/heritage/11efo-original.webp" alt="${escape(copy.alt)}" width="283" height="300" loading="lazy" decoding="async"><figcaption>${escape(copy.caption)}</figcaption></figure>
    <div class="fo-story"><p class="eyebrow">${escape(copy.eyebrow)}</p><h3 id="fo-title">${escape(copy.title)}</h3><p>${escape(copy.body)}</p></div>
    <blockquote class="fo-motto"><p>${escape(copy.quote)}</p><footer>${escape(copy.source)}</footer></blockquote>
  </aside>`;
}
