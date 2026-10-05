// Adds each play's hit counts (e.g. great / ok / meh / miss in osu!) to the
// right of its accuracy in the profile's Scores section, coloured the way the
// osu! score page colours them.
//
// Counts come from the score JSON forwarded by score-data.js. Unlike star
// ratings they don't depend on mods, so no API lookup is needed.

(() => {
  // The judgements osu-web shows on its score page for each ruleset
  // (resources/js/utils/score-helper.ts, the "basic" statistics), in order.
  const JUDGEMENTS = {
    0: ['great', 'ok', 'meh', 'miss'],
    1: ['great', 'ok', 'miss'],
    2: ['great', 'miss'],
    3: ['perfect', 'great', 'good', 'ok', 'meh', 'miss'],
  };

  // score id -> [[judgement, count], ...]
  const counts = new Map();

  const collectScores = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collectScores);
    } else if (node && typeof node === 'object') {
      const judgements = JUDGEMENTS[node.ruleset_id];
      if (judgements && Number.isInteger(node.id) && node.statistics && typeof node.statistics === 'object') {
        // osu! leaves out judgements that never happened.
        counts.set(String(node.id), judgements.map((j) => [j, node.statistics[j] ?? 0]));
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

  profileFeatures.subscribe(scheduleRender);

  const scoreIdOf = (row) =>
    row.querySelector('.play-detail__bg-link')?.getAttribute('href')?.match(/\/scores\/(\d+)/)?.[1];

  const render = () => {
    const on = profileFeatures.enabled('hitCounts');

    // Only the Scores section, matching star-rating.js.
    for (const row of document.querySelectorAll('[data-page-id="top_ranks"] .play-detail')) {
      const accuracy = row.querySelector('.play-detail__accuracy');
      if (!accuracy) continue;

      const scoreId = scoreIdOf(row);
      // Turned off on the options page: remove any counts already shown.
      const scoreCounts = on ? counts.get(scoreId) : null;
      let el = row.querySelector('.osu-profile-plus-hits');

      if (scoreCounts == null) {
        el?.remove();
        continue;
      }

      // React can reuse a row for a different score (e.g. reordering pinned
      // scores), so rebuild whenever the score changes.
      if (el?.dataset.scoreId === scoreId) continue;

      if (!el) {
        el = document.createElement('span');
        accuracy.after(el);
      }
      el.className = 'osu-profile-plus-hits';
      el.dataset.scoreId = scoreId;
      el.replaceChildren(
        ...scoreCounts.map(([judgement, count]) => {
          const span = document.createElement('span');
          span.className = `osu-profile-plus-hits__count osu-profile-plus-hits__count--${judgement}`;
          span.textContent = count.toLocaleString();
          return span;
        }),
      );
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
