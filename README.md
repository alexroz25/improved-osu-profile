# OsuProfile+

Improves the look of your osu! profile.

## Features

- **Star ratings on scores:** each play in the Scores section (Pinned, Best Performance and First Place) gets a star rating badge next to its difficulty name, coloured the same way osu! colours difficulties. Plays with mods show the star rating with those mods applied; hover the badge to see the rating without mods.
- **Hit counts on scores:** each play in the Scores section also shows its hit counts to the right of its accuracy, coloured the way osu!'s score page colours them: in osu!, blue for great, green for ok, yellow for meh and red for miss. Taiko, catch and mania profiles show the judgements their score pages show (e.g. all six in mania). Hit counts don't need the API setup below.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder.
4. Open any osu! profile, e.g. <https://osu.ppy.sh/users/15806061>.

After pulling changes, click the reload button on the extension's card in `chrome://extensions`, then refresh the profile page.

## Setting up modded star ratings

Without this step, the badges show each map's base star rating (no mods). To include mods, the extension needs your own osu! API credentials:

1. On osu!, go to [Account settings → OAuth](https://osu.ppy.sh/home/account/edit#oauth) and click **New OAuth Application**.
2. Give it any name. For **Application Callback URLs**, enter `http://localhost` (it isn't used).
3. Open the extension's options: on `chrome://extensions`, click **Details** on OsuProfile+, then **Extension options**.
4. Paste the application's **Client ID** and **Client Secret** and click **Save**. The extension checks them with osu! and shows **Saved** if they work.

Open profile tabs pick up the credentials automatically.

### Notes

- Credentials are stored only in your browser's extension storage and are used only to request star ratings from the osu! API. They can't be read by osu! pages.
- Modded star ratings are cached for 30 days, so each play is only looked up once. To force a refresh (e.g. after an osu! star rating rework), click **Clear cache** on the options page.
- The first visit to a profile with many modded plays can take a minute or two to fill in, as requests are spaced out to stay within osu!'s API rate limits.
