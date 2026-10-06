"""Model search for the hourly price model.

Primary metric: accuracy of predicted hourly prices on FORECAST weather (what the app has), 1, 3 and 7 days ahead.
Reported alongside it: accuracy split into day LEVEL and within-day SHAPE, error in ¢ per appliance run, and a
guardrail (money lost per pick) that isn't tuned on.

Design (same for every model):
  * Test weeks: the last year (Sep 2025 – Sep 2026) split into 5 folds of whole weeks. Older years are only trained on.
  * Training rows: archived forecasts from 1, 3 and 5 days ahead, stacked, so models learn how far to trust a
    forecast. Older years weigh 30% (models that can't weight rows, k-NN, use the last year only).
  * Tuning: inner 3-fold week split of the training weeks, scored by MAE on 3-day-ahead forecasts. Outer test weeks
    are never used for tuning.

    python3 search.py            # ~30 min, candidates run in parallel
Results cached in data/search/results.pkl for 02_model_search.ipynb.
"""

import itertools
import pickle
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from multiprocessing import get_context
from pathlib import Path

import numpy as np
import pandas as pd

import pipeline as pl

warnings.filterwarnings("ignore")
OUT = pl.ROOT / "data" / "search"
EVAL_START = pl.date(2025, 9, 21)
TRAIN_LEADS = (1, 3, 5)
SCORE_LEADS = tuple(range(0, 8))       # predictions kept for these leads (0–6 feed the 7-day pick)
REPORT_LEADS = (1, 3, 7)
TUNE_LEAD = 3
OLD_WEIGHT = 0.3
RUNS = (1, 2, 4)                       # appliance run lengths for the guardrail
DISHWASHER_KWH = 1.1


# ================================================================ data + features

def frame():
    """Price rows with local time, calendar fields and CV folds."""
    prices, _, _, _ = pl.load()
    f = prices.copy()
    f["local"] = f.time.dt.tz_convert(pl.TZ)
    f["hour"], f["month"] = f.local.dt.hour, f.local.dt.month
    wk = f.local.dt.strftime("%G-%V")
    recent = (f.date >= EVAL_START).to_numpy()
    weeks = wk[recent].unique()
    fold_of = dict(zip(weeks, np.random.default_rng(0).integers(0, 5, len(weeks))))
    f["fold"] = np.where(recent, wk.map(fold_of).fillna(-1), -1).astype(int)
    f["week"] = wk
    f["weight"] = np.where(recent, 1.0, OLD_WEIGHT)
    return f.reset_index(drop=True)


def weather(f, source, lead=0):
    """Weather aligned to price rows: observed, or the forecast issued `lead` days earlier. Columns site_var."""
    _, obs, fc, _ = pl.load()
    w = obs if source == "observed" else fc
    suf = "" if (source == "observed" or lead == 0) else f"_lead{lead}"
    cols = {f"{s}_{v}{suf}": f"{s}_{v}" for s in pl.SITES for v in pl.VARS}
    w = w[["time"] + list(cols)].rename(columns=cols)
    return f[["time"]].merge(w, on="time", how="left").drop(columns="time")


def features(f, w):
    """Model inputs: calendar + each site's hourly value and daily summary for its role (solar/heat/wind)."""
    t = f.local
    X = pd.DataFrame(index=f.index)
    a = t.dt.dayofyear / 365.25 * 2 * np.pi
    X["doy_sin"], X["doy_cos"], X["doy_sin2"], X["doy_cos2"] = np.sin(a), np.cos(a), np.sin(2 * a), np.cos(2 * a)
    for k in range(7):
        X[f"dow{k}"] = (t.dt.dayofweek == k).astype(float)
    X["holiday"] = pd.to_datetime(f.date).isin(pl.HOLIDAYS).astype(float).to_numpy()
    day = f.date.to_numpy()
    for role, (var, sites) in pl.ROLES.items():
        for s in sites:
            col = w[f"{s}_{var}"]
            if role == "solar":
                X[f"{s}_rad"] = col.to_numpy() / 1000
                X[f"{s}_rad_day"] = col.groupby(day).transform("sum").to_numpy() / 10000
            elif role == "heat":
                X[f"{s}_temp"] = col.to_numpy() / 100
                X[f"{s}_tmax_day"] = col.groupby(day).transform("max").to_numpy() / 100
            else:
                X[f"{s}_wind"] = col.to_numpy() / 50
                X[f"{s}_wind_day"] = col.groupby(day).transform("mean").to_numpy() / 50
    return X


class Data:
    """Everything a search worker needs, built once per process."""
    def __init__(self):
        self.f = frame()
        self.X = {k: features(self.f, weather(self.f, "forecast", k)) for k in SCORE_LEADS}
        self.X["observed"] = features(self.f, weather(self.f, "observed"))
        self.cols = list(self.X[0].columns)

    def train_rows(self, mask, recent_only=False):
        """Stack training leads; drop rows with missing forecasts. Returns X, y, hour, date, weight."""
        parts = []
        for k in TRAIN_LEADS:
            m = (mask & (self.f.fold >= 0).to_numpy()) if recent_only else mask
            X = self.X[k][m]; ok = X.notna().all(axis=1).to_numpy()
            fr = self.f[m][ok]
            parts.append((X[ok], fr.price.to_numpy(), fr.hour.to_numpy(), fr.date.to_numpy(), fr.weight.to_numpy()))
        return tuple(pd.concat([p[0] for p in parts]).reset_index(drop=True) if i == 0 else np.concatenate([p[i] for p in parts])
                     for i in range(5))


# ================================================================ model wrappers
# fit(X, y, hour, date, weight) / predict(X, hour, date). X holds only feature columns.

def _fit_weighted(est, X, y, w):
    from sklearn.pipeline import Pipeline
    if isinstance(est, Pipeline):
        return est.fit(X, y, **{f"{est.steps[-1][0]}__sample_weight": w})
    return est.fit(X, y, sample_weight=w)


class HourMean:
    def __init__(self, by_month=False): self.by_month = by_month
    def fit(self, X, y, hour, date, w):
        key = self._key(hour, date)
        s = pd.DataFrame({"k": key, "yw": y * w, "w": w}).groupby("k").sum()
        self.t_ = (s.yw / s.w).to_dict()
        h = pd.DataFrame({"h": hour, "yw": y * w, "w": w}).groupby("h").sum(); self.h_ = (h.yw / h.w).to_dict()
        return self
    def _key(self, hour, date):
        return list(zip(pd.to_datetime(date).month, hour)) if self.by_month else list(hour)
    def predict(self, X, hour, date):
        return np.array([self.t_.get(k, self.h_[h]) for k, h in zip(self._key(hour, date), hour)])


class PerHour:
    def __init__(self, make): self.make = make
    def fit(self, X, y, hour, date, w):
        self.m_ = {h: _fit_weighted(self.make(), X[hour == h], y[hour == h], w[hour == h]) for h in range(24)}
        return self
    def predict(self, X, hour, date):
        out = np.empty(len(X))
        for h, m in self.m_.items():
            sel = hour == h
            if sel.any():
                out[sel] = m.predict(X[sel])
        return out


def _with_hour(X, hour, onehot):
    G = X.copy()
    a = hour / 24 * 2 * np.pi
    G["hour_sin"], G["hour_cos"] = np.sin(a), np.cos(a)
    if onehot:
        for h in range(24):
            G[f"h{h}"] = (hour == h).astype(float)
    else:
        G["hour"] = hour
    return G


class Global:
    def __init__(self, make, onehot=False, weighted=True): self.make, self.onehot, self.weighted = make, onehot, weighted
    def fit(self, X, y, hour, date, w):
        est = self.make(); G = _with_hour(X, hour, self.onehot)
        self.m_ = _fit_weighted(est, G, y, w) if self.weighted else est.fit(G, y)
        return self
    def predict(self, X, hour, date): return self.m_.predict(_with_hour(X, hour, self.onehot))


class DayCurveNet:
    """PyTorch MLP: a whole day's inputs (calendar + 24 h of every weather series) → all 24 hourly prices."""
    def __init__(self, hidden=128, depth=2, dropout=0.2, weight_decay=1e-2, lr=3e-3, epochs=300, seeds=3):
        self.hidden, self.depth, self.dropout, self.weight_decay = hidden, depth, dropout, weight_decay
        self.lr, self.epochs, self.seeds = lr, epochs, seeds

    @staticmethod
    def _days(X, hour, date, y=None, w=None):
        df = X.assign(_h=hour, _d=date, _i=np.arange(len(X)))
        daily = [c for c in X.columns if c.endswith("_day") or c.startswith(("doy", "dow", "holiday"))]
        hourly = [c for c in X.columns if c not in daily]
        rows, keys, Ys, Ws = [], [], [], []
        # A date can appear once per training lead; group on (date, block) where block = which stacked copy
        df["_blk"] = df.groupby(["_d", "_h"]).cumcount()
        for (d, b), g in df.groupby(["_d", "_blk"], sort=False):
            if len(g) != 24:
                continue
            g = g.sort_values("_h")
            rows.append(np.concatenate([g[daily].iloc[0].to_numpy(), g[hourly].to_numpy().T.ravel()]))
            keys.append(g._i.to_numpy())
            if y is not None:
                Ys.append(y[g._i.to_numpy()]); Ws.append(w[g._i.to_numpy()][0])
        return np.array(rows, np.float32), keys, (np.array(Ys, np.float32) if Ys else None), np.array(Ws, np.float32)

    def fit(self, X, y, hour, date, w):
        import torch
        torch.set_num_threads(1)
        F, _, Y, W = self._days(X, hour, date, y, w)
        self.mu_, self.sd_ = F.mean(0), F.std(0) + 1e-6
        self.ymu_, self.ysd_ = float(Y.mean()), float(Y.std())
        Ft = torch.tensor((F - self.mu_) / self.sd_); Yt = torch.tensor((Y - self.ymu_) / self.ysd_); Wt = torch.tensor(W)
        self.nets_ = []
        for seed in range(self.seeds):
            torch.manual_seed(seed)
            layers, width = [], F.shape[1]
            for _ in range(self.depth):
                layers += [torch.nn.Linear(width, self.hidden), torch.nn.GELU(), torch.nn.Dropout(self.dropout)]; width = self.hidden
            net = torch.nn.Sequential(*layers, torch.nn.Linear(width, 24))
            opt = torch.optim.AdamW(net.parameters(), lr=self.lr, weight_decay=self.weight_decay)
            sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, self.epochs)
            g = torch.Generator().manual_seed(seed)
            for _ in range(self.epochs):
                net.train()
                for idx in torch.randperm(len(Ft), generator=g).split(64):
                    opt.zero_grad()
                    loss = (torch.nn.functional.smooth_l1_loss(net(Ft[idx]), Yt[idx], reduction="none").mean(1) * Wt[idx]).mean()
                    loss.backward(); opt.step()
                sched.step()
            net.eval(); self.nets_.append(net)
        return self

    def predict(self, X, hour, date):
        import torch
        F, keys, _, _ = self._days(X, hour, date)
        out = np.full(len(X), np.nan)
        if not len(F):
            return out
        with torch.no_grad():
            P = np.mean([n(torch.tensor((F - self.mu_) / self.sd_)).numpy() for n in self.nets_], 0) * self.ysd_ + self.ymu_
        for p, idx in zip(P, keys):
            out[idx] = p
        return out


# ================================================================ candidates

@dataclass
class Candidate:
    name: str
    tier: str
    make: callable
    grid: dict = field(default_factory=dict)
    browser: str = "yes"        # can the extension run it as-is?
    recent_only: bool = False


def _sk(cls, **kw):
    return lambda: cls(**kw)


def candidates():
    from sklearn.linear_model import LinearRegression, Ridge, Lasso
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler, PolynomialFeatures
    from sklearn.neighbors import KNeighborsRegressor
    from sklearn.tree import DecisionTreeRegressor
    from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor, HistGradientBoostingRegressor
    from sklearn.neural_network import MLPRegressor
    from lightgbm import LGBMRegressor
    from xgboost import XGBRegressor
    from catboost import CatBoostRegressor
    return [
        Candidate("Hour-of-day average", "0 Baseline", lambda: HourMean(False)),
        Candidate("Month × hour average", "0 Baseline", lambda: HourMean(True)),
        Candidate("Linear regression (per hour)", "1 Linear", lambda: PerHour(_sk(LinearRegression))),
        Candidate("Ridge (per hour)", "1 Linear", lambda alpha: PerHour(_sk(Ridge, alpha=alpha)), {"alpha": [0.001, 0.01, 0.1, 1, 10, 100]}),
        Candidate("Lasso (per hour)", "1 Linear", lambda alpha: PerHour(_sk(Lasso, alpha=alpha, max_iter=20000)), {"alpha": [0.0003, 0.001, 0.003, 0.01, 0.03, 0.1]}),
        Candidate("Ridge + interactions (per hour)", "1 Linear",
                  lambda alpha: PerHour(lambda: make_pipeline(StandardScaler(), PolynomialFeatures(2, include_bias=False), Ridge(alpha=alpha))),
                  {"alpha": [30, 100, 300, 1000, 3000]}),
        Candidate("k-nearest neighbours", "2 Local / single tree",
                  lambda k: Global(lambda: make_pipeline(StandardScaler(), KNeighborsRegressor(n_neighbors=k, weights="distance")),
                                   onehot=True, weighted=False), {"k": [5, 10, 20, 40]}, "with work", recent_only=True),
        Candidate("Decision tree", "2 Local / single tree",
                  lambda depth, leaf: Global(_sk(DecisionTreeRegressor, max_depth=depth, min_samples_leaf=leaf, random_state=0)),
                  {"depth": [6, 10, 14], "leaf": [20, 80]}),
        Candidate("Random forest", "3 Tree ensembles",
                  lambda mf, leaf: Global(_sk(RandomForestRegressor, n_estimators=200, max_features=mf, min_samples_leaf=leaf,
                                              max_samples=0.5, n_jobs=2, random_state=0)),
                  {"mf": [0.33, 0.66], "leaf": [3, 10]}, "with work"),
        Candidate("Extra trees", "3 Tree ensembles",
                  lambda mf, leaf: Global(_sk(ExtraTreesRegressor, n_estimators=200, max_features=mf, min_samples_leaf=leaf,
                                              max_samples=0.5, bootstrap=True, n_jobs=2, random_state=0)),
                  {"mf": [0.33, 0.66], "leaf": [3, 10]}, "with work"),
        Candidate("Histogram gradient boosting", "3 Tree ensembles",
                  lambda lr, leaves: Global(_sk(HistGradientBoostingRegressor, max_iter=500, learning_rate=lr, max_leaf_nodes=leaves,
                                                l2_regularization=1.0, random_state=0)),
                  {"lr": [0.03, 0.1], "leaves": [15, 63]}, "with work"),
        Candidate("LightGBM", "3 Tree ensembles",
                  lambda lr, leaves, mcs: Global(_sk(LGBMRegressor, n_estimators=600, learning_rate=lr, num_leaves=leaves,
                                                     min_child_samples=mcs, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                                                     verbose=-1, n_jobs=2, random_state=0)),
                  {"lr": [0.01, 0.02], "leaves": [7, 15], "mcs": [80, 200]}, "with work"),
        Candidate("XGBoost", "3 Tree ensembles",
                  lambda lr, depth: Global(_sk(XGBRegressor, n_estimators=600, learning_rate=lr, max_depth=depth, subsample=0.8,
                                               colsample_bytree=0.8, n_jobs=2, random_state=0)),
                  {"lr": [0.02, 0.06], "depth": [4, 7]}, "with work"),
        Candidate("CatBoost", "3 Tree ensembles",
                  lambda lr, depth: Global(_sk(CatBoostRegressor, iterations=800, learning_rate=lr, depth=depth, verbose=0,
                                               thread_count=2, random_seed=0)),
                  {"lr": [0.05, 0.1], "depth": [4, 6]}, "with work"),
        Candidate("Neural net (MLP, all hours)", "4 Neural",
                  lambda hidden, alpha: Global(lambda: make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=hidden, alpha=alpha,
                                                                    early_stopping=True, max_iter=400, random_state=0)), onehot=True),
                  {"hidden": [(64, 64), (128, 64)], "alpha": [1e-3, 1e-1]}, "with work"),
        Candidate("Day-curve neural net (PyTorch)", "4 Neural",
                  lambda hidden, wd: DayCurveNet(hidden=hidden, weight_decay=wd),
                  {"hidden": [64, 128], "wd": [1e-3, 3e-2]}, "with work"),
    ]


ENSEMBLE = ("Ensemble (lasso + LightGBM + day-curve net)", ["Lasso (per hour)", "LightGBM", "Day-curve neural net (PyTorch)"])


# ================================================================ metrics

def _windows(p, n):
    c = np.cumsum(np.insert(p, 0, 0.0)); return (c[n:] - c[:-n]) / n


def accuracy(meta, y, p):
    """Headline accuracy, level/shape split, ¢ per appliance run, and the money-lost guardrail."""
    df = pd.DataFrame({"d": meta.date.to_numpy(), "h": meta.hour.to_numpy(), "y": y, "p": p}).dropna()
    df = df[df.groupby("d").h.transform("count") == 24]
    e = df.p - df.y
    ym, pm = df.groupby("d").y.transform("mean"), df.groupby("d").p.transform("mean")
    out = {"MAE": e.abs().mean(), "RMSE": np.sqrt((e ** 2).mean()), "Bias": e.mean(),
           "R2": 1 - (e ** 2).sum() / ((df.y - df.y.mean()) ** 2).sum(),
           "Level MAE": (df.groupby("d").y.mean() - df.groupby("d").p.mean()).abs().mean(),
           "Shape MAE": ((df.y - ym) - (df.p - pm)).abs().mean()}
    cost_err, reg = [], {n: [] for n in RUNS}
    for _, g in df.groupby("d"):
        g = g.sort_values("h"); a, q = g.y.to_numpy(), g.p.to_numpy()
        cost_err.append(np.abs(_windows(q, 2) - _windows(a, 2)).mean())
        for n in RUNS:
            aw, qw = _windows(a, n), _windows(q, n); reg[n].append(aw[qw.argmin()] - aw.min())
    out["¢ error per dishwasher run"] = np.mean(cost_err) * DISHWASHER_KWH / 10
    out["Money lost per pick"] = np.mean([np.mean(reg[n]) for n in RUNS])
    return out


def cheapest_day(meta, y, preds):
    """Next-7-days pick as the app makes it: day k of the window uses the lead-k forecast."""
    d = pd.DataFrame({"d": meta.date.to_numpy(), "h": meta.hour.to_numpy(), "y": y, **{f"p{k}": preds[k] for k in range(7)}})
    act, pr = {}, {}
    for day, g in d.groupby("d"):
        if len(g) != 24: continue
        g = g.sort_values("h"); act[day] = _windows(g.y.to_numpy(), 2).min()
        pr[day] = [(_windows(g[f"p{k}"].to_numpy(), 2).min() if g[f"p{k}"].notna().all() else np.nan) for k in range(7)]
    days = sorted(act); hits, regs = [], []
    for i in range(len(days) - 6):
        w = days[i:i + 7]
        if (pd.Timestamp(w[-1]) - pd.Timestamp(w[0])).days != 6: continue
        a = np.array([act[x] for x in w]); p = np.array([pr[x][k] for k, x in enumerate(w)])
        if np.isnan(p).any(): continue
        hits.append(p.argmin() == a.argmin()); regs.append(a[p.argmin()] - a.min())
    return {"Cheapest day hit": np.mean(hits), "Cheapest day money lost": np.mean(regs)}


# ================================================================ search

def _grid(g):
    return [dict(zip(g, v)) for v in itertools.product(*g.values())] or [{}]


def _inner(D, train_mask, seed):
    """3 validation folds of whole weeks from the recent training weeks; older years always train."""
    recent = train_mask & (D.f.fold >= 0).to_numpy()
    weeks = D.f.week[recent].unique()
    assign = dict(zip(weeks, np.random.default_rng(seed).integers(0, 3, len(weeks))))
    f = np.where(recent, D.f.week.map(assign).fillna(-1), -1).astype(int)
    return [(train_mask & (f != j), f == j) for j in range(3)]


def _fit(cand, params, D, mask):
    X, y, h, d, w = D.train_rows(mask, recent_only=cand.recent_only)
    return cand.make(**params).fit(X, y, h, d, w)


def _predict(model, D, rows, lead):
    X = D.X[lead][rows]; fr = D.f[rows]
    ok = X.notna().all(axis=1).to_numpy()
    out = np.full(rows.sum(), np.nan)
    if ok.any():
        out[ok] = model.predict(X[ok].reset_index(drop=True), fr.hour.to_numpy()[ok], fr.date.to_numpy()[ok])
    return out


def run_candidate(name):
    import lightgbm  # noqa: F401  (OpenMP load order on macOS: LightGBM before torch)
    import torch; torch.set_num_threads(1)
    cand = {c.name: c for c in candidates()}[name]
    D = Data()
    test_rows = (D.f.fold >= 0).to_numpy()
    preds = {k: np.full(test_rows.sum(), np.nan) for k in list(SCORE_LEADS) + ["observed"]}
    pos = np.flatnonzero(test_rows)
    chosen, t0 = [], time.time()
    for k in range(5):
        test = (D.f.fold == k).to_numpy(); train = ~test
        combos = _grid(cand.grid)
        if len(combos) > 1:
            scores = {}
            for p in combos:
                errs = []
                for tr, va in _inner(D, train, seed=100 + k):
                    m = _fit(cand, p, D, tr)
                    pv = _predict(m, D, va, TUNE_LEAD)
                    errs.append(np.nanmean(np.abs(pv - D.f.price.to_numpy()[va])))
                scores[tuple(p.items())] = np.mean(errs)
            best = dict(min(scores, key=scores.get))
        else:
            best = combos[0]
        chosen.append(best)
        m = _fit(cand, best, D, train)
        where = np.searchsorted(pos, np.flatnonzero(test))
        for L in preds:
            preds[L][where] = _predict(m, D, test, L)
    return name, preds, chosen, time.time() - t0


def run(workers=6, log=print):
    OUT.mkdir(parents=True, exist_ok=True)
    cands = candidates()
    D = Data()
    meta = D.f[D.f.fold >= 0][["time", "date", "hour", "fold"]].reset_index(drop=True)
    y = D.f.price[D.f.fold >= 0].to_numpy()
    preds, params, secs = {}, {}, {}
    # Slowest first so the pool stays busy
    order = sorted(cands, key=lambda c: ("neural" not in c.tier.lower(), "Tree" not in c.tier, c.name))
    with ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn")) as pool:
        for name, p, ch, s in pool.map(run_candidate, [c.name for c in order]):
            preds[name], params[name], secs[name] = p, ch, s
            log(f"  {name}: {s / 60:.1f} min, settings per fold {ch}")
    ens_name, members = ENSEMBLE
    preds[ens_name] = {L: np.mean([preds[m][L] for m in members], axis=0) for L in preds[members[0]]}
    secs[ens_name] = sum(secs[m] for m in members)
    info = {c.name: c for c in cands}
    rows = []
    for name, P in preds.items():
        c = info.get(name)
        row = {"Model": name, "Tier": c.tier if c else "5 Ensemble", "Runs in browser": c.browser if c else "with work",
               "Fit time (min)": secs[name] / 60}
        row.update({f"{k} (observed wx)": v for k, v in accuracy(meta, y, P["observed"]).items() if k in ("MAE",)})
        for L in REPORT_LEADS:
            row.update({f"{k} {L}d": v for k, v in accuracy(meta, y, P[L]).items()})
        row.update(cheapest_day(meta, y, P))
        rows.append(row)
    res = {"results": pd.DataFrame(rows).set_index("Model"), "preds": preds, "params": params, "meta": meta, "y": y,
           "features": D.cols, "n_train_rows": int(sum(len(D.X[k]) for k in TRAIN_LEADS))}
    (OUT / "results.pkl").write_bytes(pickle.dumps(res))
    return res


def load_results():
    return pickle.loads((OUT / "results.pkl").read_bytes())


if __name__ == "__main__":
    only = sys.argv[1:]  # optional: candidate names to smoke-test
    if only:
        y = Data().f.query("fold >= 0").price.to_numpy()
        for n in only:
            name, p, ch, s = run_candidate(n); print(n, f"{s:.0f}s", ch, "MAE 3d", round(float(np.nanmean(np.abs(p[3] - y))), 3))
    else:
        r = run()
        pd.set_option("display.width", 250)
        print(r["results"].round(3).to_string())
