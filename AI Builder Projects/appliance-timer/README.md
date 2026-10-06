# Appliance Timer ⚡

**Find the cheapest time to run your dishwasher, washer, dryer or EV charger, today and over the next 7 days.**

On a flexible electricity plan (like PG&E's Hourly Flex Pricing), the price changes every hour: cheap at midday when
solar floods the grid, expensive in the evening when everyone gets home. Running the same load at the wrong time can
cost several times more. Appliance Timer tells you *when* to run things.

- **Today and tomorrow:** uses the real prices published by CAISO, California's grid operator.
- **The days after:** uses a machine-learning model that forecasts hourly prices from the weather forecast, the
  calendar and recent prices. It retrains itself every afternoon.
- **Your appliances:** turns those prices into the best start time, and cost, for each appliance you add.

It runs as a **Chrome extension** (a side panel in Chrome) and as a **Mac menu bar app**. Both show the same panel and
share your appliance list.

> Covers the PG&E area of Northern California (prices from CAISO's PG&E zone, weather for San Francisco and California
> power sites). Costs shown are the wholesale energy part of the price; your bill adds delivery and fixed charges.

---

## Install the Chrome extension

1. **Get the files.** Download or clone this project folder to your computer (it contains a folder called
   `extension`).
2. **Open Chrome's extensions page.** Type `chrome://extensions` in the address bar and press Enter.
3. **Turn on Developer mode.** Use the switch in the top-right corner of that page.
4. **Load the extension.** Click **Load unpacked** (top left), then select the `extension` folder inside the
   project folder and click **Select**.
5. **Pin it.** Click the puzzle-piece icon in Chrome's toolbar and click the pin next to **Appliance Timer**, so its
   icon (a sun with a clock) stays visible.
6. **Open it.** Click the Appliance Timer icon. The panel opens on the side of the browser. Drag its edge to make it
   wider if you like; Chrome remembers the width.

Requires Chrome 116 or newer. Chrome may ask you to allow the extension to reach a few websites (weather, ENERGY
STAR and the EPA's vehicle database); these are used for the forecast and for looking up appliances.

**Updating:** when the files in `extension` change, go back to `chrome://extensions` and click the circular reload
arrow on the Appliance Timer card.

**Don't move the folder** after loading it. Chrome loads the extension from that location; if you move it, remove
the extension and load it again.

## Install the Mac app (optional)

The Mac version lives in your menu bar (a ☀️ icon with today's best start time) and adds "Start now" notifications.

1. Open Terminal, go to the project folder (`cd` followed by its path), and run:
   ```bash
   macapp/build.sh install
   ```
   This needs Apple's command-line tools. If macOS offers to install them, accept and run the command again.
2. The app opens automatically and appears in the menu bar. **Click** the ☀️ to open the panel; **right-click** it
   for Refresh, Open at Login and Quit.
3. If you also use the Chrome extension, both now share the same appliance list. Reload the extension once
   (step "Updating" above) after installing the Mac app.

---

## How to use it

**Today card (top).** The best start time for each of your appliances, what it will cost, and the worst time to
avoid. It also shows:
- **Run everything together:** the single best time to start all your appliances at once.
- **Delay Start advice** for dishwashers with fixed delay buttons ("If you load it now: Delay 6h").
- **+ Add to calendar:** add the day's plan to Google Calendar or Apple Calendar, with a reminder.

**Next 7 days.** The cost of running everything on each day, with the **cheapest day** highlighted. Days marked ✓
use real published prices; the rest are forecasts. Click a day to see its plan. **+ Add to calendar** adds the
cheapest day to your calendar.

**Cost by start time chart.** How much it would cost to start at each hour. Use the buttons above it to view all
appliances together or one at a time; the three cheapest start times are highlighted. Hover a bar for details.

**Weather behind it.** The weather driving the forecast (sun, heat and wind compared with a typical day).

**My appliances.** Your list, editable at any time: name, energy per run (kWh) and run time (hours).
- **Add an appliance:** type its brand and model number (e.g. `Samsung DW80CG4021SR`) and click **Look up**. Energy
  use comes from ENERGY STAR for dishwashers, washers and dryers. If it isn't listed, use the Google search link and
  enter the kWh yourself.
- **Add an electric car:** type the year, make and model (e.g. `2024 Tesla Model 3`), pick your version, then choose
  your charger and how many miles you drive a day. The app works out how much energy it needs and how long it takes
  to charge. Set **plugged in from** and **ready by** times, and it finds the cheapest charging window, including
  overnight.
- **Reset to defaults** restores the starting list.

**Alerts (Mac app only).** Tick **Notify me when it's time to start each appliance** to get a notification at each
appliance's cheapest start time, with a **Snooze 30 min** button. macOS asks for permission the first time.

**Top of the panel.** **Time source** (network time by default) and when the model was last retrained. If that line
turns amber, the daily retrain hasn't run for over a day, so the model may be out of date.

---

## How it works

| Step | What happens |
|---|---|
| Data | 3 years of hourly CAISO prices for the PG&E area, archived weather forecasts for 7 California sites (solar, heat, wind), the calendar, and recent prices |
| Model | An ensemble of three models (per-hour lasso, LightGBM, and a neural network that predicts all 24 hours of a day at once), chosen from 16 candidates and tuned with Bayesian optimization |
| Accuracy | On a year of test weeks it never saw, 2–6 days ahead: R² 0.83 → 0.72 and an average miss of about half a cent per kWh; recommended start times capture ~97% of the possible savings vs running at 6pm |
| Every afternoon | A scheduled job downloads the newly published prices, grades yesterday's forecast, retrains the model and sends it to both apps |
| In the app | The trained model runs right in the panel (about 2 ms per day, no server) using the live weather forecast |

---

## For developers

### Project layout

| Path | What it is |
|---|---|
| `extension/` | The Chrome extension: `popup.html/js/css` (the panel), `core.js` (model, weather, prices, lookups, scheduling), `background.js` (toolbar badge), `model.json` (the trained model), `scores.json` (daily grades) |
| `macapp/` | The Mac menu bar app wrapping the same panel (Swift + a small JS shim); `build.sh` builds and installs it |
| `retrain.py` | The daily job: update data, grade yesterday's forecast, retrain, publish the model to both apps |
| `pipeline.py` | Downloads and cleans CAISO prices and Open-Meteo weather (observed + archived forecasts) → `data/clean/` |
| `search.py` | Feature building and the model wrappers (lasso, LightGBM, day-curve net) used by the ensemble |
| `recent_prices.py` | The 4 recent-price inputs (only prices already published when a forecast is made) |
| `level_fix.py` | The latest-year level model behind the level shift |
| `tune_ensemble.py` | The ensemble and its tuned settings (`data/search/tune_ensemble.pkl`) |
| `train_extension_model.py` | Trains the ensemble and exports it as plain numbers to `extension/model.json` |
| `com.appliance-timer.retrain.plist` | launchd schedule for the daily retrain (2:15pm) |
| `data/` | `raw/` downloads, `clean/` cleaned tables, `model/` the saved current model, `search/` tuned settings |

### Daily retrain

`retrain.py` runs at 2:15pm (CAISO publishes the next day's prices around 1pm Pacific); log in
`~/Library/Logs/appliance-timer-retrain.log`. It downloads new prices and weather (rolling 3-year window), grades each
newly published day with the *previous* model → `extension/scores.json`, retrains → `extension/model.json` (including
the last 60 days of actual prices), and copies both to `~/Library/Application Support/Appliance Timer/` for the Mac
app.

```bash
cp com.appliance-timer.retrain.plist ~/Library/LaunchAgents/          # schedule it (once)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.appliance-timer.retrain.plist
python3 retrain.py            # what launchd runs
python3 retrain.py --status   # what's been trained and graded
python3 retrain.py --rebuild  # retrain and publish now, without grading
python3 pipeline.py           # first-time download of the 3 years of data (~20 min)
```

### Shared settings

Appliances and preferences live in `~/Library/Application Support/Appliance Timer/settings.json`. The Mac app reads it
directly; the extension reaches it through Chrome native messaging (`com.appliance_timer.settings`, the Mac app in
helper mode), keeping its own copy if the Mac app isn't installed. An unpacked extension's ID depends on its folder,
so re-run `macapp/build.sh install` if `extension/` moves.

### How the apps run the model

`extension/core.js` reads `model.json` (≈1.6 MB) and computes everything locally:

| Key | Contents |
|---|---|
| `features` | 32 inputs: season, day of week, holidays; for 7 sites the hourly value and daily summary of solar, heat or wind; 4 recent-price inputs |
| `recent_prices`, `published`, `lag_max_gap` | the last 60 days of actual hourly prices, and which days CAISO really published (filled gaps excluded) |
| `sites` | forecast locations and roles; `radiation_shift_hours: −1` aligns Open-Meteo radiation to the price hour |
| `lasso` | 24 per-hour linear models |
| `lgbm` | 637 decision trees (thresholds at full precision) |
| `net` | the day-curve net: input layout, normalisation, 3 trained copies, GELU, output scaling |
| `weights`, `shift` | blend weights and the level shift |
| `holidays`, `climatology` | US holidays; typical weather by day of year and hour for dates past the 16-day forecast |
| `trained_on`, `trained_through`, `retrained_at`, `validation` | shown in the panel header and footer |
