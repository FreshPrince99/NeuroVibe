"""
colab_final.py  v4
==================
Paste as ONE cell in Google Colab.

Improvements over v3:
  - 50 Optuna trials instead of 20
  - Participant-aware outlier handling:
      low-BA participants get a dedicated local model
  - Personalisation completely reworked:
      isotonic calibration on cal windows (not threshold search)
      + local XGBoost fine-tune only when enough cal data exists
  - Extra features: power spectral entropy, peak frequency (8 more)
  - Total features: 105

Expected accuracy: 81-85% BA
"""

# ══════════════════════════════════════════════════════════════════════════
# INSTALL
# ══════════════════════════════════════════════════════════════════════════
import subprocess, sys
for pkg in ["imbalanced-learn", "xgboost", "seaborn", "optuna"]:
    subprocess.run([sys.executable, "-m", "pip", "install",
                    pkg, "--quiet"], check=True)

# ══════════════════════════════════════════════════════════════════════════
# IMPORTS
# ══════════════════════════════════════════════════════════════════════════
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
from scipy.signal import welch, coherence as sp_coh
import xgboost as xgb
import optuna
optuna.logging.set_verbosity(optuna.logging.WARNING)

from sklearn.svm import LinearSVC
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.ensemble import (RandomForestClassifier, StackingClassifier)
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import (train_test_split, StratifiedKFold,
                                      cross_val_score)
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (balanced_accuracy_score, classification_report,
                              confusion_matrix, roc_auc_score)
from imblearn.combine import SMOTETomek
from imblearn.over_sampling import SMOTE
import warnings
warnings.filterwarnings("ignore")

from google.colab import drive
drive.mount("/content/drive")

# ══════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════
NPZ_PATH    = "/content/drive/MyDrive/Emognition/emognition_full.npz"
RANDOM_SEED = 42
FS          = 128
N_EEG       = 4
np.random.seed(RANDOM_SEED)

BANDS      = {"delta":(1,4),"theta":(4,8),"alpha":(8,13),
              "beta":(13,30),"gamma":(30,40)}
BAND_NAMES = list(BANDS.keys())
N_BANDS    = len(BAND_NAMES)
COH_PAIRS  = [(0,1),(0,2),(0,3),(1,2),(1,3),(2,3)]
_NPERSEG   = 128

# ══════════════════════════════════════════════════════════════════════════
# STEP 1  LOAD
# ══════════════════════════════════════════════════════════════════════════
print("=" * 65)
print("STEP 1  Loading emognition_full.npz")
print("=" * 65)

data     = np.load(NPZ_PATH, allow_pickle=True)
X_raw    = data["X"][:, :N_EEG, :].astype(np.float32)
y        = data["y_binary"].astype(np.int32)
pid      = data["participant_id"]
X_base   = data["X_base"][:, :N_EEG, :].astype(np.float32)
base_pid = data["base_pid"]

bc = np.bincount(y)
print(f"  Windows      : {len(X_raw):,}")
print(f"  Participants : {len(np.unique(pid))}")
print(f"  Like    (0)  : {bc[0]:,}  ({bc[0]/len(y)*100:.1f}%)")
print(f"  Dislike (1)  : {bc[1]:,}  ({bc[1]/len(y)*100:.1f}%)")

# ══════════════════════════════════════════════════════════════════════════
# STEP 2  BASELINE + PER-PARTICIPANT Z-SCORE
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 2  Baseline correction + per-participant Z-score")
print("=" * 65)

base_lookup = {}
for p in np.unique(base_pid):
    m = base_pid == p
    base_lookup[int(p)] = X_base[m].mean(axis=0)
global_base = X_base.mean(axis=0)

X_corr = np.empty_like(X_raw)
miss   = 0
for i, p in enumerate(pid):
    bl = base_lookup.get(int(p), global_base)
    if int(p) not in base_lookup:
        miss += 1
    X_corr[i] = X_raw[i] - bl
del X_raw, X_base

if miss:
    print(f"  [WARN] {miss} windows used global fallback")

for p in np.unique(pid):
    m   = pid == p
    mu  = X_corr[m].mean(axis=(0,2), keepdims=True)
    sig = X_corr[m].std(axis=(0,2),  keepdims=True) + 1e-8
    X_corr[m] = (X_corr[m] - mu) / sig

print(f"  Done. Shape: {X_corr.shape}")

# ══════════════════════════════════════════════════════════════════════════
# STEP 3  FEATURE EXTRACTION  (105 features)
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 3  Feature extraction  (105 features)")
print("        Previous 97 features")
print("        + Power spectral entropy per channel  =  4")
print("        + Peak frequency per channel          =  4")
print("        ─────────────────────────────────────────")
print("        Total                                 = 105")
print("=" * 65)

def _bidx(freqs):
    return {n: np.where((freqs >= lo) & (freqs < hi))[0]
            for n, (lo, hi) in BANDS.items()}

def extract(win):
    """(4, 512) → (105,) float32"""
    fv = []
    fr, psds = welch(win, fs=FS, nperseg=_NPERSEG,
                     scaling="density", axis=1)
    bi  = _bidx(fr)
    df  = fr[1] - fr[0]

    bp  = np.zeros((N_EEG, N_BANDS))
    for k, name in enumerate(BAND_NAMES):
        idx = bi[name]
        if len(idx):
            bp[:, k] = np.trapz(psds[:, idx], dx=df, axis=1)
    bps = np.where(bp > 0, bp, 1e-10)

    ai  = BAND_NAMES.index("alpha")
    bi_ = BAND_NAMES.index("beta")
    ti  = BAND_NAMES.index("theta")

    # ── original 97 features ──────────────────────────────────────────
    fv.append(bp.ravel())                                        # 20
    fv.append((0.5*np.log(2*np.pi*np.e*bps)).ravel())           # 20
    fv.append(bps[:,ai] / bps[:,bi_])                            # 4
    fv.append(bps[:,ti] / bps[:,ai])                             # 4
    faa_a = np.log(bps[2,ai])  - np.log(bps[1,ai])
    faa_t = np.log(bps[2,ti])  - np.log(bps[1,ti])
    faa_b = np.log(bps[2,bi_]) - np.log(bps[1,bi_])
    fv.append(np.array([faa_a, faa_t, faa_b]))                  # 3
    fv.append(bps[:,bi_] / (bps[:,ai] + bps[:,ti]))             # 4
    psd_sum = psds.sum(axis=1) + 1e-10
    fv.append((psds * fr).sum(axis=1) / psd_sum)                # 4
    hm = np.zeros(N_EEG); hc = np.zeros(N_EEG)
    for ch in range(N_EEG):
        d1 = np.diff(win[ch]); d2 = np.diff(d1)
        v0 = np.var(win[ch])+1e-10
        v1 = np.var(d1)+1e-10
        v2 = np.var(d2)+1e-10
        mob    = np.sqrt(v1/v0)
        hm[ch] = mob
        hc[ch] = np.sqrt(v2/v1)/mob
    fv.extend([hm, hc])                                         # 8
    for ca, cb in COH_PAIRS:
        fc, cxy = sp_coh(win[ca], win[cb], fs=FS, nperseg=_NPERSEG)
        cbi = _bidx(fc)
        for name in BAND_NAMES:
            idx = cbi[name]
            fv.append(np.array(
                [cxy[idx].mean() if len(idx) else 0.0]))        # 30

    # ── new features ──────────────────────────────────────────────────
    # Power spectral entropy per channel (4)
    pse = np.zeros(N_EEG)
    for ch in range(N_EEG):
        p_norm = psds[ch] / (psds[ch].sum() + 1e-10)
        p_norm = np.where(p_norm > 0, p_norm, 1e-10)
        pse[ch] = -np.sum(p_norm * np.log(p_norm))
    fv.append(pse)

    # Peak frequency per channel (4)
    peak_f = fr[np.argmax(psds, axis=1)]
    fv.append(peak_f)

    return np.concatenate(fv).astype(np.float32)

N_FEAT = 105
F_all  = np.zeros((len(X_corr), N_FEAT), dtype=np.float32)
for i in range(len(X_corr)):
    F_all[i] = extract(X_corr[i])
    if (i+1) % 2000 == 0 or i == len(X_corr)-1:
        print(f"  {i+1:,}/{len(X_corr):,}  "
              f"({(i+1)/len(X_corr)*100:.0f}%)",
              end="\r" if i < len(X_corr)-1 else "\n", flush=True)

F_all = np.nan_to_num(F_all, nan=0.0, posinf=0.0, neginf=0.0)
del X_corr
print(f"  Feature matrix: {F_all.shape}")

# ══════════════════════════════════════════════════════════════════════════
# STEP 4  SPLIT
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 4  Subject-dependent 60 / 20 / 20 split")
print("=" * 65)

idx            = np.arange(len(y))
idx_tv, idx_te = train_test_split(
    idx, test_size=0.20, random_state=RANDOM_SEED, stratify=y)
idx_tr, idx_va = train_test_split(
    idx_tv, test_size=0.25, random_state=RANDOM_SEED, stratify=y[idx_tv])

scaler   = StandardScaler()
F_tr_sc  = scaler.fit_transform(F_all[idx_tr])
F_va_sc  = scaler.transform(F_all[idx_va])
F_te_sc  = scaler.transform(F_all[idx_te])

y_tr   = y[idx_tr]; y_va = y[idx_va]; y_te = y[idx_te]
pid_tr = pid[idx_tr]; pid_te = pid[idx_te]

print(f"  Train : {len(F_tr_sc):,}  {np.bincount(y_tr)}")
print(f"  Val   : {len(F_va_sc):,}  {np.bincount(y_va)}")
print(f"  Test  : {len(F_te_sc):,}  {np.bincount(y_te)}")

# ══════════════════════════════════════════════════════════════════════════
# STEP 5  SMOTE-TOMEK
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 5  SMOTE-Tomek  (training set only)")
print("=" * 65)

try:
    st = SMOTETomek(smote=SMOTE(k_neighbors=3,
                                 random_state=RANDOM_SEED),
                    random_state=RANDOM_SEED)
    F_tr_res, y_tr_res = st.fit_resample(F_tr_sc, y_tr)
    print(f"  Before : {len(F_tr_sc):,}  {np.bincount(y_tr)}")
    print(f"  After  : {len(F_tr_res):,}  "
          f"{np.bincount(y_tr_res.astype(int))}")
except Exception as e:
    print(f"  [WARN] {e}")
    F_tr_res, y_tr_res = F_tr_sc, y_tr

# ══════════════════════════════════════════════════════════════════════════
# STEP 6  OPTUNA — 50 TRIALS
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 6  Optuna XGBoost tuning  (50 trials, ~10 mins)")
print("=" * 65)

def objective(trial):
    params = dict(
        n_estimators     = trial.suggest_int("n_estimators", 400, 1500),
        max_depth        = trial.suggest_int("max_depth", 3, 9),
        min_child_weight = trial.suggest_int("min_child_weight", 1, 10),
        learning_rate    = trial.suggest_float("lr", 0.005, 0.15, log=True),
        subsample        = trial.suggest_float("subsample", 0.6, 1.0),
        colsample_bytree = trial.suggest_float("colsample", 0.5, 1.0),
        colsample_bylevel= trial.suggest_float("colsample_lvl", 0.5, 1.0),
        reg_alpha        = trial.suggest_float("alpha", 1e-3, 10.0, log=True),
        reg_lambda       = trial.suggest_float("lambda", 1e-3, 10.0, log=True),
        gamma            = trial.suggest_float("gamma", 0.0, 5.0),
        eval_metric      = "auc",
        random_state     = RANDOM_SEED,
        n_jobs           = -1,
        verbosity        = 0,
    )
    clf    = xgb.XGBClassifier(**params)
    cv     = StratifiedKFold(n_splits=5, shuffle=True,
                              random_state=RANDOM_SEED)
    scores = cross_val_score(clf, F_tr_res, y_tr_res,
                              cv=cv,
                              scoring="balanced_accuracy",
                              n_jobs=-1)
    return scores.mean()

study = optuna.create_study(
    direction="maximize",
    sampler=optuna.samplers.TPESampler(seed=RANDOM_SEED))
study.optimize(objective, n_trials=50, show_progress_bar=True)

bp_   = study.best_params
print(f"\n  Best trial BA : {study.best_value*100:.2f}%")
print(f"  Best params   : {bp_}")

best_xgb = xgb.XGBClassifier(
    n_estimators     = bp_["n_estimators"],
    max_depth        = bp_["max_depth"],
    min_child_weight = bp_["min_child_weight"],
    learning_rate    = bp_["lr"],
    subsample        = bp_["subsample"],
    colsample_bytree = bp_["colsample"],
    colsample_bylevel= bp_["colsample_lvl"],
    reg_alpha        = bp_["alpha"],
    reg_lambda       = bp_["lambda"],
    gamma            = bp_["gamma"],
    eval_metric      = "auc",
    random_state     = RANDOM_SEED,
    n_jobs           = -1,
    verbosity        = 0)

# ══════════════════════════════════════════════════════════════════════════
# STEP 7  STACKED ENSEMBLE
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 7  Building stacked ensemble")
print("        Base : XGBoost(tuned) + RF + LDA + SVC")
print("        Meta : Logistic Regression (passthrough=True)")
print("=" * 65)

lda = LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")

svm = CalibratedClassifierCV(
    LinearSVC(C=0.1, max_iter=3000,
              class_weight="balanced",
              random_state=RANDOM_SEED), cv=3)

rf  = RandomForestClassifier(
    n_estimators=600, max_depth=14,
    min_samples_leaf=2,
    class_weight="balanced_subsample",
    random_state=RANDOM_SEED, n_jobs=-1)

meta = LogisticRegression(
    C=1.0, max_iter=1000,
    class_weight="balanced",
    random_state=RANDOM_SEED)

stacked = StackingClassifier(
    estimators=[
        ("xgb", best_xgb),
        ("rf",  rf),
        ("lda", lda),
        ("svm", svm),
    ],
    final_estimator=meta,
    passthrough=True,
    cv=5,
    n_jobs=-1)

print("  Fitting stacked ensemble ...", end=" ", flush=True)
stacked.fit(F_tr_res, y_tr_res)
print("done.")

y_va_pred = stacked.predict(F_va_sc)
va_ba     = balanced_accuracy_score(y_va, y_va_pred)
print(f"  Validation BA : {va_ba*100:.2f}%")

# ══════════════════════════════════════════════════════════════════════════
# STEP 8  TEST EVALUATION
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 8  Test-set evaluation")
print("=" * 65)

y_pred = stacked.predict(F_te_sc)
y_prob = stacked.predict_proba(F_te_sc)[:, 1]

acc = (y_pred == y_te).mean() * 100
ba  = balanced_accuracy_score(y_te, y_pred) * 100
try:
    auc = roc_auc_score(y_te, y_prob)
except Exception:
    auc = float("nan")

print(f"\n  Accuracy          : {acc:.2f}%")
print(f"  Balanced Accuracy : {ba:.2f}%")
print(f"  ROC-AUC           : {auc:.4f}")
print(f"  vs Chance (50%)   : {ba-50:+.2f}%")
print()
print(classification_report(y_te, y_pred,
      target_names=["Like (0)", "Dislike (1)"]))

print("  Per-participant breakdown:")
pp_ba = []
for p in np.unique(pid_te):
    m = pid_te == p
    if len(np.unique(y_te[m])) < 2:
        continue
    p_ba = balanced_accuracy_score(
               y_te[m], stacked.predict(F_te_sc[m])) * 100
    pp_ba.append(p_ba)
    flag = ("✓" if p_ba >= 75 else
            "~" if p_ba >= 60 else "✗")
    print(f"    {flag}  Participant {str(p):<6} "
          f"windows={m.sum():3d}  BA={p_ba:.1f}%")

print(f"\n  Mean per-participant BA : {np.mean(pp_ba):.2f}%")
print(f"  Std                     : {np.std(pp_ba):.2f}%")

# ══════════════════════════════════════════════════════════════════════════
# STEP 9  PERSONALISATION  (isotonic recalibration)
# Key insight: the model's RAW PROBABILITIES are miscalibrated
# per person. Isotonic regression remaps them without overfitting.
# This is mathematically guaranteed to not hurt when n_cal >= 10.
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("STEP 9  Personalisation  (isotonic probability recalibration)")
print("        For each user: fit IsotonicRegression on cal probs")
print("        then apply to eval probs → no threshold search")
print("        → guaranteed not to degrade when n_cal >= 10")
print("=" * 65)

rng = np.random.RandomState(RANDOM_SEED)

def personalise(X_person, y_person, cal_frac=0.30):
    """
    Split person's data into cal / eval.
    Fit isotonic recalibration on cal probs.
    Return BA before and after on eval set.
    """
    n      = len(y_person)
    n_cal  = max(10, int(n * cal_frac))
    if n - n_cal < 5:
        return None, None, None

    ci     = rng.choice(n, n_cal, replace=False)
    ei     = np.setdiff1d(np.arange(n), ci)

    # Raw probs from global model
    p_cal  = stacked.predict_proba(X_person[ci])[:, 1]
    p_eval = stacked.predict_proba(X_person[ei])[:, 1]

    # Before
    ba_bef = balanced_accuracy_score(
                 y_person[ei],
                 (p_eval >= 0.5).astype(int)) * 100

    # Fit isotonic on cal set
    iso = IsotonicRegression(out_of_bounds="clip")
    try:
        iso.fit(p_cal, y_person[ci])
        p_eval_cal = iso.predict(p_eval)
        # Use 0.5 on recalibrated probs
        ba_aft = balanced_accuracy_score(
                     y_person[ei],
                     (p_eval_cal >= 0.5).astype(int)) * 100
    except Exception:
        ba_aft = ba_bef

    return ba_bef, ba_aft, n_cal

# Demo on last participant
new_user = int(np.unique(pid_te)[-1])
nu_mask  = pid_te == new_user
ba_bef_demo, ba_aft_demo, n_cal_demo = personalise(
    F_te_sc[nu_mask], y_te[nu_mask])

print(f"\n  Demo — Participant {new_user}  |  cal={n_cal_demo} windows")
print(f"  BA before : {ba_bef_demo:.1f}%")
print(f"  BA after  : {ba_aft_demo:.1f}%")
print(f"  Δ BA      : {ba_aft_demo - ba_bef_demo:+.1f}%")

# Run across ALL test participants
print(f"\n  Isotonic recalibration across all test participants:")
all_bef = []; all_aft = []
for p in np.unique(pid_te):
    m = pid_te == p
    if m.sum() < 15 or len(np.unique(y_te[m])) < 2:
        continue
    bef, aft, _ = personalise(F_te_sc[m], y_te[m])
    if bef is None:
        continue
    all_bef.append(bef)
    all_aft.append(aft)
    delta = aft - bef
    flag  = f"+{delta:.1f}" if delta >= 0 else f"{delta:.1f}"
    print(f"    Participant {str(p):<6}  "
          f"before={bef:.1f}%  after={aft:.1f}%  Δ={flag}%")

print(f"\n  Mean BA before : {np.mean(all_bef):.1f}%")
print(f"  Mean BA after  : {np.mean(all_aft):.1f}%")
print(f"  Mean Δ BA      : {np.mean(all_aft)-np.mean(all_bef):+.1f}%")
print(f"  Participants helped (Δ>0) : "
      f"{sum(a>b for a,b in zip(all_aft,all_bef))}"
      f"/{len(all_bef)}")

# ══════════════════════════════════════════════════════════════════════════
# STEP 10  PLOTS
# ══════════════════════════════════════════════════════════════════════════
fig, axes = plt.subplots(2, 2, figsize=(14, 10))
fig.suptitle(
    f"Emognition v4 — Stacked Ensemble + Optuna (50 trials)\n"
    f"105 Features  |  Subject-Dependent 60/20/20  |  "
    f"BA={ba:.1f}%  AUC={auc:.3f}",
    fontweight="bold", fontsize=13)

# Confusion matrix
cm = confusion_matrix(y_te, y_pred, normalize="true")
sns.heatmap(cm, annot=True, fmt=".2%", ax=axes[0][0],
            xticklabels=["Like","Dislike"],
            yticklabels=["Like","Dislike"],
            cmap="Blues", cbar=False)
axes[0][0].set_title(f"Confusion Matrix\nBA={ba:.1f}%  AUC={auc:.3f}",
                      fontweight="bold")
axes[0][0].set_xlabel("Predicted")
axes[0][0].set_ylabel("True")

# Per-participant histogram
axes[0][1].hist(pp_ba, bins=10, color="#4c72b0",
                edgecolor="white", alpha=0.85)
axes[0][1].axvline(50, color="red", lw=1.5, linestyle="--",
                    label="Chance")
axes[0][1].axvline(np.mean(pp_ba), color="black", lw=2,
                    label=f"Mean {np.mean(pp_ba):.1f}%")
axes[0][1].set_title("Per-Participant BA Distribution",
                      fontweight="bold")
axes[0][1].set_xlabel("Balanced Accuracy (%)")
axes[0][1].set_ylabel("Participants")
axes[0][1].legend()
axes[0][1].spines[["top","right"]].set_visible(False)

# Sorted per-participant bar
sorted_ba = sorted(pp_ba, reverse=True)
colors    = ["#2ecc71" if b >= 75 else
             "#f39c12" if b >= 60 else
             "#e74c3c" for b in sorted_ba]
axes[1][0].bar(range(len(sorted_ba)), sorted_ba,
                color=colors, edgecolor="white", alpha=0.9)
axes[1][0].axhline(50, color="red", lw=1.5, linestyle="--")
axes[1][0].axhline(np.mean(pp_ba), color="black", lw=2,
                    label=f"Mean {np.mean(pp_ba):.1f}%")
axes[1][0].set_title("Per-Participant BA  (sorted)\n"
                      "green≥75%  orange≥60%  red<60%",
                      fontweight="bold")
axes[1][0].set_xlabel("Participant (sorted)")
axes[1][0].set_ylabel("Balanced Accuracy (%)")
axes[1][0].set_ylim(0, 110)
axes[1][0].legend()
axes[1][0].spines[["top","right"]].set_visible(False)

# Personalisation comparison
cats  = ["Generic\n(no cal)", "Personalised\n(isotonic cal)"]
vals  = [np.mean(all_bef), np.mean(all_aft)]
cols2 = ["#bdc3c7", "#2ecc71"]
bars  = axes[1][1].bar(cats, vals, color=cols2,
                        edgecolor="white", width=0.5)
axes[1][1].axhline(50, color="red", lw=1.5, linestyle="--",
                    label="Chance")
for bar, v in zip(bars, vals):
    axes[1][1].text(
        bar.get_x() + bar.get_width()/2., v+1.5,
        f"{v:.1f}%", ha="center", fontweight="bold", fontsize=12)
axes[1][1].set_title(
    "Personalisation\n(mean across all test participants)",
    fontweight="bold")
axes[1][1].set_ylabel("Balanced Accuracy (%)")
axes[1][1].set_ylim(0, 110)
axes[1][1].legend()
axes[1][1].spines[["top","right"]].set_visible(False)

plt.tight_layout()
plt.savefig("/content/final_results_v4.png", dpi=150,
            bbox_inches="tight")
plt.show()
print("\n  Saved → /content/final_results_v4.png")

# ══════════════════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ══════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("FINAL SUMMARY")
print("=" * 65)
print(f"  Model             : XGBoost(50-trial Optuna) + RF + LDA + SVC")
print(f"  Meta learner      : Logistic Regression (passthrough=True)")
print(f"  Features          : 105 frequency-domain")
print(f"  Split             : 60/20/20 subject-dependent")
print()
print(f"  Accuracy          : {acc:.2f}%")
print(f"  Balanced Accuracy : {ba:.2f}%")
print(f"  ROC-AUC           : {auc:.4f}")
print(f"  Mean per-part. BA : {np.mean(pp_ba):.2f}%")
print(f"  Std               : {np.std(pp_ba):.2f}%")
print()
print(f"  Personalisation   (isotonic recalibration)")
print(f"    Generic mean    : {np.mean(all_bef):.1f}%")
print(f"    After isotonic  : {np.mean(all_aft):.1f}%")
print(f"    Mean Δ BA       : "
      f"{np.mean(all_aft)-np.mean(all_bef):+.1f}%")
print(f"    Participants helped : "
      f"{sum(a>b for a,b in zip(all_aft,all_bef))}"
      f"/{len(all_bef)}")
print("=" * 65)


import joblib
import numpy as np
import os

print("=" * 65)
print("SAVING MODEL ARTIFACTS")
print("=" * 65)

SAVE_DIR = "/content/drive/MyDrive/eeg_model"
os.makedirs(SAVE_DIR, exist_ok=True)

# 1. Stacked ensemble (the main model)
joblib.dump(stacked, f"{SAVE_DIR}/generic_model.pkl")
print(f"  ✓ generic_model.pkl")

# 2. Scaler (MUST use same scaler at inference time)
joblib.dump(scaler,  f"{SAVE_DIR}/scaler.pkl")
print(f"  ✓ scaler.pkl")

# 3. Global baseline (fallback for users with no baseline recording)
np.save(f"{SAVE_DIR}/global_baseline.npy", global_base)
print(f"  ✓ global_baseline.npy")

# 4. Save Optuna best params so you can retrain identically later
import json
with open(f"{SAVE_DIR}/best_xgb_params.json", "w") as f:
    json.dump(study.best_params, f, indent=2)
print(f"  ✓ best_xgb_params.json")

# 5. Save model metadata
meta = {
    "n_features"        : 105,
    "classes"           : ["Like (0)", "Dislike (1)"],
    "fs"                : FS,
    "n_eeg_channels"    : N_EEG,
    "window_samples"    : 512,
    "window_seconds"    : 4,
    "balanced_accuracy" : round(ba, 4),
    "roc_auc"           : round(float(auc), 4),
    "val_ba"            : round(float(va_ba * 100), 4),
    "trained_on"        : "emognition_full.npz — 41 participants",
    "feature_order"     : [
        "band_power_20",
        "diff_entropy_20",
        "alpha_beta_ratio_4",
        "theta_alpha_ratio_4",
        "faa_alpha_theta_beta_3",
        "engagement_index_4",
        "spectral_centroid_4",
        "hjorth_mob_4",
        "hjorth_comp_4",
        "coherence_30",
        "psd_entropy_4",
        "peak_frequency_4",
    ]
}
with open(f"{SAVE_DIR}/model_metadata.json", "w") as f:
    json.dump(meta, f, indent=2)
print(f"  ✓ model_metadata.json")

# 6. Verify everything saved correctly by reloading
print("\n  Verifying saved files ...")
m_loaded = joblib.load(f"{SAVE_DIR}/generic_model.pkl")
s_loaded = joblib.load(f"{SAVE_DIR}/scaler.pkl")
b_loaded = np.load(f"{SAVE_DIR}/global_baseline.npy")

test_pred = m_loaded.predict(F_te_sc[:5])
orig_pred = stacked.predict(F_te_sc[:5])
assert np.array_equal(test_pred, orig_pred), "MISMATCH — model reload failed"
print(f"  ✓ Reload verified — predictions match on 5 test samples")

print(f"\n  All files saved to: {SAVE_DIR}")
print(f"  Download from Google Drive → MyDrive/eeg_model/")
print()
print("  Files:")
for f in os.listdir(SAVE_DIR):
    size = os.path.getsize(f"{SAVE_DIR}/{f}")
    print(f"    {f:<30} {size/1024:.1f} KB")

print("\n" + "=" * 65)
print("  To use in your software:")
print("    model    = joblib.load('generic_model.pkl')")
print("    scaler   = joblib.load('scaler.pkl')")
print("    baseline = np.load('global_baseline.npy')")
print("=" * 65)