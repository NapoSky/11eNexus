import { escapeHtml as escape, arrow, discord } from '../lib/html.mjs';

export function hero({ t, config }) {
  const heroGames = ['valheim', 'stellaris', 'helldivers-2'];
  return `<section class="hero" aria-labelledby="hero-title">
    <div class="hero-art" aria-hidden="true"><img src="/assets/games/valheim.webp" width="1920" height="620" alt="" class="hero-scene is-current" data-scene="valheim" loading="eager" fetchpriority="high" decoding="async"></div>
    <div class="hero-grid" aria-hidden="true"></div>
    <div class="hero-content wrap">
      <h1 id="hero-title"><span class="hero-identity">${escape(t.hero.eyebrow)}</span>${escape(t.hero.line1)}<br><span>${escape(t.hero.line2)}</span></h1>
      <p class="hero-description">${escape(t.hero.body)}</p>
      <div class="hero-actions"><a class="button" href="${escape(config.discord)}">${discord}${escape(t.hero.primary)}${arrow}</a><a class="text-link" href="#games">${escape(t.hero.secondary)}<span aria-hidden="true">↓</span></a></div>
      <p class="hero-footnote">${escape(t.hero.footnote)}</p>
    </div>
    <div class="hero-bottom wrap"><a class="scroll-cue" href="#community"><span aria-hidden="true">↓</span>${escape(t.hero.scroll)}</a><div class="scene-controls" data-enhance hidden><span>${escape(t.hero.caption)}</span><div role="group" aria-label="${escape(t.hero.switch)}">${heroGames
      .map((slug, index) => {
        const name = t.featured.cards.find((card) => card.slug === slug).name;
        return `<button type="button" data-hero="${slug}" data-scene-src="/assets/games/${slug}.webp" aria-pressed="${index === 0}"><span class="scene-number">0${index + 1}</span> ${escape(name)}</button>`;
      })
      .join('')}</div></div></div>
  </section>`;
}
