import { escapeHtml as escape } from '../lib/html.mjs';

export function catalogue({ t, config, catalogue }) {
  const gameRows = catalogue.games
    .map(
      (g) =>
        `<li class="catalogue-item" data-active="${g.active}" data-genre="${escape(g.genre)}" data-name="${escape(g.name)}"><a class="catalogue-game" id="game-${escape(g.slug)}" href="${config.discord}" title="${escape(g.name)} — ${escape(t.catalogue.onDiscord)}"><span class="game-dot ${g.active ? 'active' : ''}" aria-hidden="true"></span><span>${escape(g.name)}<small>${escape(t.catalogue.genres[g.genre])}</small></span><span class="game-arrow" aria-hidden="true">↗</span></a></li>`,
    )
    .join('');
  return `<section class="section catalogue wrap" id="catalogue"><div class="section-heading"><div><p class="eyebrow">${t.catalogue.eyebrow}</p><h2>${t.catalogue.title}</h2></div><p class="section-description">${t.catalogue.body}</p></div><form class="catalogue-toolbar" data-enhance hidden role="search"><div class="catalogue-tabs" role="group" aria-label="${t.nav.games}"><button type="button" data-filter="active" aria-pressed="true"><span class="live-dot" aria-hidden="true"></span>${t.catalogue.active}</button><button type="button" data-filter="all" aria-pressed="false">${t.catalogue.all}<span class="tab-count">${catalogue.games.length}</span></button></div><div class="catalogue-inputs"><label class="search-field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><span class="sr-only">${t.catalogue.search}</span><input type="search" name="q" placeholder="${t.catalogue.placeholder}" autocomplete="off"></label><label><span class="sr-only">${t.catalogue.genre}</span><select name="genre"><option value="all">${t.catalogue.genre}</option>${Object.entries(
    t.catalogue.genres,
  )
    .map(([key, label]) => `<option value="${key}">${escape(label)}</option>`)
    .join(
      '',
    )}</select></label></div></form><p class="catalogue-count" aria-live="polite" aria-atomic="true"><span data-result-count>${catalogue.games.length}</span> <span data-result-label data-one="${escape(t.catalogue.countOne)}" data-many="${escape(t.catalogue.count)}">${escape(t.catalogue.count)}</span></p><ul class="catalogue-grid">${gameRows}</ul><p class="empty-message" hidden>${t.catalogue.empty}</p><p class="snapshot"><span class="game-dot active" aria-hidden="true"></span>${t.catalogue.snapshot}</p></section>`;
}
