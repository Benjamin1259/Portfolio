#!/usr/bin/env python
# coding: utf-8

# In[1]:


import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from sklearn.base import clone
from sklearn.model_selection import train_test_split, StratifiedKFold, GridSearchCV
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    roc_auc_score,
    average_precision_score,
    precision_score,
    recall_score,
    f1_score,
    fbeta_score,
)
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier
from imblearn.over_sampling import SMOTE
from imblearn.pipeline import Pipeline as ImbPipeline
from scipy.stats import skew
from catboost import CatBoostClassifier


# ## 1. Load data + feature engineering

# In[2]:


df = pd.read_csv('creditcard.csv.gz')  # pandas reads gzip directly, no extraction needed
df.info()


# In[3]:


df.head()


# In[4]:


df['Class'].value_counts(normalize=True) * 100


# In[5]:


df['Time'].value_counts()


# In[6]:


df['Hour_Of_Day'] = (df['Time'] // 3600) % 24
df['Hour_Of_Day'].value_counts()


# In[7]:


df = df.drop(columns=['Time'])


# In[8]:


# Check whether 'Amount' actually needs a log transform


plt.figure(figsize=(10, 6))
plt.hist(df['Amount'], bins=50, color='steelblue', edgecolor='black')
plt.title('Distribution of Transaction Amount (raw)')
plt.xlabel('Amount ($)')
plt.ylabel('Count')
plt.savefig('amount_raw_distribution.png', dpi=150, bbox_inches='tight')
plt.show()

print("=== Amount: raw ===")

print(f"Skewness (raw): {skew(df['Amount']):.3f}")
print(f"Zero-amount rows: {(df['Amount'] == 0).sum()}")


# In[9]:


logged_amount = np.log1p(df['Amount'])
print(f"Skewness (raw): {skew(df['Amount']):.3f}")
print(f"Skewness (log1p): {skew(logged_amount):.3f}")

fig, axes = plt.subplots(1, 2, figsize=(12, 5))
axes[0].hist(df['Amount'], bins=50, color='steelblue', edgecolor='black')
axes[0].set_title('Amount (raw)')
axes[0].set_xlabel('Amount ($)')
axes[0].set_ylabel('Count')
axes[1].hist(logged_amount, bins=50, color='steelblue', edgecolor='black')
axes[1].set_title('Amount (log1p)')
axes[1].set_xlabel('log1p(Amount)')
axes[1].set_ylabel('Count')
plt.tight_layout()
plt.savefig('amount_distribution.png', dpi=150)
plt.show()
print("Saved distribution comparison to amount_distribution.png")



# In[10]:


df['Amount'] = np.log1p(df['Amount'])


# In[11]:


print(f"Skewness (logged): {skew(df['Amount']):.3f}")


# In[12]:


X = df.drop(columns=['Class'])
y = df['Class']

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)


# In[13]:


train_full = X_train.copy()
train_full['Class'] = y_train
corr_matrix = train_full.corr()

plt.figure(figsize=(12, 10))
plt.imshow(corr_matrix, cmap='coolwarm', vmin=-1, vmax=1)
plt.colorbar(label='Correlation')
plt.xticks(range(len(corr_matrix.columns)), corr_matrix.columns, rotation=90)
plt.yticks(range(len(corr_matrix.columns)), corr_matrix.columns)
plt.title('Feature Correlation Matrix (train only)')
plt.tight_layout()
plt.savefig('correlation_matrix.png', dpi=150, bbox_inches='tight')
plt.show()

correlations_train = corr_matrix['Class'].sort_values(ascending=False)
print(correlations_train)


# In[14]:


X_train['V14_V17_Interaction'] = X_train['V14'] * X_train['V17']
X_test['V14_V17_Interaction'] = X_test['V14'] * X_test['V17']

train_full = X_train.copy()
train_full['Class'] = y_train
correlations_train = train_full.corr()['Class'].sort_values(ascending=False)
print(correlations_train)


# In[15]:


WEAK_CORR_THRESHOLD = 0.008
corr_no_target = correlations_train.drop('Class')
weak_signal_series = corr_no_target[corr_no_target.abs() < WEAK_CORR_THRESHOLD].index.tolist()
print(f"\nDropping {len(weak_signal_series)} weak-correlation columns (|corr| < {WEAK_CORR_THRESHOLD}): {weak_signal_series}")

X_train = X_train.drop(weak_signal_series, axis=1)
X_test = X_test.drop(weak_signal_series, axis=1)


# In[16]:


X_train.columns


# ## 2. Model selection (with vs. without SMOTE)

# In[17]:


print("=" * 70)
print("STEP 1: MODEL SELECTION")
print("=" * 70)

models = {
    "Logistic Regression": LogisticRegression(max_iter=1000, random_state=42),
    "Random Forest": RandomForestClassifier(n_estimators=50, max_features='log2', n_jobs=-1, random_state=42),
    "XGBoost": XGBClassifier(n_estimators=50, max_depth=6, n_jobs=-1, random_state=42, eval_metric='logloss'),
    "LightGBM": LGBMClassifier(n_estimators=50, n_jobs=-1, random_state=42, verbose=-1),
    "CatBoost": CatBoostClassifier(iterations=50, random_state=42, verbose=0),
}

sm = SMOTE(random_state=42)
X_train_balanced, y_train_balanced = sm.fit_resample(X_train, y_train)

selection_results = []
for use_smote, train_X, train_y in [
    (False, X_train, y_train),
    (True, X_train_balanced, y_train_balanced),
]:
    for name, model in models.items():
        model.fit(train_X, train_y)
        y_prob = model.predict_proba(X_test)[:, 1]
        y_pred = model.predict(X_test)

        selection_results.append({
            "Model": name,
            "SMOTE": use_smote,
            "PR-AUC": round(average_precision_score(y_test, y_prob), 4),
            "ROC-AUC": round(roc_auc_score(y_test, y_prob), 4),
            "Precision": round(precision_score(y_test, y_pred, zero_division=0), 4),
            "Recall": round(recall_score(y_test, y_pred, zero_division=0), 4),
            "F1": round(f1_score(y_test, y_pred, zero_division=0), 4),
        })

selection_df = pd.DataFrame(selection_results).sort_values("PR-AUC", ascending=False)
print(selection_df.to_string(index=False))

champion_row = selection_df.iloc[0]
CHAMPION_NAME = champion_row["Model"]
CHAMPION_USES_SMOTE = bool(champion_row["SMOTE"])

print(f"\nCHAMPION: {CHAMPION_NAME} (SMOTE={CHAMPION_USES_SMOTE}), PR-AUC={champion_row['PR-AUC']}")


# ## 3. Hyperparameter tuning for the champion

# In[18]:


print("\n" + "="*70)
print("STEP 2: HYPERPARAMETER TUNING")
print("="*70)

base_estimator = clone(models[CHAMPION_NAME])

# Avoid nested parallelism: reset any inner threading param to 1 so
# GridSearchCV's own n_jobs=-1 is the only level of parallelism.
if "n_jobs" in base_estimator.get_params():
    base_estimator.set_params(n_jobs=1)
if "thread_count" in base_estimator.get_params():
    base_estimator.set_params(thread_count=1)

# 2. Define parameter grids for ALL possible champion models
param_grids = {
    "Logistic Regression": {
        "clf__C": [0.01, 0.1, 1, 10, 100],
        "clf__class_weight": [None, "balanced"],
    },
    "Random Forest": {
        "clf__n_estimators": [100, 200],
        "clf__max_depth": [None, 10, 20, 30, 50],
        "clf__min_samples_leaf": [1, 5, 10, 20, 50],
        "clf__max_features": ["log2", "sqrt"],
        "clf__class_weight": ["balanced_subsample", "balanced", None],
    },
    "XGBoost": {
        "clf__n_estimators": [100, 200],
        "clf__max_depth": [3, 6, 10],
        "clf__learning_rate": [0.01, 0.05, 0.1, 0.2],
        "clf__subsample": [0.8, 1.0],
    },
    "LightGBM": {
        "clf__n_estimators": [100, 200],
        "clf__max_depth": [-1, 10, 20],
        "clf__learning_rate": [0.01, 0.05, 0.1, 0.2],
        "clf__num_leaves": [31, 50, 100],
    },
    "CatBoost": {
        "clf__iterations": [100, 200],
        "clf__depth": [4, 6, 8],
        "clf__learning_rate": [0.01, 0.05, 0.1],
    },
}

# 3. Select the correct grid for the winning model
param_grid = param_grids[CHAMPION_NAME]

# 4. Build the pipeline depending on whether SMOTE was needed
if CHAMPION_USES_SMOTE:
    tuning_pipeline = ImbPipeline([
        ("smote", SMOTE(random_state=42)),
        ("clf", base_estimator),
    ])
else:
    tuning_pipeline = ImbPipeline([("clf", base_estimator)])

cv = StratifiedKFold(n_splits=3, shuffle=True, random_state=42)

grid_search = GridSearchCV(
    estimator=tuning_pipeline,
    param_grid=param_grid,
    cv=cv,
    scoring="average_precision",
    n_jobs=-1,
    verbose=2,
)

print(f"Tuning {CHAMPION_NAME} (SMOTE={CHAMPION_USES_SMOTE})...")
grid_search.fit(X_train, y_train)

print(f"\nBest params: {grid_search.best_params_}")
print(f"Best CV PR-AUC: {grid_search.best_score_:.4f}")

tuned_model = grid_search.best_estimator_
test_probs = tuned_model.predict_proba(X_test)[:, 1]


# In[19]:


import numpy as np
from sklearn.metrics import average_precision_score, f1_score, fbeta_score

thresholds = np.arange(0.0, 1.05, 0.05)
best_f1, best_f1_t = -1, None
best_f2, best_f2_t = -1, None
for t in thresholds:
    pred = (test_probs >= t).astype(int)
    f1 = f1_score(y_test, pred, zero_division=0)
    f2 = fbeta_score(y_test, pred, beta=2, zero_division=0)
    if f1 > best_f1:
        best_f1, best_f1_t = f1, t
    if f2 > best_f2:
        best_f2, best_f2_t = f2, t

print(f"PR-AUC (Average Precision): {average_precision_score(y_test, test_probs):.4f}")
print(f"F1-max: {best_f1:.4f} at threshold {best_f1_t:.2f}")
print(f"F2-max: {best_f2:.4f} at threshold {best_f2_t:.2f}")


# In[20]:


print(X_train.shape)
print(sorted(X_train.columns.tolist()))


# In[21]:


print(type(tuned_model).__name__)


# ## 4. Threshold sweep: find best F1 and F2 thresholds

# In[22]:


print("\n" + "=" * 70)
print("STEP 3: THRESHOLD SWEEP")
print("=" * 70)

thresholds = np.arange(0.0, 1.05, 0.01)
sweep_results = []

print(f"{'thresh':>7} | {'precision':>9} | {'recall':>7} | {'f1':>6} | {'f2':>6}")
for t in thresholds:
    pred_t = (test_probs >= t).astype(int)
    p = precision_score(y_test, pred_t, zero_division=0)
    r = recall_score(y_test, pred_t, zero_division=0)
    f1 = f1_score(y_test, pred_t, zero_division=0)
    f2 = fbeta_score(y_test, pred_t, beta=2, zero_division=0)
    sweep_results.append({"threshold": t, "precision": p, "recall": r, "f1": f1, "f2": f2})
    print(f"{t:>7.2f} | {p:>9.3f} | {r:>7.3f} | {f1:>6.3f} | {f2:>6.3f}")

sweep_df = pd.DataFrame(sweep_results)

roc_auc = roc_auc_score(y_test, test_probs)
pr_auc = average_precision_score(y_test, test_probs)


# In[23]:


plt.figure(figsize=(9, 6))
plt.plot(sweep_df['threshold'], sweep_df['precision'], marker='o', markersize=1.5, label='Precision')
plt.plot(sweep_df['threshold'], sweep_df['recall'], marker='o', markersize=1.5, label='Recall')
plt.plot(sweep_df['threshold'], sweep_df['f1'], marker='o', markersize=1.5, label='F1')
plt.axhline(roc_auc, color='gray', linestyle=':', alpha=0.8, label=f'ROC-AUC ({roc_auc:.3f}, threshold-independent)')
plt.axhline(pr_auc, color='black', linestyle=':', alpha=0.8, label=f'PR-AUC ({pr_auc:.3f}, threshold-independent)')
plt.xlabel('Decision Threshold')
plt.ylabel('Score')
plt.title(f'Success Metrics vs Decision Threshold ({CHAMPION_NAME}, tuned)')
plt.xticks(np.arange(0, 1.05, 0.1))
plt.yticks(np.arange(0, 1.05, 0.1))
plt.grid(True, alpha=0.3)

f1_best_idx = sweep_df['f1'].idxmax()
F1_BEST_THRESHOLD = round(sweep_df.loc[f1_best_idx, 'threshold'], 2)

f2_best_idx = sweep_df['f2'].idxmax()
F2_BEST_THRESHOLD = round(sweep_df.loc[f2_best_idx, 'threshold'], 2)

plt.axvline(F1_BEST_THRESHOLD, color='purple', linestyle='--', alpha=0.7,
            label=f'F1 max (balanced) ({F1_BEST_THRESHOLD})')
plt.axvline(F2_BEST_THRESHOLD, color='red', linestyle='--', alpha=0.7,
            label=f'F2 max (recall-weighted) ({F2_BEST_THRESHOLD})')
plt.legend(loc='center left', bbox_to_anchor=(1.02, 0.5), borderaxespad=0)
plt.savefig('threshold_sweep.png', dpi=150, bbox_inches='tight')
plt.show()
print(f"F1-max threshold (balanced): {F1_BEST_THRESHOLD}")
print(f"F2-max threshold (recall-weighted): {F2_BEST_THRESHOLD}")


# ## 5. Full evaluation at F1-max and F2-max thresholds

# In[24]:


def plot_confusion_matrix(y_true, y_pred, threshold, filename):
    cm = confusion_matrix(y_true, y_pred)
    tn, fp, fn, tp = cm[0, 0], cm[0, 1], cm[1, 0], cm[1, 1]

    print(f"True Positives (fraud caught):    {tp}")
    print(f"False Positives (false alarms):   {fp}")
    print(f"False Negatives (fraud missed):   {fn}")
    print(f"True Negatives (legit correct):   {tn}")

    dark_blue = '#3d6e8c'
    light_blue = '#aed4eb'

    fig, ax = plt.subplots(figsize=(5, 4))
    ax.invert_yaxis()
    ax.axis('off')

    cells = [
        (0, 0, tp, dark_blue, None),
        (1, 0, fn, light_blue, 'Type 2 Error'),
        (0, 1, fp, light_blue, 'Type 1 Error'),
        (1, 1, tn, dark_blue, None),
    ]

    for x, y_pos, value, color, error_label in cells:
        ax.add_patch(plt.Rectangle((x, y_pos), 1, 1, facecolor=color, edgecolor='white', linewidth=2))
        ax.text(x + 0.5, y_pos + 0.42, f'{value}', ha='center', va='center',
                fontsize=32, fontweight='bold', color='white')
        if error_label:
            ax.text(x + 0.5, y_pos + 0.68, error_label, ha='center', va='center',
                    fontsize=10, color='white')

    ax.text(1.0, -0.25, f'Predicted Values (threshold={threshold})', ha='center', va='center',
            fontsize=15, color='#333')
    ax.text(0.5, -0.08, 'Fraud', ha='center', va='center', fontsize=11, fontweight='bold')
    ax.text(1.5, -0.08, 'Legit', ha='center', va='center', fontsize=11, fontweight='bold')

    ax.text(-0.35, 1.0, 'Actual Values', ha='center', va='center', fontsize=18,
            color='#333', rotation=90)
    ax.text(-0.12, 0.5, 'Fraud', ha='center', va='center', fontsize=11, fontweight='bold', rotation=90)
    ax.text(-0.12, 1.5, 'Legit', ha='center', va='center', fontsize=11, fontweight='bold', rotation=90)

    ax.set_xlim(-0.6, 2)
    ax.set_ylim(2, -0.5)

    plt.tight_layout()
    plt.savefig(filename, dpi=150, bbox_inches='tight')
    plt.show()
    print(f"Saved confusion matrix visual to {filename}")


def evaluate_at_threshold(threshold, label, cm_filename):
    print(f"\n{'=' * 60}")
    print(f"FULL EVALUATION — {label} threshold = {threshold}")
    print(f"{'=' * 60}")

    test_pred_at_threshold = (test_probs >= threshold).astype(int)

    print(f"\n=== Classification Report (test, threshold={threshold}) ===")
    print(classification_report(y_test, test_pred_at_threshold, target_names=['legit', 'fraud']))
    print(f"ROC-AUC: {roc_auc:.4f}")
    print(f"PR-AUC (Average Precision): {pr_auc:.4f}")

    plot_confusion_matrix(y_test, test_pred_at_threshold, threshold, filename=cm_filename)


evaluate_at_threshold(F1_BEST_THRESHOLD, "F1-max (balanced)", "confusion_matrix_f1.png")
evaluate_at_threshold(F2_BEST_THRESHOLD, "F2-max (recall-weighted)", "confusion_matrix_f2.png")


# ## 6. Summary of Fraud Feature Importance

# In[25]:


final_model = tuned_model.named_steps['clf']

importances = pd.DataFrame({
    'Feature': X_train.columns,
    'Importance': final_model.feature_importances_
}).sort_values('Importance', ascending=False)

print(importances.to_string(index=False))


TOP_Features = 10
TOP_Half = TOP_Features // 2

colors = ['red' if i < TOP_Half else 'salmon' if i < TOP_Features else 'steelblue' for i in range(len(importances))]



plt.figure(figsize=(9, 8))
plt.barh(importances['Feature'][::-1], importances['Importance'][::-1], color=colors[::-1])
plt.xlabel('Feature Importance')


plt.title(f'CatBoost Feature Importance (top {TOP_Features} highlighted)')
plt.tight_layout()
plt.savefig('feature_importance.png', dpi=150, bbox_inches='tight')
plt.show()


# In[26]:


top_features = importances['Feature'].head(TOP_Features).tolist()

table_data = []

for feature in top_features:
    overall = df[feature]
    fraud = df.loc[df['Class'] == 1, feature]

    if feature == 'Amount':
        fraud = np.expm1(fraud)

    table_data.append({
        'Feature': feature,
        'Overall Range': f"{overall.min():.2f} to {overall.max():.2f}",
        'Fraud Average': round(fraud.mean(), 2)
    })

results_table = pd.DataFrame(table_data)
print(results_table)

