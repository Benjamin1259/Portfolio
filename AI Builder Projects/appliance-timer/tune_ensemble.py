"""Tune the chosen model: ensemble of per-hour lasso + LightGBM + day-curve net, with the level shift fix.

Everything is searched together with Optuna (Bayesian, TPE):
  lasso alpha · 7 LightGBM settings · 6 day-curve-net settings · 3 blend weights · level-model alpha
Objective: hourly MAE after the shift fix, on 3-day-ahead forecasts, averaged over 3 inner folds of whole weeks.
Weak trials are stopped after their first inner fold (median pruning).

Nested: each outer fold (held-out test weeks) runs its own search on its training weeks only, then the best settings
are refit and scored on the test weeks. A 6th process runs the same search on all data to get the settings to ship.

    python3 tune_ensemble.py      # ~30–40 min on 6 processes
Results: data/search/tune_ensemble.pkl, for 04_tuning.ipynb.
"""

import pickle
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
N_TRIALS = 40
OUT_NAME = "tune_ensemble.pkl"

# Settings the ensemble had in the model search (most common per-fold choices), used as trial 0
START = {"lasso_alpha": 3e-4,  # (search floor 1e-4: smaller penalties make lasso very slow and add nothing)
         "lgb_trees": 600, "lgb_lr": 0.01, "lgb_leaves": 7, "lgb_min_child": 80,
         "lgb_subsample": 0.8, "lgb_colsample": 0.8, "lgb_l2": 1e-3, "net_hidden": 64, "net_depth": 2,
         "net_dropout": 0.2, "net_wd": 0.03, "net_lr": 3e-3, "net_epochs": 300,
         "w_lasso": 1.0, "w_lgbm": 1.0, "w_net": 1.0, "level_alpha": 0.01}


def suggest(trial):
    return {
        "lasso_alpha": trial.suggest_float("lasso_alpha", 1e-4, 0.1, log=True),
        "lgb_trees": trial.suggest_int("lgb_trees", 200, 1500, log=True),
        "lgb_lr": trial.suggest_float("lgb_lr", 0.003, 0.1, log=True),
        "lgb_leaves": trial.suggest_int("lgb_leaves", 4, 63, log=True),
        "lgb_min_child": trial.suggest_int("lgb_min_child", 20, 500, log=True),
        "lgb_subsample": trial.suggest_float("lgb_subsample", 0.5, 1.0),
        "lgb_colsample": trial.suggest_float("lgb_colsample", 0.3, 1.0),
        "lgb_l2": trial.suggest_float("lgb_l2", 1e-3, 30, log=True),
        "net_hidden": trial.suggest_categorical("net_hidden", [32, 64, 128, 256]),
        "net_depth": trial.suggest_int("net_depth", 1, 3),
        "net_dropout": trial.suggest_float("net_dropout", 0.0, 0.5),
        "net_wd": trial.suggest_float("net_wd", 1e-4, 0.3, log=True),
        "net_lr": trial.suggest_float("net_lr", 3e-4, 1e-2, log=True),
        "net_epochs": trial.suggest_int("net_epochs", 100, 400, step=50),
        "w_lasso": trial.suggest_float("w_lasso", 0.0, 1.0),
        "w_lgbm": trial.suggest_float("w_lgbm", 0.0, 1.0),
        "w_net": trial.suggest_float("w_net", 0.0, 1.0),
        "level_alpha": trial.suggest_float("level_alpha", 1e-3, 0.3, log=True),
    }


def weights(p):
    w = np.array([p["w_lasso"], p["w_lgbm"], p["w_net"]]) + 1e-9
    return w / w.sum()


def members(p, seeds):
    import search as se
    from lightgbm import LGBMRegressor
    from sklearn.linear_model import Lasso
    return [
        se.PerHour(se._sk(Lasso, alpha=p["lasso_alpha"], max_iter=20000)),
        se.Global(se._sk(LGBMRegressor, n_estimators=p["lgb_trees"], learning_rate=p["lgb_lr"], num_leaves=p["lgb_leaves"],
                         min_child_samples=p["lgb_min_child"], subsample=p["lgb_subsample"], subsample_freq=1,
                         colsample_bytree=p["lgb_colsample"], reg_lambda=p["lgb_l2"], verbose=-1, n_jobs=2, random_state=0)),
        se.DayCurveNet(hidden=p["net_hidden"], depth=p["net_depth"], dropout=p["net_dropout"], weight_decay=p["net_wd"],
                       lr=p["net_lr"], epochs=p["net_epochs"], seeds=seeds),
    ]


class Tuned:
    """The fitted ensemble + level model; predicts shift-fixed prices for any rows and lead."""
    def __init__(self, D, p, train_mask, seeds):
        import search as se, level_fix as lf
        X, y, h, d, w = D.train_rows(train_mask)
        self.D, self.w = D, weights(p)
        self.models = [m.fit(X, y, h, d, w) for m in members(p, seeds)]
        self.level = lf._fit_level(D, "recent hourly lasso", {"alpha": p["level_alpha"]}, train_mask)

    def raw(self, rows, lead):
        import search as se
        return sum(wi * se._predict(m, self.D, rows, lead) for wi, m in zip(self.w, self.models))

    def predict(self, rows, lead):
        """Blend, then shift so its average daily level matches the level model on these rows."""
        p = pd.Series(self.raw(rows, lead)); dates = self.D.f.date.to_numpy()[rows]
        lvl = self.level(rows, lead)
        gap = np.nanmean(p.groupby(dates).transform("mean").to_numpy() - lvl)
        return (p - gap).to_numpy()


def search_fold(D, train_mask, seed, n_trials=N_TRIALS):
    import optuna, search as se
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    folds = se._inner(D, train_mask, seed)
    y = D.f.price.to_numpy()

    def objective(trial):
        p = suggest(trial); errs = []
        for j, (tr, va) in enumerate(folds):
            m = Tuned(D, p, tr, seeds=1)
            errs.append(float(np.nanmean(np.abs(m.predict(va, se.TUNE_LEAD) - y[va]))))
            trial.report(float(np.mean(errs)), j)
            if trial.should_prune():
                raise optuna.TrialPruned()
        return float(np.mean(errs))

    study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=seed, multivariate=True),
                                pruner=optuna.pruners.MedianPruner(n_startup_trials=8, n_warmup_steps=0))
    study.enqueue_trial(START)
    study.optimize(objective, n_trials=n_trials)
    return study


def outer_fold(k):
    import lightgbm  # noqa: F401  (macOS: LightGBM's OpenMP must load before torch's)
    import torch; torch.set_num_threads(1)
    import search as se
    D = se.Data()
    t0 = time.time()
    if k == "final":    # settings to ship: search on all data (inner folds over the whole test year)
        study = search_fold(D, np.ones(len(D.f), bool), seed=7)
        return k, None, study.best_params, study.trials_dataframe(attrs=("number", "value", "state", "params")), time.time() - t0
    test = (D.f.fold == k).to_numpy(); train = ~test
    study = search_fold(D, train, seed=100 + k)
    m = Tuned(D, study.best_params, train, seeds=3)
    preds = {L: m.predict(test, L) for L in se.SCORE_LEADS}
    return k, preds, study.best_params, study.trials_dataframe(attrs=("number", "value", "state", "params")), time.time() - t0


def run(log=print):
    import search as se
    D = se.Data()
    test = (D.f.fold >= 0).to_numpy(); pos = np.flatnonzero(test)
    preds = {L: np.full(test.sum(), np.nan) for L in se.SCORE_LEADS}
    folds = {}
    with ProcessPoolExecutor(max_workers=6, mp_context=get_context("spawn")) as pool:
        for k, pk, best, trials, secs in pool.map(outer_fold, [0, 1, 2, 3, 4, "final"]):
            folds[k] = {"params": best, "trials": trials, "secs": secs}
            if pk is not None:
                where = np.searchsorted(pos, np.flatnonzero((D.f.fold == k).to_numpy()))
                for L in preds:
                    preds[L][where] = pk[L]
            log(f"  {'final (all data)' if k == 'final' else f'outer fold {k}'}: {secs / 60:.1f} min, "
                f"{(trials.state == 'COMPLETE').sum()} complete / {(trials.state == 'PRUNED').sum()} pruned, best inner MAE {trials.value.min():.3f}")
    res = {"preds": preds, "folds": folds, "start": START}
    (se.OUT / OUT_NAME).write_bytes(pickle.dumps(res))
    return res


def load():
    import search as se
    return pickle.loads((se.OUT / OUT_NAME).read_bytes())


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "smoke":
        N_TRIALS = 2
        import search as se
        k, pk, best, trials, secs = outer_fold(0)
        print(f"smoke: {secs:.0f}s for 2 trials + refit; best {best}; MAE 3d {np.nanmean(np.abs(pk[3] - se.Data().f.query('fold == 0').price.to_numpy())):.3f}")
    else:
        run()
