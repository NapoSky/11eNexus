import { arrow } from '../lib/html.mjs';

export function notFound({ t, prefix }) {
  return `<main id="main" class="not-found wrap"><p class="eyebrow">404 / LE 11e</p><h1>${t.notFound.title}</h1><p>${t.notFound.body}</p><a class="button" href="${prefix}">${t.notFound.cta}${arrow}</a></main>`;
}
