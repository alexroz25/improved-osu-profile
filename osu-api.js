// Minimal osu! API v2 client, shared by the content script, popup and options
// page.
//
// Authenticates with the client credentials grant using the user's own OAuth
// app (entered on the options page), which is enough for public endpoints
// like beatmaps and their attributes.

const osuApi = (() => {
  const BASE_URL = 'https://osu.ppy.sh';

  // Thrown when no credentials are saved or osu! rejects them.
  class CredentialsError extends Error {}
  class RateLimitError extends Error {}

  async function requestToken(clientId, clientSecret) {
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
    });
    if (res.status === 400 || res.status === 401) throw new CredentialsError(`osu! rejected the credentials (${res.status})`);
    if (!res.ok) throw new Error(`Token request failed (${res.status})`);

    const json = await res.json();
    return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  }

  async function getToken({ refresh = false } = {}) {
    const { clientId, clientSecret, token } = await chrome.storage.local.get(['clientId', 'clientSecret', 'token']);
    if (!clientId || !clientSecret) throw new CredentialsError('No credentials saved');

    // Tokens last a day; renew a minute early to avoid using one mid-expiry.
    if (!refresh && token && token.expiresAt > Date.now() + 60_000) return token.accessToken;

    const newToken = await requestToken(clientId, clientSecret);
    await chrome.storage.local.set({ token: newToken });
    return newToken.accessToken;
  }

  async function request(path, body) {
    for (const refresh of [false, true]) {
      const res = await fetch(`${BASE_URL}/api/v2${path}`, {
        method: body ? 'POST' : 'GET',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await getToken({ refresh })}`,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body && JSON.stringify(body),
      });

      // The stored token may have been revoked; retry once with a fresh one.
      if (res.status === 401 && !refresh) continue;
      if (res.status === 429) throw new RateLimitError();
      if (!res.ok) throw new Error(`Request for ${path} failed (${res.status})`);

      return res.json();
    }
  }

  // Difficulty attributes of a beatmap (difficulty) with the given mods
  // applied: its star rating and the skill values pp is calculated from.
  // `mods` takes the same shape as a score's `mods`, including any mod
  // settings.
  async function attributes(beatmapId, rulesetId, mods) {
    return (await request(`/beatmaps/${beatmapId}/attributes`, { ruleset_id: rulesetId, mods })).attributes;
  }

  // A beatmap (difficulty) with its settings, object counts and beatmapset.
  const beatmap = (beatmapId) => request(`/beatmaps/${beatmapId}`);

  // A beatmapset with all its beatmaps.
  const beatmapset = (beatmapsetId) => request(`/beatmapsets/${beatmapsetId}`);

  return { requestToken, attributes, beatmap, beatmapset, CredentialsError, RateLimitError };
})();
