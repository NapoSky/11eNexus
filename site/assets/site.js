(() => {
  document.querySelectorAll('[data-enhance]').forEach((element) => {
    element.hidden = false;
  });

  const sceneButtons = document.querySelectorAll('[data-hero]');
  const heroScene = document.querySelector('.hero-scene');
  sceneButtons.forEach((button) => {
    button.addEventListener('click', () => {
      sceneButtons.forEach((other) => {
        other.setAttribute('aria-pressed', String(other === button));
      });
      heroScene.src = button.dataset.sceneSrc;
      heroScene.dataset.scene = button.dataset.hero;
    });
  });

  const form = document.querySelector('.catalogue-toolbar');
  if (form instanceof HTMLFormElement) {
    const rows = [...document.querySelectorAll('.catalogue-item')];
    const buttons = [...document.querySelectorAll('[data-filter]')];
    const query = form.elements.namedItem('q');
    const genre = form.elements.namedItem('genre');
    const count = document.querySelector('[data-result-count]');
    const label = document.querySelector('[data-result-label]');
    const empty = document.querySelector('.empty-message');
    const normalize = (value) =>
      value
        .normalize('NFKD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[.'’]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    let filter = 'active';
    function update() {
      const terms = normalize(query.value).split(' ').filter(Boolean);
      let visible = 0;
      rows.forEach((row) => {
        const name = normalize(row.dataset.name);
        const match =
          (filter === 'all' || row.dataset.active === 'true') &&
          (genre.value === 'all' || genre.value === row.dataset.genre) &&
          terms.every((term) => name.includes(term));
        row.hidden = !match;
        if (match) visible += 1;
      });
      count.textContent = String(visible);
      label.textContent = visible === 1 ? label.dataset.one : label.dataset.many;
      empty.hidden = visible > 0;
      buttons.forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
      });
    }
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        filter = button.dataset.filter;
        update();
      });
    });
    form.addEventListener('submit', (event) => event.preventDefault());
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
    const revealLinkedGame = () => {
      const target = document.getElementById(window.location.hash.slice(1));
      if (!target?.matches('.catalogue-game')) return;
      filter = 'all';
      query.value = '';
      genre.value = 'all';
      update();
      requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
    };
    window.addEventListener('hashchange', revealLinkedGame);
    revealLinkedGame();
  }

  document.querySelectorAll('.mobile-menu a').forEach((link) => {
    link.addEventListener('click', () => {
      link.closest('details').open = false;
    });
  });
})();
