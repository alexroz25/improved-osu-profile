# OsuProfile+

Improves the look of your osu! profile.

## Features

- **Star ratings on scores:** each play in the Scores section (Pinned, Best Performance and First Place) gets a star rating badge next to its difficulty name, coloured the same way osu! colours difficulties. Plays with mods show the star rating with those mods applied; hover the badge to see the rating without mods.
- **Hit counts on scores:** each play in the Scores section also shows its hit counts to the right of its accuracy, coloured the way osu!'s score page colours them: in osu!, blue for great, green for ok, yellow for meh and red for miss. Taiko, catch and mania profiles show the judgements their score pages show (e.g. all six in mania). Hit counts don't need the API setup below.
- **Beatmap backgrounds on scores:** each play in the Scores section shows its beatmap's background on the left of the row, fading into the row's usual colour. Like hit counts, this doesn't need the API setup below.
- **Max pp on scores:** under each play's pp, the pp an SS (100% accuracy, full combo) of the same map with the same mods would give, e.g. with HD, DT, HR, FL, and CL (which leaves slider heads out of accuracy, so CL plays have a lower max). It's calculated with osu!'s current pp formulas from the map's difficulty with those mods, so it needs the API setup below. It isn't shown for plays that don't give pp (e.g. on loved maps), for plays with lazer-only mods that change difficulty (e.g. Traceable), which the osu! API can't look up, or on taiko profiles, where the API doesn't yet give everything the pp formula needs.

Each of the four score features above can be turned off on the extension's options page (see [Setting up modded star ratings, max pp and the pp calculator](#setting-up-modded-star-ratings-max-pp-and-the-pp-calculator) for how to open it), under **Profile features**. They're all on by default, and changes apply to open profiles straight away.

- **pp calculator:** on a beatmap page (e.g. <https://osu.ppy.sh/beatmapsets/2171371#osu/4894158>), click the extension's icon in the toolbar to see what a play on that difficulty would be worth. Pick mods, then enter an accuracy (with misses and combo) or exact hit counts; it also lists the pp at 95–100% accuracy. It works for osu!, osu!catch and osu!mania, including converted beatmaps (pick the ruleset's tab on the beatmap page), and uses the same formulas as max pp, so it needs the API setup below. Mods are remembered between beatmaps. Notes:
  - The popup notes that its pp may not be 100% accurate, and marks estimated values with `~`.
  - Plays without misses match osu!'s own pp. The osu! API leaves out part of what osu!'s miss penalty uses, so osu! plays with misses are estimated (within about 1pp of ranked lazer plays in testing).
  - With CL (stable scoring), combo breaks are estimated from combo. Ranked stable plays use their score instead, so a real play's pp can differ by a few pp or more.
  - Taiko isn't supported, for the same reason as max pp. Mod settings (e.g. custom DT speeds) and lazer-only mods aren't offered, as the API can't look them up.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder.
4. Open any osu! profile, e.g. <https://osu.ppy.sh/users/15806061>.

After pulling changes, click the reload button on the extension's card in `chrome://extensions`, then refresh the profile page.

## Setting up modded star ratings, max pp and the pp calculator

Without this step, the badges show each map's base star rating (no mods), max pp isn't shown and the pp calculator asks for credentials. All three need your own osu! API credentials:

1. On osu!, go to [Account settings → OAuth](https://osu.ppy.sh/home/account/edit#oauth) and click **New OAuth Application**.
2. Give it any name. For **Application Callback URLs**, enter `http://localhost` (it isn't used).
3. Open the extension's options: on `chrome://extensions`, click **Details** on OsuProfile+, then **Extension options**.
4. Paste the application's **Client ID** and **Client Secret** and click **Save**. The extension checks them with osu! and shows **Saved** if they work.

Open profile tabs pick up the credentials automatically. The calculator's popup also links to the options page when no credentials are set.

### Notes

- Credentials are stored only in your browser's extension storage and are used only to request beatmap difficulty details from the osu! API. They can't be read by osu! pages.
- Beatmap difficulty details (star ratings and what max pp is calculated from) are cached for 30 days, so each play is only looked up once. To force a refresh (e.g. after an osu! star rating rework), click **Clear cache** on the options page.
- When osu! changes its pp formulas, max pp and the calculator need an extension update (`pp-calculator.js`) to match; star rating changes come through the API on their own.
- The first visit to a profile with many plays can take a minute or two to fill in, as requests are spaced out to stay within osu!'s API rate limits.
