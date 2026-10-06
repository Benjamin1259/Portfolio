"""Train the chosen model on all data and export it for the Chrome extension (extension/model.json).

Model (chosen in 03_level_fix, tuned in 04_tuning; recent-price inputs added in 06_recent_prices):
    blend = w1·(per-hour lasso) + w2·(LightGBM) + w3·(day-curve neural net, 3 seeds)
    price = blend − shift          (shift: the blend's average gap to a latest-year level model; one constant)
All three members are trained on archived forecasts (1, 3, 5 days ahead) for 3 years, older years at 30% weight.

Everything the extension needs is exported as plain numbers: lasso weights, LightGBM trees, network weights,
feature layout, typical weather for dates past the 16-day forecast, the last weeks of actual hourly prices (inputs
for the recent-price features, and shown in place of a prediction for days CAISO has published), and validation stats for the footer.

    python3 train_extension_model.py      # ~1 min
"""

import json
import math
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
import lightgbm  # noqa: F401,E402  (macOS: LightGBM's OpenMP must load before torch's)
import torch  # noqa: E402

import pipeline as pl  # noqa: E402
import recent_prices as rp  # noqa: E402
import search as se  # noqa: E402
import tune_ensemble as te  # noqa: E402

torch.set_num_threads(1)
ROOT = Path(__file__).parent
OUT = ROOT / "extension" / "model.json"
SIG = 6  # significant digits kept in the export
RECENT_DAYS = 60  # days of actual prices exported for the recent-price features
# Held-out test results for this model design (the 06_recent_prices experiment, 3 days ahead), shown in the footer:
# share of the possible savings a 2-hour run captured vs starting at 6pm, and the hourly MAE in $/MWh
VALIDATION = {"2": {"captured_model": 0.969263}, "mae_3d": 5.36752}


def r(x):
    """Round to SIG significant digits (keeps the file small, error ~1e-6 relative)."""
    if isinstance(x, (list, tuple, np.ndarray)):
        return [r(v) for v in x]
    x = float(x)
    return 0.0 if x == 0 or not math.isfinite(x) else float(f"{x:.{SIG}g}")


def export_lasso(perhour):
    return [{"intercept": r(m.intercept_), "coef": r(m.coef_)} for _, m in sorted(perhour.m_.items())]


def export_lgbm(glob):
    booster = glob.m_.booster_
    dump = booster.dump_model()

    def node(n):
        if "leaf_value" in n:
            return {"v": r(n["leaf_value"])}
        assert n["decision_type"] == "<=", n["decision_type"]
        # Thresholds keep full precision: an input sitting exactly on a rounded threshold would take the wrong branch
        return {"f": n["split_feature"], "t": float(n["threshold"]), "d": bool(n["default_left"]),
                "l": node(n["left_child"]), "r": node(n["right_child"])}
    return {"features": dump["feature_names"], "trees": [node(t["tree_structure"]) for t in dump["tree_info"]]}


def export_net(net, cols):
    daily = [c for c in cols if c.endswith("_day") or c.startswith(("doy", "dow", "holiday"))]
    hourly = [c for c in cols if c not in daily]
    seeds = []
    for n in net.nets_:
        layers = [m for m in n if isinstance(m, torch.nn.Linear)]
        seeds.append([{"W": [r(row) for row in L.weight.detach().numpy()], "b": r(L.bias.detach().numpy())} for L in layers])
    return {"daily": daily, "hourly": hourly, "mu": r(net.mu_), "sd": r(net.sd_), "ymu": r(net.ymu_), "ysd": r(net.ysd_),
            "activation": "gelu_erf", "seeds": seeds}


def climatology():
    """Typical weather by day of year and local hour (smoothed ±7 days), radiation already interval-aligned."""
    _, obs, _, _ = pl.load()
    w = obs.copy()
    w["local"] = pd.to_datetime(w.time, utc=True).dt.tz_convert(pl.TZ)
    w["doy"], w["hour"] = w.local.dt.dayofyear.clip(upper=365), w.local.dt.hour
    out = {}
    for role, (var, sites) in pl.ROLES.items():
        for s in sites:
            grid = w.groupby(["doy", "hour"])[f"{s}_{var}"].mean().unstack()
            padded = pd.concat([grid.iloc[-7:], grid, grid.iloc[:7]])
            out[f"{s}_{var}"] = padded.rolling(15, center=True, min_periods=1).mean().iloc[7:-7].round(1).values.tolist()
    return out


def fit(D, through=None):
    """Fit the tuned ensemble on rows up to `through` (inclusive; None = all) and compute the level shift.

    The latest 365 days up to `through` are "recent": full weight, and the level model trains on them. Older rows
    weigh 30%, as in the search.
    """
    p = te.load()["folds"]["final"]["params"]
    dates = D.f.date.to_numpy()
    through = through or dates.max()
    upto = dates <= through
    recent = upto & (dates > through - pd.Timedelta(days=365).to_pytimedelta())
    D.f["fold"] = np.where(recent, 0, -1)          # production: fold ≥ 0 just marks "recent"
    D.f["weight"] = np.where(recent, 1.0, se.OLD_WEIGHT)
    model = te.Tuned(D, p, upto, seeds=3)
    # The shift: blend's average daily level minus the latest-year level model's, over recent days (3-day forecasts)
    blend = pd.Series(model.raw(recent, 3))
    shift = float(np.nanmean(blend.groupby(dates[recent]).transform("mean").to_numpy() - model.level(recent, 3)))
    return model, shift, p, through


def recent_prices(D, through):
    """Hourly actual prices for the last RECENT_DAYS days through `through`, exactly as the lag features see them
    (every calendar day, gaps filled from the day before)."""
    t = rp.daily_table(D.f)
    t = t[t.index <= pd.Timestamp(through)].tail(RECENT_DAYS)
    return {str(d.date()): [round(float(v), 3) for v in row] for d, row in zip(t.index, t.to_numpy())}


def published_days(D, through):
    """Days in recent_prices that CAISO actually published (not gap days filled in from the day before). The apps
    show these real prices instead of a prediction."""
    days = sorted({d for d in D.f.date.unique() if d <= pd.Timestamp(through).date()})[-RECENT_DAYS:]
    return [str(d) for d in days]


def build_json(D, model, shift, p, through):
    lasso, lgbm, net = model.models
    sites = {s: {"lat": la, "lon": lo, "roles": [role for role, (_, ss) in pl.ROLES.items() if s in ss]}
             for s, (la, lo, _) in pl.SITES.items()}
    return {
        "model": "Ensemble: per-hour lasso + LightGBM + day-curve net, level-shifted (04_tuning final settings)",
        "version": 3,
        "features": D.cols,
        "sites": sites,
        "radiation_shift_hours": -1,
        "weights": r(model.w),
        "shift": r(shift),
        "lasso": export_lasso(lasso),
        "lgbm": export_lgbm(lgbm),
        "net": export_net(net, D.cols),
        "holidays": [str(h.date()) for h in pl.HOLIDAYS],
        "recent_prices": recent_prices(D, through),
        "published": published_days(D, through),
        "lag_max_gap": rp.MAX_GAP,
        "climatology": climatology(),
        "trained_on": f"{D.f.date.min()} to {through}",
        "trained_through": str(through),
        "retrained_at": datetime.now().astimezone().isoformat(timespec="seconds"),   # shown in the panel header
        "params": {k: r(v) if isinstance(v, float) else v for k, v in p.items()},
        "validation": VALIDATION,
    }


def write(D, model, shift, p, through, path=OUT):
    out = build_json(D, model, shift, p, through)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    tmp.replace(path)   # atomic: the extension never reads a half-written file
    print(f"Wrote {path} ({path.stat().st_size / 1024:.0f} KB): trained through {through}, "
          f"{len(out['lgbm']['trees'])} trees, shift {shift:+.2f} $/MWh")


def main():
    D = rp.PriceData()
    model, shift, p, through = fit(D)
    write(D, model, shift, p, through)
    return model, shift


if __name__ == "__main__":
    main()
