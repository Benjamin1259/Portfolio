# Ames Housing Price Prediction

Predicting residential sale prices on the [Kaggle House Prices: Advanced Regression Techniques](https://www.kaggle.com/competitions/house-prices-advanced-regression-techniques) dataset (the Ames, Iowa housing dataset — 1,460 training rows, 79 raw features).

## Approach

- **Feature engineering**: mapped `MSSubClass` codes to readable categories, encoded ordinal quality columns (`ExterQual`, `BsmtQual`, `KitchenQual`, etc.) to a 0–5 numeric scale, engineered composite features (`TotalSqf`, `OverallQualScore`, `HouseAge`, `YearsSinceRemodel`, `TotalPorchSF`, etc.), and target-encoded `Neighborhood` using **train-only** means to avoid leakage.
- **Preprocessing**: one-hot encoding for categoricals (fit on train, applied to test), correlation-based feature pruning (dropped 88 columns with `|corr| < 0.05` against the target), and standard scaling — all fit exclusively on the training split.
- **Modeling**: compared 9 regressors (Linear/Ridge/Lasso/ElasticNet, Decision Tree, Random Forest, Gradient Boosting, XGBoost, LightGBM) via 5-fold cross-validated grid search, then did a deeper alpha search for the winner with `LassoCV`.
- **Target**: `SalePrice` was log-transformed (`log1p`) to correct right-skew before training, and predictions are converted back to dollars for evaluation.

## Results

| Model | Test RMSE (log) | Test R² |
|---|---|---|
| **Lasso Regression** | **0.1255** | **0.9156** |
| Linear Regression | 0.1268 | 0.9138 |
| ElasticNet | 0.1276 | 0.9127 |
| Ridge Regression | 0.1280 | 0.9123 |
| XGBoost | 0.1332 | 0.9049 |
| Gradient Boosting | 0.1350 | 0.9024 |
| LightGBM | 0.1382 | 0.8977 |
| Random Forest | 0.1513 | 0.8774 |
| Decision Tree | 0.1838 | 0.8190 |

**Champion: Lasso Regression** (via `LassoCV`, optimal `alpha ≈ 0.00274`)
- Test R² ≈ **0.913**
- Average absolute error: **$15,821.96**
- Mean absolute percentage error (MAPE): **9.23%**
- Zeroed out 85 of 179 engineered features via L1 regularization (built-in feature selection)

Top price drivers (by Lasso coefficient): `GrLivArea`, `OverallQual`, `NeighborhoodEncoded`, `OverallQualScore`, `GarageCars`.

The regularized linear models generalized better than the tree ensembles here — Random Forest/XGBoost/LightGBM fit the training data far more tightly (train RMSE roughly half of the linear models') but didn't out-perform on the held-out test set, likely because most of the strong signal was already captured by the engineered features and one-hot categoricals.

## Files

- [`house_pricing_model.py`](house_pricing_model.py) — full pipeline as a script
- [`house_pricing_model.ipynb`](house_pricing_model.ipynb) — same pipeline as a notebook, with plots (SalePrice distribution before/after log transform, actual-vs-predicted scatter)
- `train.csv` / `test.csv` / `sample_submission.csv` / `data_description.txt` — the Kaggle competition dataset
- `actual_vs_predicted.csv` / `lasso_feature_importance.csv` — generated output from the final model

## Running it

```bash
pip install numpy pandas matplotlib scipy scikit-learn xgboost lightgbm
python house_pricing_model.py
```

(XGBoost/LightGBM are optional — the script degrades gracefully and skips them if not installed.)
