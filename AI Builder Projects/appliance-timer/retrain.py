"""Daily retrain: grade the current model on newly published prices, then retrain it.

Run daily after CAISO publishes the next day's day-ahead prices (~1pm Pacific); launchd runs it at 2:15pm.

    1. Update data   new CAISO prices, observed weather and archived forecasts; rolling 3-year window
    2. Grade         for each newly published day, the CURRENT model (trained before that day's prices existed)
                     predicts it from the forecast issued the day before. Predicted and actual hourly prices are
                     saved to extension/scores.json, which the "How the model is doing" card reads.
    3. Retrain       refit the ensemble with the tuned settings through the newest day; write extension/model.json
    4. Publish       copy model.json and scores.json to ~/Library/Application Support/Appliance Timer for the Mac app

First run (no saved model): backfills the last 7 days honestly, training a model through the day before each one.

    python3 retrain.py            # daily run
    python3 retrain.py --status   # show what's been trained and graded
    python3 retrain.py --rebuild  # retrain and publish now, no grading (after changing the model's inputs)
Log: data/retrain.log (when run by launchd).
"""

import json
import pickle
import shutil
import sys
import time
import traceback
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

import lightgbm  # noqa: F401  (macOS: LightGBM's OpenMP must load before torch's)
import torch

import pipeline as pl
import recent_prices as rp
import search as se
import train_extension_model as tx

torch.set_num_threads(1)
STATE_DIR = pl.ROOT / "data" / "model"
STATE = STATE_DIR / "state.json"
FROZEN = STATE_DIR / "current.pkl"
SCORES = pl.ROOT / "extension" / "scores.json"
MAC_APP = pl.Path.home() / "Library" / "Application Support" / "Appliance Timer"   # the menu bar app reads these
KEEP_DAYS = 90
BACKFILL_DAYS = 7
GRADE_LEADS = (1, 2, 3)    # forecast issued 1 day before; older issues only if that's missing


def log(*a):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


class Frozen:
    """A trained ensemble without the data it was built from: small enough to save, enough to predict."""
    def __init__(self, model, shift, through, cols):
        self.members, self.weights, self.shift, self.through = model.models, model.w, shift, through
        self.cols = cols                # the inputs it was trained on (older saved models: the 28 weather columns)
        for m in self.members:          # the "make a fresh estimator" recipes are lambdas: not needed to predict,
            if hasattr(m, "make"):      # and they can't be pickled
                m.make = None

    def predict(self, X, hour, day):
        return sum(w * m.predict(X, hour, day) for w, m in zip(self.weights, self.members)) - self.shift


def prepare(through):
    """Update raw data and rebuild the cleaned tables + features for the 3 years ending `through`."""
    end = through + timedelta(days=1)
    pl.set_window(end)
    se.EVAL_START = through - timedelta(days=364)
    pl.build(log=lambda *a: None)
    return rp.PriceData()


def newest_published():
    """Latest local date with all 24 prices in the raw CAISO file."""
    raw = pd.read_csv(pl.RAW / "caiso_dam_lmp.csv")
    raw = raw[raw.LMP_TYPE == "LMP"]
    t = pd.to_datetime(raw.INTERVALSTARTTIME_GMT, utc=True).dt.tz_convert(pl.TZ)
    counts = t.dt.date.value_counts()
    return max(d for d, n in counts.items() if n >= 23)   # 23: spring-forward day


def grade(frozen, D, day):
    """One-day-ahead prediction for `day` by `frozen`, next to CAISO's actual prices."""
    rows = (D.f.date == day).to_numpy()
    if rows.sum() != 24:
        return None
    order = np.argsort(D.f.hour.to_numpy()[rows])
    cols = getattr(frozen, "cols", D.base_cols)
    for lead in GRADE_LEADS:
        X = D.X[lead][rows][cols]
        if X.notna().all().all():
            fr = D.f[rows]
            pred = frozen.predict(X.reset_index(drop=True), fr.hour.to_numpy(), fr.date.to_numpy())[order]
            actual = fr.price.to_numpy()[order]
            return {"date": str(day), "predicted": [round(float(v), 3) for v in pred],
                    "actual": [round(float(v), 3) for v in actual], "forecast_issued_days_before": lead,
                    "model_trained_through": str(frozen.through),
                    "mae": round(float(np.abs(pred - actual).mean()), 3)}
    return None


def save_scores(new):
    data = json.loads(SCORES.read_text()) if SCORES.exists() else {"days": []}
    by_date = {d["date"]: d for d in data["days"]}
    for d in new:
        by_date[d["date"]] = d
    days = sorted(by_date.values(), key=lambda d: d["date"])[-KEEP_DAYS:]
    tmp = SCORES.with_suffix(".tmp")
    tmp.write_text(json.dumps({"updated": datetime.now().isoformat(timespec="minutes"), "days": days}, separators=(",", ":")))
    tmp.replace(SCORES)


def save_state(frozen, through):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    FROZEN.write_bytes(pickle.dumps(frozen))
    STATE.write_text(json.dumps({"trained_through": str(through), "saved": datetime.now().isoformat(timespec="minutes")}))


def publish():
    """Copy the new model and scores to where the Mac menu bar app reads them (the extension reads extension/)."""
    MAC_APP.mkdir(parents=True, exist_ok=True)
    for f in (tx.OUT, SCORES):
        if f.exists():
            tmp = MAC_APP / (f.name + ".tmp")
            shutil.copyfile(f, tmp)
            tmp.replace(MAC_APP / f.name)


def run():
    t0 = time.time()
    today = datetime.now().date()
    log("updating data")
    pl.update_raw(today + timedelta(days=2), log=lambda *a: log(*a))
    newest = newest_published()
    log(f"newest published day: {newest}")
    state = json.loads(STATE.read_text()) if STATE.exists() else None
    D = prepare(newest)
    graded = []

    if state is None or not FROZEN.exists():
        log(f"first run: backfilling {BACKFILL_DAYS} graded days")
        for k in range(BACKFILL_DAYS, 0, -1):
            day = newest - timedelta(days=k - 1)
            model, shift, _, through = tx.fit(D, day - timedelta(days=1))
            g = grade(Frozen(model, shift, through, D.cols), D, day)
            if g:
                graded.append(g); log(f"  graded {day} with model through {through}: MAE ${g['mae']:.2f}/MWh")
    else:
        trained = date.fromisoformat(state["trained_through"])
        todo = [trained + timedelta(days=i) for i in range(1, (newest - trained).days + 1)]
        if not todo:
            log("no new published days; nothing to do"); return
        frozen = pickle.loads(FROZEN.read_bytes())
        for day in todo:
            g = grade(frozen, D, day)
            if g:
                graded.append(g); log(f"  graded {day} with model through {frozen.through}: MAE ${g['mae']:.2f}/MWh")
            else:
                log(f"  {day}: no archived forecast to grade with; skipped")

    save_scores(graded)
    log(f"retraining through {newest}")
    model, shift, p, through = tx.fit(D, newest)
    tx.write(D, model, shift, p, through)
    save_state(Frozen(model, shift, through, D.cols), through)
    publish()
    log(f"done in {(time.time() - t0) / 60:.1f} min")


def rebuild():
    """Retrain through the newest published day and publish, without grading (e.g. after the model's inputs change)."""
    t0 = time.time()
    D = prepare(newest_published())
    model, shift, p, through = tx.fit(D)
    tx.write(D, model, shift, p, through)
    save_state(Frozen(model, shift, through, D.cols), through)
    publish()
    log(f"rebuilt through {through} in {(time.time() - t0) / 60:.1f} min")


def status():
    st = json.loads(STATE.read_text()) if STATE.exists() else None
    sc = json.loads(SCORES.read_text()) if SCORES.exists() else {"days": []}
    print("trained through:", st["trained_through"] if st else "never")
    for d in sc["days"][-10:]:
        print(f"  {d['date']}: MAE ${d['mae']:.2f}/MWh (model through {d['model_trained_through']}, forecast {d['forecast_issued_days_before']}d before)")


if __name__ == "__main__":
    if "--status" in sys.argv:
        status()
    elif "--rebuild" in sys.argv:
        rebuild()
    else:
        try:
            run()
        except Exception:
            log("FAILED\n" + traceback.format_exc()); sys.exit(1)
