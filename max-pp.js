// Shows, under each play's pp in the profile's Scores section, the pp an SS
// (100% accuracy, full combo) of the same beatmap with the same mods would be
// worth.
//
// Score data comes from score-data.js. The beatmap's difficulty attributes
// with the play's mods come from the osu! API via beatmap-attributes.js, so
// this needs the OAuth credentials from the options page; pp-calculator.js
// turns them into pp. Plays that don't award pp (e.g. on loved maps) are
// skipped.

(() => {
  // score id -> { beatmapId, rulesetId, mods, beatmap, maximumStatistics }
  const scores = new Map();

  const collectScores = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collectScores);
    } else if (node && typeof node === 'object') {
      const { beatmap } = node;
      if (
        beatmap &&
        Number.isInteger(node.id) &&
        Number.isInteger(beatmap.id) &&
        Number.isInteger(node.ruleset_id) &&
        typeof node.pp === 'number' &&
        node.maximum_statistics &&
        typeof node.maximum_statistics === 'object'
      ) {
        scores.set(String(node.id), {
          beatmapId: beatmap.id,
          rulesetId: node.ruleset_id,
          mods: Array.isArray(node.mods) ? node.mods : [],
          beatmap,
          maximumStatistics: node.maximum_statistics,
        });
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

  beatmapAttributes.subscribe(scheduleRender);
  profileFeatures.subscribe(scheduleRender);

  // score id -> max pp, so each one is only calculated once
  const maxPps = new Map();

  const maxPpOf = (scoreId, score) => {
    if (maxPps.has(scoreId)) return maxPps.get(scoreId);

    const attributes = beatmapAttributes.get(score);
    if (attributes == null) return null;

    const pp = ppCalculator.maxPp({ ...score, attributes });
    maxPps.set(scoreId, pp);
    return pp;
  };

  const scoreIdOf = (row) =>
    row.querySelector('.play-detail__bg-link')?.getAttribute('href')?.match(/\/scores\/(\d+)/)?.[1];

  const render = () => {
    const on = profileFeatures.enabled('maxPp');

    // Only the Scores section, matching star-rating.js.
    for (const row of document.querySelectorAll('[data-page-id="top_ranks"] .play-detail')) {
      const ppColumn = row.querySelector('.play-detail__pp');
      if (!ppColumn) continue;

      const scoreId = scoreIdOf(row);
      // Turned off on the options page: remove any max pp already shown.
      const score = on ? scores.get(scoreId) : null;
      const pp = score == null ? null : maxPpOf(scoreId, score);
      let el = ppColumn.querySelector('.osu-profile-plus-max-pp');

      if (pp == null) {
        el?.remove();
        continue;
      }

      // React can reuse a row for a different score (e.g. reordering pinned
      // scores), so rebuild whenever the score changes.
      if (el?.dataset.scoreId === scoreId) continue;

      if (!el) {
        el = document.createElement('span');
        el.className = 'osu-profile-plus-max-pp';
        ppColumn.append(el);
      }
      el.dataset.scoreId = scoreId;
      // Rounded like osu! rounds the play's own pp beside it.
      el.textContent = `max ${Math.round(pp).toLocaleString()}pp`;
      el.title = `${pp.toLocaleString(undefined, { maximumFractionDigits: 2 })}pp for an SS with these mods`;
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
