"""Data pipeline: download, clean and align everything the price model needs.

Sources (all free, no keys):
  prices    CAISO OASIS day-ahead hourly LMP, PG&E default load aggregation point (DLAP_PGAE-APND), $/MWh
  observed  Open-Meteo historical weather (archive API) for 7 sites
  forecast  Open-Meteo Previous Runs API: what the forecast said 0–7 days before each hour, same 7 sites

Cleaning steps are recorded in a log (data/clean/cleaning_log.json) so the notebook can show them.
Raw downloads are cached in data/raw/, cleaned tables in data/clean/.

    python3 pipeline.py          # download (first run ~20 min) + clean
"""

import io
import json
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from pandas.tseries.holiday import USFederalHolidayCalendar

ROOT = Path(__file__).parent
RAW, CLEAN = ROOT / "data" / "raw", ROOT / "data" / "clean"
TZ = "America/Los_Angeles"
START, END = date(2023, 9, 21), date(2026, 9, 21)    # 3 years; END is exclusive
LEADS = range(0, 8)                                   # forecast lead days (0 = issued that day)
VARS = ("shortwave_radiation", "temperature_2m", "wind_speed_100m")
SITES = {  # name: (lat, lon, what it tells the model about)
    "fresno": (36.737, -119.787, "Central Valley solar and heat"),
    "mojave": (34.870, -118.160, "Mojave / Antelope Valley solar"),
    "blythe": (33.610, -114.600, "Colorado Desert solar"),
    "sacramento": (38.580, -121.490, "Northern California heat (air-conditioning load)"),
    "riverside": (33.950, -117.400, "Southern California inland heat"),
    "altamont": (37.735, -121.650, "Altamont Pass wind"),
    "tehachapi": (35.100, -118.400, "Tehachapi Pass wind"),
}
ROLES = {"solar": ("shortwave_radiation", ["fresno", "mojave", "blythe"]),
         "heat": ("temperature_2m", ["fresno", "sacramento", "riverside"]),
         "wind": ("wind_speed_100m", ["altamont", "tehachapi"])}
PLAUSIBLE = {"shortwave_radiation": (0, 1200), "temperature_2m": (-20, 130), "wind_speed_100m": (0, 120)}
HOLIDAYS = USFederalHolidayCalendar().holidays(start="2023-01-01", end="2030-12-31")


# ---------------------------------------------------------------- downloads (cached raw)

def _get(url, params, tries=6, wait=8, timeout=300):
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            if 400 <= r.status_code < 500 and r.status_code != 429:
                break   # the request itself is wrong (e.g. dates the archive doesn't have yet): retrying won't help
            r.raise_for_status()
            return r
        except Exception:
            time.sleep(wait * (attempt + 1))
    raise RuntimeError(f"download failed: {url} {params}")


def _fetch_prices(start, end, log=print):
    frames, day = [], start
    while day < end:
        nxt = min(day + timedelta(days=30), end)
        params = dict(queryname="PRC_LMP", market_run_id="DAM", version=12, node="DLAP_PGAE-APND", resultformat=6,
                      startdatetime=day.strftime("%Y%m%dT08:00-0000"), enddatetime=nxt.strftime("%Y%m%dT08:00-0000"))
        for attempt in range(6):
            r = _get("https://oasis.caiso.com/oasisapi/SingleZip", params)
            try:
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    df = pd.read_csv(z.open(z.namelist()[0]))
                if "LMP_TYPE" in df.columns:
                    break
            except zipfile.BadZipFile:
                pass
            time.sleep(10 * (attempt + 1))  # OASIS returns an error page when throttled
        else:
            raise RuntimeError(f"CAISO failed at {day}")
        frames.append(df[["INTERVALSTARTTIME_GMT", "LMP_TYPE", "MW"]])
        log(f"  prices {day} → {nxt}")
        day = nxt
        if day < end:
            time.sleep(6)
    return pd.concat(frames)


def download_prices(log=print):
    out = RAW / "caiso_dam_lmp.csv"
    if out.exists():
        return pd.read_csv(out)
    raw = _fetch_prices(START, END, log)
    RAW.mkdir(parents=True, exist_ok=True)
    raw.to_csv(out, index=False)
    return raw


def _open_meteo(url, site, cols, chunk_days, first=None, last=None):
    lat, lon, _ = SITES[site]
    parts, a, last = [], first or START - timedelta(days=2), last or END
    while a <= last:
        b = min(a + timedelta(days=chunk_days - 1), last)
        r = _get(url, dict(latitude=lat, longitude=lon, hourly=",".join(cols), timezone="GMT", start_date=str(a),
                           end_date=str(b), temperature_unit="fahrenheit", wind_speed_unit="mph"))
        h = pd.DataFrame(r.json()["hourly"])
        parts.append(h)
        a = b + timedelta(days=1)
    df = pd.concat(parts)
    df.insert(0, "site", site)
    return df


def _weather_source(kind):
    if kind == "observed":
        return "https://archive-api.open-meteo.com/v1/archive", list(VARS), 4000
    return ("https://previous-runs-api.open-meteo.com/v1/forecast",
            [v if k == 0 else f"{v}_previous_day{k}" for v in VARS for k in LEADS], 120)


def download_weather(kind, log=print):
    """kind = 'observed' (archive API) or 'forecast' (Previous Runs API, leads 0–7)."""
    out = RAW / f"weather_{kind}.csv"
    if out.exists():
        return pd.read_csv(out)
    url, cols, chunk = _weather_source(kind)
    frames = []
    for s in SITES:
        frames.append(_open_meteo(url, s, cols, chunk))
        log(f"  {kind} weather {s}")
    raw = pd.concat(frames)
    RAW.mkdir(parents=True, exist_ok=True)
    raw.to_csv(out, index=False)
    return raw


def update_raw(end, log=print):
    """Append new days to the raw downloads (daily retrain). `end` is exclusive.

    Re-fetches a few days of overlap: the observed-weather archive lags by a few days and fills in later, and the
    newest forecasts replace older copies of the same hours.
    """
    # Prices: from the last day on file
    path = RAW / "caiso_dam_lmp.csv"
    raw = pd.read_csv(path)
    last = pd.to_datetime(raw.INTERVALSTARTTIME_GMT, utc=True).max().tz_convert(TZ).date()
    if last + timedelta(days=1) < end:
        new = _fetch_prices(last, end, log)
        raw = pd.concat([raw, new]).drop_duplicates(["INTERVALSTARTTIME_GMT", "LMP_TYPE"], keep="last")
        raw.to_csv(path, index=False)
    # Weather: re-fetch the last week (observed fills in late; forecasts get newer runs)
    for kind in ("observed", "forecast"):
        path = RAW / f"weather_{kind}.csv"
        raw = pd.read_csv(path)
        first = pd.to_datetime(raw.time).max().date() - timedelta(days=7)
        url, cols, chunk = _weather_source(kind)
        # The observed archive only has days up to ~2 days ago; forecasts reach into the future
        last = min(end, date.today() - timedelta(days=2)) if kind == "observed" else end
        frames = [raw]
        for s in SITES:
            try:
                frames.append(_open_meteo(url, s, cols, chunk, first=first, last=last))
            except RuntimeError as e:   # archive not updated yet for the newest days: keep what we have
                log(f"  {kind} weather {s}: {e}")
        merged = pd.concat(frames)
        # Keep the newest non-missing copy of each site-hour
        merged["_n"] = merged.drop(columns=["site", "time"]).notna().sum(axis=1)
        merged = merged.sort_values("_n").drop_duplicates(["site", "time"], keep="last").drop(columns="_n")
        merged.sort_values(["site", "time"]).to_csv(path, index=False)
        log(f"  {kind} weather updated through {pd.to_datetime(merged.time).max()}")


def set_window(end):
    """Rolling window: the 3 years ending at `end` (exclusive). Used by the daily retrain."""
    global START, END
    END = end
    START = end - timedelta(days=3 * 365)


# ---------------------------------------------------------------- cleaning

def clean_prices(raw, notes):
    df = raw[raw.LMP_TYPE == "LMP"].copy()
    notes["prices: rows downloaded (all LMP components)"] = len(raw)
    notes["prices: kept total LMP rows"] = len(df)
    df["time"] = pd.to_datetime(df.INTERVALSTARTTIME_GMT, utc=True)
    dup = int(df.duplicated("time").sum())
    df = df.drop_duplicates("time").rename(columns={"MW": "price"})[["time", "price"]]  # OASIS labels the value "MW"
    notes["prices: duplicate hours removed"] = dup
    full = pd.date_range(pd.Timestamp(START, tz=TZ).tz_convert("UTC"), pd.Timestamp(END, tz=TZ).tz_convert("UTC"),
                         freq="h", inclusive="left")
    df = df.set_index("time").reindex(full)
    missing = int(df.price.isna().sum())
    notes["prices: hours missing after reindexing to a full hourly clock"] = missing
    # Short gaps (≤ 3 h) interpolated in time; longer gaps left missing and their days dropped later
    df["price_filled"] = df.price.interpolate(limit=3, limit_area="inside")
    notes["prices: short gaps (≤3 h) interpolated"] = int((df.price.isna() & df.price_filled.notna()).sum())
    df["price"] = df.pop("price_filled")
    notes["prices: negative-price hours (kept: real market outcome)"] = int((df.price < 0).sum())
    q = df.price.quantile([0.001, 0.999])
    notes["prices: extreme hours beyond 0.1/99.9 percentile (kept, flagged)"] = int(((df.price < q.iloc[0]) | (df.price > q.iloc[1])).sum())
    return df.rename_axis("time").reset_index()


def _check_ranges(df, notes, label):
    for v, (lo, hi) in PLAUSIBLE.items():
        cols = [c for c in df.columns if v in c]
        vals = df[cols]
        bad = (vals < lo) | (vals > hi)
        notes[f"{label}: {v} values outside {lo}–{hi} set to missing"] = int(bad.sum().sum())
        df[cols] = vals.mask(bad)
    return df


def clean_weather(raw, kind, notes):
    """Wide table: one row per UTC hour, columns site_var[_leadK]. Radiation re-aligned to the price interval."""
    df = raw.copy()
    df["time"] = pd.to_datetime(df.time, utc=True)
    dup = int(df.duplicated(["site", "time"]).sum())
    df = df.drop_duplicates(["site", "time"])
    notes[f"{kind}: duplicate site-hours removed"] = dup
    value_cols = [c for c in df.columns if c not in ("site", "time")]
    wide = df.pivot(index="time", columns="site", values=value_cols)
    wide.columns = [f"{site}_{col}" for col, site in wide.columns]
    # Open-Meteo radiation is the mean over the PRECEDING hour (value at 13:00 covers 12:00–13:00), while a CAISO
    # price at 12:00 covers 12:00–13:00. Shift radiation back one hour so both describe the same interval.
    rad = [c for c in wide.columns if "shortwave_radiation" in c]
    wide[rad] = wide[rad].shift(-1)
    notes[f"{kind}: radiation shifted −1 h to match the price interval (columns)"] = len(rad)
    wide = _check_ranges(wide, notes, kind)
    # Night-time radiation should be ~0; tiny positive values are model noise
    notes[f"{kind}: missing values (share of all cells)"] = round(float(wide.isna().mean().mean()), 4)
    return wide.rename(columns=lambda c: c.replace("_previous_day", "_lead")).rename_axis("time").reset_index()


def build(log=print):
    """Download (cached) + clean. Returns (prices, observed, forecast) and writes data/clean/*."""
    notes = {}
    prices = clean_prices(download_prices(log), notes)
    obs = clean_weather(download_weather("observed", log), "observed", notes)
    fc = clean_weather(download_weather("forecast", log), "forecast", notes)
    # Keep complete local days only (DST days have 23/25 hours; days with long price gaps are dropped)
    prices["local"] = prices.time.dt.tz_convert(TZ)
    prices["date"] = prices.local.dt.date
    counts = prices.groupby("date").price.apply(lambda s: (len(s), s.notna().sum()))
    ok = {d for d, (n, k) in counts.items() if n == 24 and k == 24}
    notes["days: total"] = len(counts)
    notes["days: dropped (DST change days)"] = int(sum(1 for d, (n, k) in counts.items() if n != 24))
    notes["days: dropped (missing prices after interpolation)"] = int(sum(1 for d, (n, k) in counts.items() if n == 24 and k < 24))
    prices = prices[prices.date.isin(ok)].drop(columns="local")
    notes["days: kept"] = len(ok)
    CLEAN.mkdir(parents=True, exist_ok=True)
    obs.to_pickle(CLEAN / "weather_observed.pkl"); fc.to_pickle(CLEAN / "weather_forecast.pkl")
    prices.to_pickle(CLEAN / "prices.pkl")
    (CLEAN / "cleaning_log.json").write_text(json.dumps(notes, indent=1, default=str))
    log(json.dumps(notes, indent=1, default=str))
    return prices, obs, fc


def load():
    """Cleaned tables (run build() first)."""
    return (pd.read_pickle(CLEAN / "prices.pkl"), pd.read_pickle(CLEAN / "weather_observed.pkl"),
            pd.read_pickle(CLEAN / "weather_forecast.pkl"), json.loads((CLEAN / "cleaning_log.json").read_text()))


if __name__ == "__main__":
    build()
