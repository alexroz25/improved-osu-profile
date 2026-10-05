// Must match beatmap-attributes.js. 'sr:' entries are left over from older
// versions, which cached only star ratings; clearing removes them too.
const CACHE_PREFIXES = ['attr:', 'sr:'];

const form = document.getElementById('credentials');
const clientIdInput = document.getElementById('client-id');
const clientSecretInput = document.getElementById('client-secret');
const credentialsStatus = document.getElementById('credentials-status');
const clearCacheButton = document.getElementById('clear-cache');
const cacheStatus = document.getElementById('cache-status');
const featureToggles = document.querySelectorAll('#features input[data-feature]');

const setStatus = (element, text, isError = false) => {
  element.textContent = text;
  element.classList.toggle('status--error', isError);
};

const cacheKeys = async () =>
  Object.keys(await chrome.storage.local.get(null)).filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)));

const showCacheSize = async () => {
  const count = (await cacheKeys()).length;
  setStatus(cacheStatus, `${count} saved beatmap${count === 1 ? '' : 's'}`);
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();

  setStatus(credentialsStatus, 'Checking…');
  try {
    // Only save credentials osu! accepts, and keep the token it hands back.
    const token = await osuApi.requestToken(clientId, clientSecret);
    await chrome.storage.local.set({ clientId, clientSecret, token });
    setStatus(credentialsStatus, 'Saved');
  } catch (error) {
    const message = error instanceof osuApi.CredentialsError ? 'osu! rejected these credentials' : `Couldn't reach osu! (${error.message})`;
    setStatus(credentialsStatus, message, true);
  }
});

for (const toggle of featureToggles) {
  toggle.addEventListener('change', () => profileFeatures.set(toggle.dataset.feature, toggle.checked));
}

// Also keeps the toggles in sync if they're changed in another options tab.
profileFeatures.subscribe(() => {
  for (const toggle of featureToggles) toggle.checked = profileFeatures.enabled(toggle.dataset.feature);
});

clearCacheButton.addEventListener('click', async () => {
  await chrome.storage.local.remove(await cacheKeys());
  await showCacheSize();
});

(async () => {
  const { clientId, clientSecret } = await chrome.storage.local.get(['clientId', 'clientSecret']);
  clientIdInput.value = clientId ?? '';
  clientSecretInput.value = clientSecret ?? '';
  await showCacheSize();
})();
