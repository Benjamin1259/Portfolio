"""Recent-price inputs (lag features) for the price model.

A prediction for day d made k days ahead may only use prices already published when it's made. CAISO publishes a
day's prices around 1pm the day before, so a forecast made on day d−k knows prices through d−k (before 1pm) or
d−k+1 (after). To be safe and never use the target day itself, the newest price day used is

    L = d − max(k, 1)      (k = 0 and 1: yesterday; k = 3: three days before; ...)

If day L is missing, the latest day before it is used (the app does the same if the daily job missed a day).

Features (price in $/MWh ÷ 100):
    lagmean_day     average price on day L
    lagmean7_day    average over the 7 days ending L
    lag_hour        price at the same hour on day L (the day's shape)
    laggap_day      how old day L is: max(k, 1) ÷ 7, capped at 1

The extension computes the same four features in JavaScript (lagFeatures() in extension/core.js).
"""

import pandas as pd

import search as se

COLS = ["lagmean_day", "lagmean7_day", "lag_hour", "laggap_day"]
MAX_GAP = 7


def gap(lead):
    return max(lead, 1)


def daily_table(f):
    """Hourly prices as a date × hour table over every calendar day, missing days filled from the day before."""
    t = f.pivot_table(index="date", columns="hour", values="price")
    t.index = pd.to_datetime(t.index)
    t = t.reindex(pd.date_range(t.index.min(), t.index.max(), freq="D")).ffill()
    return t


def lag_features(f, lead, table=None):
    """The four lag columns for every price row, for predictions made `lead` days ahead."""
    t = daily_table(f) if table is None else table
    g = gap(lead)
    day = (pd.to_datetime(f.date) - pd.Timedelta(days=g)).clip(lower=t.index.min(), upper=t.index.max())
    rows = t.index.get_indexer(day)
    mean = t.mean(axis=1).to_numpy()
    mean7 = pd.Series(mean).rolling(7, min_periods=1).mean().to_numpy()
    X = pd.DataFrame(index=f.index)
    X["lagmean_day"] = mean[rows] / 100
    X["lagmean7_day"] = mean7[rows] / 100
    X["lag_hour"] = t.to_numpy()[rows, f.hour.to_numpy()] / 100
    X["laggap_day"] = min(g, MAX_GAP) / MAX_GAP
    return X


class PriceData(se.Data):
    """se.Data plus lag columns at every lead (and for "observed", the 1-day-ahead version)."""
    def __init__(self, base=None):
        base = base or se.Data()
        self.f, table = base.f, daily_table(base.f)
        self.X = {k: pd.concat([Xk, lag_features(self.f, 1 if k == "observed" else k, table)], axis=1)
                  for k, Xk in base.X.items()}
        self.cols = list(self.X[0].columns)
        self.base_cols = base.cols
