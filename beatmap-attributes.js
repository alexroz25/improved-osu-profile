// Looks up beatmap difficulty attributes from the osu! API for the content
// scripts that need them (star-rating.js and max-pp.js), so each beatmap and
// mod combination is only requested once however many features use it.
//
// Lookups need the OAuth credentials from the options page. Attributes are
// cached in chrome.storage.local, and requests are queued and spaced out to
// stay within osu!'s rate limits.

const beatmapAttributes = (() => {
  const CACHE_PREFIX = 'attr:';
  // Attributes change only with occasional osu! difficulty reworks.
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  // osu! asks API users to stay around 60 requests per minute.
  const REQUEST_INTERVAL = 1000;
  const RATE_LIMIT_BACKOFF = 60 * 1000;

  // cache key -> attributes
  const loaded = new Map();
  // cache keys already looked up (or being looked up) on this page load
  const requested = new Set();
  const queue = [];
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

  const runQueue = async () => {
    if (queueRunning) return;
    queueRunning = true;

    while (queue.length > 0 && !apiDisabled) {
      const { key, lookup } = queue.shift();
      try {
        const attributes = await osuApi.attributes(lookup.beatmapId, lookup.rulesetId, apiMods(lookup.mods));
        loaded.set(key, attributes);
        await chrome.storage.local.set({ [key]: { attributes, savedAt: Date.now() } });
        notify();
      } catch (error) {
        if (error instanceof osuApi.CredentialsError) {
          // No working OAuth app set up; features fall back to what they can
          // show without the API.
          apiDisabled = true;
          queue.length = 0;
        } else if (error instanceof osuApi.RateLimitError) {
          queue.unshift({ key, lookup });
          await sleep(RATE_LIMIT_BACKOFF);
        } else {
          console.warn('OsuProfile+: could not fetch beatmap attributes', error);
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
  // subscribers are notified when they arrive.
  const get = (lookup) => {
    const key = cacheKey(lookup);
    const attributes = loaded.get(key);
    if (attributes != null) return attributes;

    if (!apiDisabled && !requested.has(key)) {
      requested.add(key);
      request(key, lookup);
    }
    return null;
  };

  const subscribe = (listener) => listeners.add(listener);

  // Pick up credentials entered on the options page without a refresh.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.clientId && !changes.clientSecret) return;
    apiDisabled = false;
    queue.length = 0;
    requested.clear();
    notify();
  });

  return { get, subscribe };
})();
