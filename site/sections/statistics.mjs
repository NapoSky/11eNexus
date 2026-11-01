export function statistics({ t, catalogue }) {
  return `<div class="community-strip"><div class="wrap"><div><strong>${catalogue.games.length}</strong><span>${t.strip.games}</span></div><div><strong>${catalogue.games.filter((g) => g.active).length}</strong><span>${t.strip.active}</span></div><div><strong>FR<span class="stat-slash">/</span>EN</strong><span>${t.strip.languages}</span></div><p><span aria-hidden="true">✳</span>${t.strip.spirit}</p></div></div>`;
}
