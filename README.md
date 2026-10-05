# OsuProfile+

Improves the look of your osu! profile.

## Development

There's no build step — Chrome loads the extension straight from this folder.

### Load the extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's folder (the one containing `manifest.json`).

### Test a change

1. Save your edits.
2. On `chrome://extensions`, click the reload icon (↻) on the OsuProfile+ card.
3. Refresh an osu! profile tab (e.g. `https://osu.ppy.sh/users/<id>`).

### Tips

- Prototype CSS in DevTools (F12 → Elements → Styles) on a profile page, then copy it into `profile.css`. The extension's rules show up in the Styles pane too, so you can see whether they apply or are being overridden.
- If a rule doesn't take effect, osu!'s own styles may be more specific — tighten the selector before reaching for `!important`.
- Manifest or script errors appear under the **Errors** button on the extension's card in `chrome://extensions`.
