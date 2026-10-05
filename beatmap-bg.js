// Shows each play's beatmap background on the left side of its row in the
// profile's Scores section, fading into the row's usual background colour.
//
// The background comes from beatmapset.covers in the score JSON forwarded by
// score-data.js, the same images osu! uses for the score page, so no extra
// requests are needed beyond loading the image itself.

(() => {
  // score id -> cover image URL
  const covers = new Map();

  // Only accept osu!'s own https image URLs, so nothing unexpected ends up in
  // a CSS url().
  const coverUrl = (covers) => {
    try {
      const url = new URL(covers['card@2x'] ?? covers.card);
      return url.protocol === 'https:' && url.hostname.endsWith('.ppy.sh') ? url.href : null;
    } catch {
      return null;
    }
  };

  const collectScores = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collectScores);
    } else if (node && typeof node === 'object') {
      const setCovers = node.beatmapset?.covers;
      if (Number.isInteger(node.id) && setCovers && typeof setCovers === 'object') {
        const url = coverUrl(setCovers);
        if (url) covers.set(String(node.id), url);
      }
      Object.values(node).forEach(collectScores);
    }
  };

  document.addEventListener('osu-profile-plus:scores', (event) => {
    try {
      collectScores(JSON.parse(event.detail));
    } catch {
      // Not JSON or unexpected shape; leave the rows as osu! rendered them.
    }
    scheduleRender();
  });

  const scoreIdOf = (row) =>
    row.querySelector('.play-detail__bg-link')?.getAttribute('href')?.match(/\/scores\/(\d+)/)?.[1];

  const render = () => {
    // Only the Scores section, matching star-rating.js.
    for (const row of document.querySelectorAll('[data-page-id="top_ranks"] .play-detail')) {
      const group = row.querySelector('.play-detail__group--top');
      if (!group) continue;

      const url = covers.get(scoreIdOf(row));

      if (url == null) {
        group.classList.remove('osu-profile-plus-bg');
        group.style.removeProperty('--osu-profile-plus-bg');
        continue;
      }

      // React can reuse a row for a different score (e.g. reordering pinned
      // scores), so compare against the score's own cover each time.
      const value = `url("${url}")`;
      if (group.style.getPropertyValue('--osu-profile-plus-bg') === value) continue;

      group.classList.add('osu-profile-plus-bg');
      group.style.setProperty('--osu-profile-plus-bg', value);
    }
  };

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // See star-rating.js: rows appear via React and Turbo navigation.
  new MutationObserver(scheduleRender).observe(document, {
    childList: true,
    subtree: true,
  });
})();
