(() => {
  document.querySelectorAll('[data-enhance]').forEach((element) => {
    element.hidden = false;
  });

  const sceneButtons = document.querySelectorAll('[data-hero]');
  sceneButtons.forEach((button) => {
    button.addEventListener('click', () => {
      sceneButtons.forEach((other) => {
        other.setAttribute('aria-pressed', String(other === button));
      });
      document.querySelectorAll('[data-scene]').forEach((scene) => {
        scene.classList.toggle('is-current', scene.dataset.scene === button.dataset.hero);
      });
    });
  });

  const form = document.querySelector('.catalogue-toolbar');
  if (form instanceof HTMLFormElement) {
    const rows = [...document.querySelectorAll('.catalogue-game')];
    const buttons = [...document.querySelectorAll('[data-filter]')];
    const query = form.elements.namedItem('q');
    const genre = form.elements.namedItem('genre');
    const count = document.querySelector('[data-result-count]');
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
  }

  document.querySelectorAll('.mobile-menu a').forEach((link) => {
    link.addEventListener('click', () => {
      link.closest('details').open = false;
    });
  });
})();
