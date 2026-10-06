"""Fix the level bias found in 02_model_search, then score every model on the full success metrics.

The problem: models trained with the older years (30% weight) predict $2–4/MWh too high, because prices fell each
year and nothing in the weather explains that. The fix keeps each model's within-day SHAPE (which older years help
with) and replaces its daily LEVEL with a level model trained on the latest year only:

    Fix A "replace level":  fixed = model prediction − its daily mean + level model's daily mean
    Fix B "shift":          fixed = model prediction − c, where c (one number per model, fold and lead) is the
                            average gap between the model's daily means and the level model's on those days.
                            Keeps the model's own day-to-day ups and downs; only the overall offset moves.
                            c uses predictions only, never actual prices, so computing it on test days is fair.

Level-model candidates (daily-mean price, trained only on the test year's *training* weeks):
    recent average     the average daily price of the training weeks (baseline)
    daily ridge        ridge regression on the day's calendar + weather summaries
    recent hourly lasso  per-hour lasso on recent rows only, averaged over the day
Each outer fold picks one by inner CV (3 folds of its training weeks, MAE of the daily mean, 3-day-ahead forecasts).
The 16 models' predictions come from data/search/results.pkl, so they don't need refitting.

    python3 level_fix.py        # ~3 min
Results cached in data/search/level_fix.pkl for 03_level_fix.ipynb.
"""

import pickle
import warnings

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import Lasso, Ridge
from sklearn.metrics import precision_recall_fscore_support

import search as se

warnings.filterwarnings("ignore")
OUT = se.OUT / "level_fix.pkl"


# ================================================================ level models

def _daily_cols(cols):
    return [c for c in cols if c.endswith("_day") or c.startswith(("doy", "dow", "holiday"))]


def _daily_rows(D, mask, leads):
    """One row per (day, lead) with daily features and the day's mean price; only complete days."""
    dcols = _daily_cols(D.cols)
    parts = []
    for k in leads:
        X = D.X[k][mask].assign(_date=D.f.date[mask].to_numpy(), _y=D.f.price[mask].to_numpy())
        X = X.dropna()
        g = X.groupby("_date")
        full = g.size() == 24
        day = g[dcols + ["_y"]].mean()[full]
        parts.append(day)
    out = pd.concat(parts)
    return out[dcols], out["_y"].to_numpy()


class RecentAverage:
    def fit(self, Xd, yd): self.m_ = float(np.mean(yd)); return self
    def predict_daily(self, Xd): return np.full(len(Xd), self.m_)


class DailyRidge:
    def __init__(self, alpha): self.alpha = alpha
    def fit(self, Xd, yd): self.m_ = Ridge(alpha=self.alpha).fit(Xd, yd); return self
    def predict_daily(self, Xd): return self.m_.predict(Xd)


class RecentHourlyLasso:
    """Needs hourly rows; handled separately in _fit_level."""
    def __init__(self, alpha): self.alpha = alpha


LEVEL_CANDIDATES = {
    "recent average": [{}],
    "daily ridge": [{"alpha": a} for a in (0.1, 1, 10, 100)],
    "recent hourly lasso": [{"alpha": a} for a in (0.003, 0.01, 0.03, 0.1)],
}


def _fit_level(D, name, params, mask):
    """Returns a function lead -> daily-mean prediction per row of a given row mask."""
    if name == "recent hourly lasso":
        X, y, h, d, w = D.train_rows(mask, recent_only=True)
        models = {hh: Lasso(alpha=params["alpha"], max_iter=20000).fit(X[h == hh], y[h == hh]) for hh in range(24)}

        def predict(rows, lead):
            Xr = D.X[lead][rows]; ok = Xr.notna().all(axis=1).to_numpy(); hr = D.f.hour.to_numpy()[rows]
            p = np.full(rows.sum(), np.nan)
            for hh, m in models.items():
                sel = ok & (hr == hh)
                if sel.any():
                    p[sel] = m.predict(Xr[sel])
            return pd.Series(p).groupby(D.f.date.to_numpy()[rows]).transform("mean").to_numpy()
        return predict

    recent = mask & (D.f.fold >= 0).to_numpy()
    Xd, yd = _daily_rows(D, recent, se.TRAIN_LEADS)
    m = (RecentAverage() if name == "recent average" else DailyRidge(**params)).fit(Xd, yd)
    dcols = _daily_cols(D.cols)

    def predict(rows, lead):
        Xr = D.X[lead][rows][dcols]; ok = Xr.notna().all(axis=1).to_numpy()
        p = np.full(rows.sum(), np.nan)
        if ok.any():
            p[ok] = m.predict_daily(Xr[ok])
        return pd.Series(p).groupby(D.f.date.to_numpy()[rows]).transform("mean").to_numpy()
    return predict


def _level_mae(D, rows, pred):
    y = pd.Series(D.f.price.to_numpy()[rows]).groupby(D.f.date.to_numpy()[rows]).mean()
    p = pd.Series(pred).groupby(D.f.date.to_numpy()[rows]).mean()
    return float((y - p).abs().mean())


def level_predictions(D, log=print):
    """Out-of-fold daily-level predictions for every test row and lead, with the level model chosen per fold."""
    test = (D.f.fold >= 0).to_numpy()
    pos = np.flatnonzero(test)
    out = {L: np.full(test.sum(), np.nan) for L in se.SCORE_LEADS}
    choice = []
    for k in range(5):
        te = (D.f.fold == k).to_numpy(); tr = ~te
        scores = {}
        for name, grid in LEVEL_CANDIDATES.items():
            for params in grid:
                errs = []
                for itr, iva in se._inner(D, tr, seed=100 + k):
                    fn = _fit_level(D, name, params, itr)
                    errs.append(_level_mae(D, iva, fn(iva, se.TUNE_LEAD)))
                scores[(name, tuple(params.items()))] = np.nanmean(errs)
        (name, p), score = min(scores.items(), key=lambda kv: kv[1])
        choice.append({"fold": k, "level model": name, "settings": dict(p), "inner level MAE": score,
                       **{f"{n} {dict(pp)}": s for (n, pp), s in scores.items()}})
        fn = _fit_level(D, name, dict(p), tr)
        where = np.searchsorted(pos, np.flatnonzero(te))
        for L in out:
            out[L][where] = fn(te, L)
        log(f"  fold {k}: {name} {dict(p)} (inner level MAE {score:.2f})")
    return out, pd.DataFrame(choice)


def apply_fix(meta, pred, level):
    """Model's shape + level model's daily mean."""
    p = pd.Series(pred)
    return (p - p.groupby(meta.date.to_numpy()).transform("mean") + level).to_numpy()


def apply_shift(meta, pred, level):
    """Fix B: remove the model's average offset from the level model, fold by fold."""
    p = pd.Series(pred); d = meta.date.to_numpy()
    gap = (p.groupby(d).transform("mean") - level)
    out = p.copy()
    for k in np.unique(meta.fold):
        sel = (meta.fold == k).to_numpy()
        out[sel] = p[sel] - np.nanmean(gap[sel])
    return out.to_numpy()


# ================================================================ full success metrics

def _tercile(p):
    r = np.argsort(np.argsort(p)); return np.where(r < 8, "cheap", np.where(r < 16, "normal", "expensive"))


def _threshold(p, t=5.0):
    m = np.median(p); return np.where(p <= m - t, "cheap", np.where(p >= m + t, "expensive", "normal"))


def full_metrics(meta, y, pred):
    """Every success metric for one prediction array (complete days only)."""
    df = pd.DataFrame({"d": meta.date.to_numpy(), "h": meta.hour.to_numpy(), "y": y, "p": pred}).dropna()
    df = df[df.groupby("d").h.transform("count") == 24]
    e = df.p - df.y
    ym, pm = df.groupby("d").y.transform("mean"), df.groupby("d").p.transform("mean")
    m = {("Accuracy", "MAE ($/MWh)"): e.abs().mean(), ("Accuracy", "RMSE ($/MWh)"): np.sqrt((e ** 2).mean()),
         ("Accuracy", "Median abs error"): e.abs().median(), ("Accuracy", "Bias (pred − actual)"): e.mean(),
         ("Accuracy", "R²"): 1 - (e ** 2).sum() / ((df.y - df.y.mean()) ** 2).sum(),
         ("Accuracy", "Level MAE (day average)"): (df.groupby("d").y.mean() - df.groupby("d").p.mean()).abs().mean(),
         ("Accuracy", "Shape MAE (within day)"): ((df.y - ym) - (df.p - pm)).abs().mean()}
    rank, cost_err = [], []
    runs = {n: {k: [] for k in ("regret", "exact", "pm1", "top3", "near", "cap")} for n in se.RUNS}
    lab = {"t": ([], []), "h": ([], [])}
    for _, g in df.groupby("d"):
        g = g.sort_values("h"); a, q = g.y.to_numpy(), g.p.to_numpy()
        rank.append(spearmanr(a, q).statistic)
        cost_err.append(np.abs(se._windows(q, 2) - se._windows(a, 2)).mean())
        for n in se.RUNS:
            aw, qw = se._windows(a, n), se._windows(q, n); pick, best = qw.argmin(), aw.argmin(); r = runs[n]
            r["regret"].append(aw[pick] - aw[best]); r["exact"].append(pick == best); r["pm1"].append(abs(pick - best) <= 1)
            r["top3"].append(pick in np.argsort(aw)[:3]); r["near"].append(aw[pick] - aw[best] <= 1.0)
            r["cap"].append((aw[min(18, 24 - n)], aw[pick], aw[best]))
        lab["t"][0].extend(_tercile(a)); lab["t"][1].extend(_tercile(q))
        lab["h"][0].extend(_threshold(a)); lab["h"][1].extend(_threshold(q))
    m[("Accuracy", "Within-day rank corr.")] = float(np.nanmean(rank))
    m[("Accuracy", "¢ error per dishwasher run")] = np.mean(cost_err) * se.DISHWASHER_KWH / 10
    for n in se.RUNS:
        r = runs[n]; habit, chosen, best = map(np.mean, zip(*r["cap"])); sec = f"Start time, {n} h run"
        m.update({(sec, "Money lost ($/MWh)"): np.mean(r["regret"]), (sec, "¢ lost per 1.1 kWh run"): np.mean(r["regret"]) * 0.11,
                  (sec, "Savings captured vs 6pm"): (habit - chosen) / (habit - best), (sec, "Near-best (≤ $1/MWh)"): np.mean(r["near"]),
                  (sec, "Exact hit"): np.mean(r["exact"]), (sec, "Within ±1 h"): np.mean(r["pm1"]), (sec, "In actual top 3"): np.mean(r["top3"])})
    m[("Start time, all runs", "Mean money lost ($/MWh)")] = np.mean([np.mean(runs[n]["regret"]) for n in se.RUNS])
    for key, sec in [("t", "Hour class by rank (8/8/8)"), ("h", "Hour class ±$5 of day median")]:
        yt, yp = np.array(lab[key][0]), np.array(lab[key][1])
        pr, rc, f1, _ = precision_recall_fscore_support(yt, yp, labels=["cheap", "normal", "expensive"], zero_division=0)
        m[(sec, "Accuracy")] = np.mean(yt == yp)
        for i, c in enumerate(["cheap", "normal", "expensive"]):
            m[(sec, f"{c} precision")], m[(sec, f"{c} recall")], m[(sec, f"{c} F1")] = pr[i], rc[i], f1[i]
        m[(sec, "cheap called expensive")] = np.mean(yp[yt == "cheap"] == "expensive")
        m[(sec, "expensive called cheap")] = np.mean(yp[yt == "expensive"] == "cheap")
    return m


PCT = ("Savings", "Near-best", "Exact", "Within ±1", "top 3", "Accuracy", "precision", "recall", "F1", "called", "hit", "R²",
       "rank corr")


def full_table(meta, y, preds_by_model, lead):
    rows = {}
    for name, P in preds_by_model.items():
        m = full_metrics(meta, y, P[lead])
        cd = se.cheapest_day(meta, y, P)
        m[("Next 7 days", "Cheapest day hit")] = cd["Cheapest day hit"]
        m[("Next 7 days", "Money lost when wrong ($/MWh)")] = cd["Cheapest day money lost"]
        rows[name] = m
    t = pd.DataFrame(rows).T
    t.columns = pd.MultiIndex.from_tuples(t.columns)
    return t


# ================================================================ run

def run(log=print):
    R = se.load_results()
    D = se.Data()
    level, choice = level_predictions(D, log)
    meta, y = R["meta"], R["y"]
    fixes = {"replace": {name: {L: apply_fix(meta, P[L], level[L]) for L in se.SCORE_LEADS} for name, P in R["preds"].items()},
             "shift": {name: {L: apply_shift(meta, P[L], level[L]) for L in se.SCORE_LEADS} for name, P in R["preds"].items()}}
    tables = {}
    for L in se.REPORT_LEADS:
        tables[("before", L)] = full_table(meta, y, R["preds"], L)
        for fx_name, preds in fixes.items():
            tables[(fx_name, L)] = full_table(meta, y, preds, L)
        log(f"  scored lead {L}")
    res = {"level": level, "level_choice": choice, "fixes": fixes, "tables": tables, "meta": meta, "y": y,
           "tiers": R["results"]["Tier"].to_dict(), "browser": R["results"]["Runs in browser"].to_dict()}
    OUT.write_bytes(pickle.dumps(res))
    return res


def load():
    return pickle.loads(OUT.read_bytes())


if __name__ == "__main__":
    r = run()
    t = r["tables"][("shift", 3)]
    pd.set_option("display.width", 250)
    print(t[[("Accuracy", "MAE ($/MWh)"), ("Accuracy", "Bias (pred − actual)"), ("Accuracy", "Level MAE (day average)"),
             ("Accuracy", "Shape MAE (within day)"), ("Start time, all runs", "Mean money lost ($/MWh)"),
             ("Next 7 days", "Cheapest day hit")]].sort_values(("Accuracy", "MAE ($/MWh)")).round(3).to_string())
