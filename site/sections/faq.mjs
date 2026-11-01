import { escapeHtml as escape } from '../lib/html.mjs';

export function faq({ t }) {
  return `<section class="section faq wrap" id="faq" aria-labelledby="faq-title">
    <div class="section-heading"><div><p class="eyebrow">${escape(t.faq.eyebrow)}</p><h2 id="faq-title">${escape(t.faq.title)}</h2></div><p class="section-description">${escape(t.faq.body)}</p></div>
    <div class="faq-list">${t.faq.items.map((item) => `<details><summary>${escape(item.question)}<span aria-hidden="true">+</span></summary><p>${escape(item.answer)}</p></details>`).join('')}</div>
  </section>`;
}
