# Credit Card Fraud Detection

Detecting fraudulent transactions in a severely imbalanced dataset of 284,807 real credit card transactions from European cardholders, using the [Credit Card Fraud Detection dataset](https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud) (Worldline / Machine Learning Group, Université Libre de Bruxelles).

## The core challenge

Only 492 of 284,807 transactions (0.17%) are fraudulent — a ratio of roughly 1 fraud case per 578 legitimate ones. This imbalance drives every major methodological decision in this project:

- **Accuracy and ROC-AUC are misleading here.** A model that predicts "not fraud" every time is already 99.83% accurate while catching zero fraud, and ROC-AUC is inflated by the huge number of easy true negatives. **PR-AUC** is used as the primary metric instead.
- **The default 0.50 classification threshold doesn't apply.** An explicit threshold sweep (0.00–1.00) finds the actual operating points that trade off precision against recall for this rare-event problem.
- **Model and resampling strategy were both tested, not assumed.** Five model families (Logistic Regression, Random Forest, XGBoost, LightGBM, CatBoost) were each compared with and without SMOTE resampling before selecting a champion.

## Approach

- **Feature engineering**: log-transformed `Amount` to correct extreme right-skew (skewness 17 → 0.16), derived `Hour_Of_Day` from `Time`, and engineered a `V14 × V17` interaction term — `V14` and `V17` are individually the two strongest correlated (anonymized, PCA-transformed) features with fraud, and their product correlates far more strongly (0.54) than either alone.
- **Leakage discipline**: all correlation-based feature selection is computed on the training split only, after the train/test split — never on the full dataset.
- **Model selection**: benchmarked 5 models × 2 resampling strategies (10 configurations) by PR-AUC on held-out test data.
- **Hyperparameter tuning**: `GridSearchCV` on the champion model, scored on PR-AUC.
- **Threshold selection**: swept the full 0–1 probability range to find F1-optimal and F2-optimal (recall-weighted) operating points.

## Results

| Model | SMOTE | PR-AUC | ROC-AUC |
|---|---|---|---|
| **CatBoost** | No | **0.8769** | 0.9764 |
| Random Forest | Yes | 0.8697 | 0.9653 |
| Random Forest | No | 0.8689 | 0.9533 |
| XGBoost | Yes | 0.8524 | 0.9773 |
| CatBoost | Yes | 0.8431 | 0.9793 |

**Champion: CatBoost** (`depth=8, iterations=100, learning_rate=0.1`), trained without SMOTE.

- Test PR-AUC: **0.8748**
- **F1-max** (threshold 0.25): 93% precision, 84% recall — 82 of 98 fraud cases caught, only 10 false alarms out of 56,864 legitimate transactions
- **F2-max** (threshold ~0.13–0.15): recall-weighted operating point catching more fraud at a modest precision cost

Top predictive features: `V4`, `V1`, `V14`, `V12`, `V20` — all anonymized PCA components with no real-world interpretation, plus the engineered `V14_V17_Interaction` and `Amount` both contributing meaningfully despite weak *linear* correlation with the target (a reminder that correlation-based feature screening only catches linear relationships — tree-based models can exploit nonlinear signal that correlation alone misses).

## Files

- [`fraud_pipeline.py`](fraud_pipeline.py) — full pipeline as a script
- [`fraud_pipeline.ipynb`](fraud_pipeline.ipynb) — same pipeline as a notebook, with all plots
- `creditcard.csv.gz` — the dataset, gzip-compressed (144MB → 65MB) to stay under GitHub's file size limit; `pandas.read_csv` reads it directly, no manual extraction needed
- `*.png` — generated plots (amount distribution, correlation matrix, threshold sweep, confusion matrices, feature importance)

## Running it

```bash
pip install pandas numpy matplotlib scikit-learn imbalanced-learn xgboost lightgbm catboost
python fraud_pipeline.py
```
