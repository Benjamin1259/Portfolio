# Heart Disease Prediction — A Sex-Disparity Case Study

Predicting heart disease from clinical features using the [Heart Failure Prediction Dataset](https://www.kaggle.com/datasets/fedesoriano/heart-failure-prediction) (918 patients, combined from five clinical databases: Cleveland, Hungary, Switzerland, VA Long Beach, and Stalog). The target is a general presence/absence heart disease label — not type or severity.

## The real finding

This project started as a standard classification pipeline, but the more interesting result turned out to be a data problem, not a modeling problem: **the dataset is heavily skewed by sex — 725 male patients vs. 193 female patients.** That imbalance isn't unique to this dataset; it reflects a well-documented pattern of historical underrepresentation of women in clinical research.

Running the full pipeline separately for the combined population, male patients, and female patients shows the consequence directly:

| Cohort | Precision | Recall |
|---|---|---|
| Male | 0.9175 | 0.9271 |
| Full Dataset | 0.9029 | 0.9118 |
| Female | 0.8000 | 0.6667 |

The model catches roughly 1 in 3 fewer actual disease cases in women than in men. That gap holds up under 5-fold cross-validation (not just one lucky/unlucky test split) — though the female estimate's confidence interval is also considerably wider, a direct symptom of having less than a third as much female data to work with.

## Approach

- **Leakage-safe imputation**: `RestingBP` and `Cholesterol` both contain implausible zero values (physiologically impossible, almost certainly missing data encoded as 0). Fixed by splitting into train/test **first**, then filling zeros using an Age+Sex group-mean lookup built from the training data only.
- **Model selection**: compared five models (Logistic Regression, Random Forest, XGBoost, Gradient Boosting, SVM), selecting the champion by **Recall first, F1 as tiebreaker** — a deliberate choice for a disease-screening context, where missing a real case is worse than a false alarm.
- **Hyperparameter tuning**: `GridSearchCV`, scored on recall to match the champion-selection criterion.
- **Sex-stratified analysis**: ran the entire pipeline independently for the male subset, the female subset, and the full population, using the same leakage-safe imputed/encoded data throughout (no re-imputing on the smaller subsets).
- **Cross-validation**: 5-fold CV per cohort to check whether the observed performance gap is a stable pattern or single-split noise.
- **Counterargument testing**: before concluding separate models were necessary, tested whether a combined (both-sexes) model evaluated on female patients only would actually outperform a dedicated female-only model. At the standard 0.5 threshold, it doesn't — the female-only model has meaningfully better precision at the same recall.
- **Error analysis**: examined the clinical characteristics of False Negatives vs. False Positives to understand *what kind* of patient the model misses, not just how often.

## Results

- **Full-population champion**: Logistic Regression — Recall 0.90, F1 0.88, ROC-AUC 0.92
- **5-fold CV Recall**: Full 0.898 ± 0.021, Male 0.913 ± 0.017, Female 0.780 ± 0.040
- **5-fold CV F1**: Full 0.882 ± 0.011, Male 0.891 ± 0.024, Female 0.680 ± 0.048

The female cohort's wider error bars (2–4x the male cohort's across every metric) mean the exact size of the disparity is uncertain — but its existence, and its direction, is consistent across every fold.

## Conclusion

At a standard 0.5 classification threshold, there's no cheap fix here — a hybrid modeling approach (male-specific model + combined model for women) does not outperform a dedicated female-only model. The underlying problem is data availability, not model architecture: 193 patients isn't enough to reliably train or evaluate a model for. Deploying the best-performing model as-is, without addressing this, would mean deploying something that performs unevenly across a population it's meant to serve equally — not a defensible tradeoff for a health-screening application.

## Files

- [`heart_disease_pipeline.ipynb`](heart_disease_pipeline.ipynb) — full pipeline: imputation, encoding, model selection, tuning, sex-stratified comparison, cross-validation, counterargument testing, and error analysis
- `heart.csv` — the dataset
- `*.png` — generated charts (sex distribution, precision/recall by cohort, cross-validation results, ROC/PR curves, combined-vs-female-only model comparison)

## Running it

```bash
pip install pandas numpy matplotlib seaborn scikit-learn xgboost
jupyter notebook heart_disease_pipeline.ipynb
```
