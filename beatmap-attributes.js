// Looks up beatmap difficulty attributes from the osu! API for the content
// scripts that need them (star-rating.js and max-pp.js) and the popup's
// calculator, so each beatmap and mod combination is only requested once
// however many features use it.
//
// Lookups need the OAuth credentials from the options page. Attributes are
// cached in chrome.storage.local, and requests are queued and spaced out to
// stay within osu!'s rate limits.

const beatmapAttributes = (() => {
  const CACHE_PREFIX = 'attr:';
  // Left over from older versions, which cached only star ratings.
  const LEGACY_CACHE_PREFIX = 'sr:';
  // Attributes change only with occasional osu! difficulty reworks.
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  // Expired entries are only replaced when their beatmap is looked up again,
  // so sweep out the rest about once a day.
  const SWEEP_INTERVAL = 24 * 60 * 60 * 1000;
  // Chrome caps storage.local at 10 MB, shared with the settings; if the cache
  // fills it, this fraction of the oldest entries makes room.
  const EVICT_FRACTION = 0.25;
  // osu! asks API users to stay around 60 requests per minute.
  const REQUEST_INTERVAL = 1000;
  const RATE_LIMIT_BACKOFF = 60 * 1000;

  // cache key -> attributes
  const loaded = new Map();
  // cache keys already looked up (or being looked up) on this page load
  const requested = new Set();
  // cache keys whose lookup failed on this page load (they aren't retried)
  const failed = new Set();
  const queue = [];
  // cache key -> lowest position on the page any caller asked for it at, so
  // lookups run top to bottom whichever feature asks first
  const positions = new Map();
  const listeners = new Set();
  let queueRunning = false;
  let apiDisabled = false;

  const notify = () => listeners.forEach((listener) => listener());

  // Same attributes for the same difficulty, ruleset and mods (including mod
  // settings such as a custom DT speed), regardless of mod order.
  const cacheKey = ({ beatmapId, rulesetId, mods }) => {
    const sortedMods = [...mods].sort((a, b) => a.acronym.localeCompare(b.acronym));
    return `${CACHE_PREFIX}${beatmapId}:${rulesetId}:${JSON.stringify(sortedMods)}`;
  };

  // osu!'s attributes service looks mods up by their osu!stable equivalent
  // and ignores daycore, which slows maps down exactly like half time, so ask
  // for half time instead.
  const apiMods = (mods) => mods.map((mod) => (mod.acronym === 'DC' ? { ...mod, acronym: 'HT' } : mod));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Removes expired (and legacy) cache entries, plus `fraction` of the oldest
  // ones left.
  const removeOldEntries = async (fraction = 0) => {
    const now = Date.now();
    const entries = Object.entries(await chrome.storage.local.get(null))
      .filter(([key]) => key.startsWith(CACHE_PREFIX) || key.startsWith(LEGACY_CACHE_PREFIX))
      .map(([key, value]) => ({ key, savedAt: key.startsWith(CACHE_PREFIX) ? value?.savedAt ?? 0 : 0 }))
      .sort((a, b) => a.savedAt - b.savedAt);
    const expired = entries.filter(({ savedAt }) => now - savedAt >= CACHE_TTL).length;
    const count = expired + Math.ceil((entries.length - expired) * fraction);
    if (count > 0) await chrome.storage.local.remove(entries.slice(0, count).map(({ key }) => key));
  };

  const sweepExpired = async () => {
    try {
      const { lastCacheSweep = 0 } = await chrome.storage.local.get('lastCacheSweep');
      if (Date.now() - lastCacheSweep < SWEEP_INTERVAL) return;
      // Sweep before recording it, so a full storage.local still gets cleared.
      await removeOldEntries();
      await chrome.storage.local.set({ lastCacheSweep: Date.now() });
    } catch (error) {
      console.warn('OsuProfile+: could not clear expired beatmap attributes', error);
    }
  };

  const save = async (key, attributes) => {
    const entry = { [key]: { attributes, savedAt: Date.now() } };
    try {
      await chrome.storage.local.set(entry);
    } catch {
      // Most likely storage.local is full; make room and try once more.
      try {
        await removeOldEntries(EVICT_FRACTION);
        await chrome.storage.local.set(entry);
      } catch (error) {
        // The attributes still show on this page, just aren't kept.
        console.warn('OsuProfile+: could not save beatmap attributes', error);
      }
    }
  };

  const runQueue = async () => {
    if (queueRunning) return;
    queueRunning = true;

    while (queue.length > 0 && !apiDisabled) {
      const next = queue.reduce((best, entry, i) => (positions.get(entry.key) < positions.get(queue[best].key) ? i : best), 0);
      const { key, lookup } = queue.splice(next, 1)[0];
      try {
        const attributes = await osuApi.attributes(lookup.beatmapId, lookup.rulesetId, apiMods(lookup.mods));
        loaded.set(key, attributes);
        notify();
        await save(key, attributes);
      } catch (error) {
        if (error instanceof osuApi.CredentialsError) {
          // No working OAuth app set up; features fall back to what they can
          // show without the API.
          apiDisabled = true;
          queue.length = 0;
          notify();
        } else if (error instanceof osuApi.RateLimitError) {
          queue.unshift({ key, lookup });
          await sleep(RATE_LIMIT_BACKOFF);
        } else {
          console.warn('OsuProfile+: could not fetch beatmap attributes', error);
          failed.add(key);
          notify();
        }
      }
      await sleep(REQUEST_INTERVAL);
    }

    queueRunning = false;
  };

  const request = async (key, lookup) => {
    try {
      const cached = (await chrome.storage.local.get(key))[key];
      if (cached && Date.now() - cached.savedAt < CACHE_TTL) {
        loaded.set(key, cached.attributes);
        notify();
        return;
      }
    } catch {
      // Storage is unavailable after the extension is reloaded; this tab keeps
      // showing what it can without attributes until it's refreshed.
      return;
    }

    queue.push({ key, lookup });
    runQueue();
  };

  // Attributes for `lookup` ({ beatmapId, rulesetId, mods }) if they've
  // loaded, otherwise null; the first call starts loading them, and
  // subscribers are notified when they arrive. `position` is where the
  // caller shows them on the page (e.g. its row index); lookups nearer the
  // top (lower positions) run first.
  const get = (lookup, position = Infinity) => {
    const key = cacheKey(lookup);
    const attributes = loaded.get(key);
    if (attributes != null) return attributes;

    if (!(positions.get(key) <= position)) positions.set(key, position);

    if (!apiDisabled && !requested.has(key)) {
      requested.add(key);
      request(key, lookup);
    }
    return null;
  };

  const subscribe = (listener) => listeners.add(listener);

  // True once osu! has rejected the credentials (or none are saved), after
  // which nothing more will load until they change.
  const isUnavailable = () => apiDisabled;

  // True if looking up `lookup` failed, so get() will keep returning null.
  const hasFailed = (lookup) => failed.has(cacheKey(lookup));

  // Pick up credentials entered on the options page without a refresh.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.clientId && !changes.clientSecret) return;
    apiDisabled = false;
    queue.length = 0;
    requested.clear();
    failed.clear();
    notify();
  });

  sweepExpired();

  return { get, subscribe, isUnavailable, hasFailed };
})();
