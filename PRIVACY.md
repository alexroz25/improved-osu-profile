# Privacy policy

OsuProfile+ is an unofficial browser extension for osu! (<https://osu.ppy.sh>). It isn't made by or affiliated with ppy Pty Ltd.

## What the extension stores

Everything below is stored only in your browser's extension storage, on your device:

- **osu! API credentials:** the OAuth Client ID and Client Secret you enter on the options page, and the temporary access token osu! issues for them.
- **Beatmap difficulty details:** star ratings and other difficulty values looked up from the osu! API, kept for 30 days so each beatmap is only looked up once. You can clear them on the options page.
- **Settings:** which profile features are turned on, and the pp calculator's last mods and inputs.

## What the extension sends, and to whom

The extension only talks to osu! (`osu.ppy.sh`):

- Your Client ID and Client Secret are sent to osu!'s OAuth endpoint to get an access token.
- That token is sent to the osu! API along with beatmap IDs and mods, to look up difficulty details for the scores on the profile you're viewing and for the beatmap open in the pp calculator.

These requests are covered by [osu!'s own privacy policy](https://osu.ppy.sh/legal/Privacy). Nothing is sent to the extension's developer or anyone else. The extension has no analytics or tracking, and doesn't sell or share data.

Score data the extension reads from osu! profile pages stays in the page; it's used to draw star ratings, hit counts, backgrounds and max pp and isn't stored or sent anywhere.

## Removing your data

Uninstalling the extension deletes everything it stored. **Clear cache** on the options page removes the saved beatmap details. To make stored credentials useless without uninstalling, delete the OAuth application from your [osu! account settings](https://osu.ppy.sh/home/account/edit#oauth).

## Contact

Questions or issues: <https://github.com/alexroz25/improved-osu-profile/issues>
