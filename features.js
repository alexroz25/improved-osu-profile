// Which profile features are turned on, from the toggles on the options page.
// Shared by the content script and options page.
//
// Settings are stored as { features: { starRatings: false, ... } }. A feature
// that isn't in there is on, so everything is on until turned off and new
// features start out on too.

const profileFeatures = (() => {
  let settings = null;
  const listeners = new Set();

  const notify = () => listeners.forEach((listener) => listener());

  // Report everything as off until settings have loaded, so a turned-off
  // feature doesn't flash onto the page first. Loading takes milliseconds,
  // well before the profile's scores arrive.
  const enabled = (name) => settings != null && settings[name] !== false;

  const subscribe = (listener) => listeners.add(listener);

  const set = async (name, on) => {
    const { features } = await chrome.storage.local.get('features');
    await chrome.storage.local.set({ features: { ...features, [name]: on } });
  };

  // Resolves once settings have loaded. Listeners subscribed after that
  // missed the first notify(), so they can wait on this instead.
  const ready = chrome.storage.local.get('features').then(({ features }) => {
    settings = features ?? {};
    notify();
  });

  // Apply toggles from the options page to open tabs without a refresh.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.features) return;
    settings = changes.features.newValue ?? {};
    notify();
  });

  return { ready, enabled, subscribe, set };
})();
