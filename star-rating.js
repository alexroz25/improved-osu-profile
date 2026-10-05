// Adds a star rating badge next to the difficulty name of each play in the
// profile's Scores section.
//
// Score data arrives from score-data.js, which forwards the JSON the profile
// already requests. Each score includes beatmap.difficulty_rating, the base
// star rating without mods, which is shown straight away. If the play has mods
// and OAuth credentials are set on the options page, the badge is then updated
// to the star rating with those mods, from the osu! API. Modded ratings are
// cached in chrome.storage.local so each one is only fetched once.

(() => {
  const CACHE_PREFIX = 'sr:';
  // Star ratings change only with occasional osu! difficulty reworks.
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  // osu! asks API users to stay around 60 requests per minute.
  const REQUEST_INTERVAL = 1000;
  const RATE_LIMIT_BACKOFF = 60 * 1000;

  // score id -> { beatmapId, rulesetId, baseRating, mods }
  const scores = new Map();
  // cache key -> star rating with mods
  const moddedRatings = new Map();
  // cache keys already looked up (or being looked up) on this page load
  const requested = new Set();
  const queue = [];
  let queueRunning = false;
  let apiDisabled = false;

  const collectScores = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collectScores);
    } else if (node && typeof node === 'object') {
      const { beatmap } = node;
      if (beatmap && Number.isInteger(node.id) && Number.isInteger(beatmap.id) && typeof beatmap.difficulty_rating === 'number') {
        scores.set(String(node.id), {
          beatmapId: beatmap.id,
          rulesetId: node.ruleset_id,
          baseRating: beatmap.difficulty_rating,
          mods: Array.isArray(node.mods) ? node.mods : [],
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

  // Same star rating for the same difficulty, ruleset and mods (including mod
  // settings such as a custom DT speed), regardless of mod order.
  const cacheKey = ({ beatmapId, rulesetId, mods }) => {
    const sortedMods = [...mods].sort((a, b) => a.acronym.localeCompare(b.acronym));
    return `${CACHE_PREFIX}${beatmapId}:${rulesetId}:${JSON.stringify(sortedMods)}`;
  };

  const requestModdedRating = async (score) => {
    const key = cacheKey(score);
    if (apiDisabled || requested.has(key)) return;
    requested.add(key);

    try {
      const cached = (await chrome.storage.local.get(key))[key];
      if (cached && Date.now() - cached.savedAt < CACHE_TTL) {
        moddedRatings.set(key, cached.rating);
        scheduleRender();
        return;
      }
    } catch {
      // Storage is unavailable after the extension is reloaded; this tab keeps
      // showing base ratings until it's refreshed.
      return;
    }

    queue.push({ key, score });
    runQueue();
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const runQueue = async () => {
    if (queueRunning) return;
    queueRunning = true;

    while (queue.length > 0 && !apiDisabled) {
      const { key, score } = queue.shift();
      try {
        const rating = await osuApi.starRating(score.beatmapId, score.rulesetId, score.mods);
        moddedRatings.set(key, rating);
        await chrome.storage.local.set({ [key]: { rating, savedAt: Date.now() } });
        scheduleRender();
      } catch (error) {
        if (error instanceof osuApi.CredentialsError) {
          // No working OAuth app set up; stick to base ratings.
          apiDisabled = true;
          queue.length = 0;
        } else if (error instanceof osuApi.RateLimitError) {
          queue.unshift({ key, score });
          await sleep(RATE_LIMIT_BACKOFF);
        } else {
          console.warn('OsuProfile+: could not fetch modded star rating', error);
        }
      }
      await sleep(REQUEST_INTERVAL);
    }

    queueRunning = false;
  };

  // Pick up credentials entered on the options page without a refresh.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.clientId && !changes.clientSecret) return;
    apiDisabled = false;
    queue.length = 0;
    requested.clear();
    scheduleRender();
  });

  // Same colour scale osu-web uses for its difficulty badges
  // (resources/js/utils/beatmap-helper.ts).
  const SPECTRUM_DOMAIN = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9];
  const SPECTRUM_RANGE = ['#4290FB', '#4FC0FF', '#4FFFD5', '#7CFF4F', '#F6F05C', '#FF8068', '#FF4E6F', '#C645B8', '#6563DE', '#18158E', '#000000'];

  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  // Matches d3.interpolateRgb.gamma(2.2).
  const interpolate = (from, to, t) => {
    const channels = hexToRgb(from).map((a, i) => {
      const b = hexToRgb(to)[i];
      const ag = a ** 2.2;
      return Math.round((ag + t * (b ** 2.2 - ag)) ** (1 / 2.2));
    });
    return `rgb(${channels.join(', ')})`;
  };

  const diffColour = (rating) => {
    if (rating < 0.1) return '#AAAAAA';
    if (rating >= 9) return '#000000';
    const i = SPECTRUM_DOMAIN.findIndex((d) => rating < d) - 1;
    const t = (rating - SPECTRUM_DOMAIN[i]) / (SPECTRUM_DOMAIN[i + 1] - SPECTRUM_DOMAIN[i]);
    return interpolate(SPECTRUM_RANGE[i], SPECTRUM_RANGE[i + 1], t);
  };

  const diffTextColour = (rating) => (rating < 6.5 ? '#000000' : '#F6F05C');

  // osu! floors star ratings to two decimals rather than rounding. The epsilon
  // keeps float error from flooring e.g. 9.87 (986.999… × 0.01) to 9.86.
  const formatRating = (rating) => (Math.floor(rating * 100 + 1e-9) / 100).toFixed(2);

  const scoreIdOf = (row) =>
    row.querySelector('.play-detail__bg-link')?.getAttribute('href')?.match(/\/scores\/(\d+)/)?.[1];

  // Reuses osu-web's own difficulty-badge classes so the badge picks up the
  // site's font, sizing and star icon.
  const createBadge = () => {
    const badge = document.createElement('span');
    badge.className = 'difficulty-badge difficulty-badge--beatmapset osu-profile-plus-stars';
    badge.innerHTML =
      '<span class="difficulty-badge__icon"><span class="fas fa-star"></span></span>' +
      '<span class="difficulty-badge__rating"></span>';
    return badge;
  };

  const render = () => {
    // Only the Scores section; Historical reuses the same row markup.
    for (const row of document.querySelectorAll('[data-page-id="top_ranks"] .play-detail')) {
      const container = row.querySelector('.play-detail__beatmap-and-time');
      if (!container) continue;

      const scoreId = scoreIdOf(row);
      const score = scores.get(scoreId);
      let badge = container.querySelector('.osu-profile-plus-stars');

      if (score == null) {
        badge?.remove();
        continue;
      }

      let rating = score.baseRating;
      if (score.mods.length > 0) {
        const modded = moddedRatings.get(cacheKey(score));
        if (modded == null) {
          requestModdedRating(score);
        } else {
          rating = modded;
        }
      }

      // React can reuse a row for a different score (e.g. reordering pinned
      // scores), so refresh the badge whenever the score or rating changes.
      const badgeKey = `${scoreId}:${rating}`;
      if (badge?.dataset.key === badgeKey) continue;

      badge ??= container.insertBefore(createBadge(), container.firstChild);
      badge.dataset.key = badgeKey;
      badge.style.setProperty('--bg', diffColour(rating));
      badge.style.color = diffTextColour(rating);
      badge.querySelector('.difficulty-badge__rating').textContent = formatRating(rating);
      badge.title = rating === score.baseRating ? '' : `${formatRating(score.baseRating)}★ without mods`;
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

  // osu! renders scores with React and navigates with Turbo, so watch for
  // rows appearing rather than looking once on load. At document_start the
  // <html> element may not exist yet, so observe the document itself.
  new MutationObserver(scheduleRender).observe(document, {
    childList: true,
    subtree: true,
  });
})();
