"""
likedislike.py
==============
Like / Dislike predictor for NeuroVibe.

Uses the pre-trained stacked ensemble (generic_model.pkl) trained on the
Emognition dataset, plus per-user personalisation via isotonic probability
recalibration.

Pipeline
--------
1.  Receive 4-channel EEG from Muse at 256 Hz          (4, 1024) window
2.  Downsample 256 Hz → 128 Hz to match training        (4, 512)
3.  Subtract user baseline (or global fallback if none)
4.  Per-user Z-score normalisation (if user profile available)
5.  Extract 105 frequency-domain features
6.  StandardScaler transform (same scaler as training)
7.  Stacked ensemble predict_proba
8.  Isotonic recalibration (if calibration data available)
9.  Threshold → like / dislike label

user.pkl schema
---------------
{
    baseline        : np.ndarray (4, 512)  @ 128 Hz — mean baseline window
    zscore_mu       : np.ndarray (4, 1, 1) — per-channel mean for Z-score
    zscore_sig      : np.ndarray (4, 1, 1) — per-channel std  for Z-score
    iso_calibrator  : sklearn.isotonic.IsotonicRegression or None
    threshold       : float  (default 0.5)
    n_cal_windows   : int
}
"""

import os
import pickle
import numpy as np
import joblib
from typing import Optional
from scipy.signal import welch, coherence as sp_coh, resample_poly

# ─────────────────────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────────────────────

_HERE      = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR  = os.path.join(_HERE, "emognition_models")
USER_PKL   = os.path.join(MODEL_DIR, "user.pkl")

# ─────────────────────────────────────────────────────────────────────────────
# Feature-extraction constants  (must match training notebook v4)
# ─────────────────────────────────────────────────────────────────────────────

FS_MODEL  = 128                  # Hz — model was trained at 128 Hz
FS_MUSE   = 256                  # Hz — Muse hardware sample rate
WIN_MODEL = 512                  # samples @ 128 Hz  = 4 s
WIN_MUSE  = 1024                 # samples @ 256 Hz  = 4 s
N_EEG     = 4                    # TP9, AF7, AF8, TP10
N_FEAT    = 105
MIN_CAL_WINDOWS_FOR_ISO = 10
MIN_CAL_WINDOWS_FOR_ZSCORE = 5

BANDS = {
    "delta": (1,  4),
    "theta": (4,  8),
    "alpha": (8,  13),
    "beta":  (13, 30),
    "gamma": (30, 40),
}
BAND_NAMES = list(BANDS.keys())
N_BANDS    = len(BAND_NAMES)
COH_PAIRS  = [(0,1),(0,2),(0,3),(1,2),(1,3),(2,3)]
_NPERSEG   = 128


# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────

def _band_idx(freqs: np.ndarray) -> dict:
    return {
        n: np.where((freqs >= lo) & (freqs < hi))[0]
        for n, (lo, hi) in BANDS.items()
    }


def downsample_eeg(win_256: np.ndarray) -> np.ndarray:
    """
    (4, 1024) @ 256 Hz  →  (4, 512) @ 128 Hz
    Uses polyphase decimation (factor-of-2) to avoid aliasing.
    """
    return resample_poly(win_256, 1, 2, axis=1).astype(np.float32)


def extract_105(win: np.ndarray) -> np.ndarray:
    """
    (4, 512) float32 @ 128 Hz  →  (105,) float32

    Feature layout  (must match training exactly):
      band_power          4ch × 5 bands  = 20
      diff_entropy        4ch × 5 bands  = 20
      alpha/beta ratio    4ch            =  4
      theta/alpha ratio   4ch            =  4
      FAA alpha/theta/beta               =  3
      engagement index    4ch            =  4
      spectral centroid   4ch            =  4
      Hjorth mobility     4ch            =  4
      Hjorth complexity   4ch            =  4
      coherence           6 pairs × 5   = 30
      PSD entropy         4ch            =  4
      peak frequency      4ch            =  4
                                         ─────
                                          105
    """
    fv: list = []
    fr, psds = welch(win, fs=FS_MODEL, nperseg=_NPERSEG,
                     scaling="density", axis=1)
    bi = _band_idx(fr)
    df = fr[1] - fr[0]

    bp = np.zeros((N_EEG, N_BANDS), dtype=np.float32)
    for k, name in enumerate(BAND_NAMES):
        idx = bi[name]
        if len(idx):
            bp[:, k] = np.trapz(psds[:, idx], dx=df, axis=1)

    bps = np.where(bp > 0, bp, 1e-10)

    ai  = BAND_NAMES.index("alpha")
    bi_ = BAND_NAMES.index("beta")
    ti  = BAND_NAMES.index("theta")

    # ── 20: band power ────────────────────────────────────────────────────
    fv.append(bp.ravel())

    # ── 20: differential entropy ──────────────────────────────────────────
    fv.append((0.5 * np.log(2 * np.pi * np.e * bps)).ravel())

    # ── 4: alpha/beta ratio ───────────────────────────────────────────────
    fv.append(bps[:, ai] / bps[:, bi_])

    # ── 4: theta/alpha ratio ──────────────────────────────────────────────
    fv.append(bps[:, ti] / bps[:, ai])

    # ── 3: FAA (alpha, theta, beta) ───────────────────────────────────────
    # AF8=ch2 right frontal, AF7=ch1 left frontal
    fv.append(np.array([
        np.log(bps[2, ai])  - np.log(bps[1, ai]),
        np.log(bps[2, ti])  - np.log(bps[1, ti]),
        np.log(bps[2, bi_]) - np.log(bps[1, bi_]),
    ]))

    # ── 4: engagement index = beta / (alpha + theta) ──────────────────────
    fv.append(bps[:, bi_] / (bps[:, ai] + bps[:, ti]))

    # ── 4: spectral centroid ──────────────────────────────────────────────
    psd_sum = psds.sum(axis=1) + 1e-10
    fv.append((psds * fr).sum(axis=1) / psd_sum)

    # ── 8: Hjorth mobility + complexity ───────────────────────────────────
    hm = np.zeros(N_EEG); hc = np.zeros(N_EEG)
    for ch in range(N_EEG):
        d1 = np.diff(win[ch]); d2 = np.diff(d1)
        v0 = np.var(win[ch]) + 1e-10
        v1 = np.var(d1)      + 1e-10
        v2 = np.var(d2)      + 1e-10
        mob    = np.sqrt(v1 / v0)
        hm[ch] = mob
        hc[ch] = np.sqrt(v2 / v1) / mob
    fv.extend([hm, hc])

    # ── 30: inter-channel coherence (6 pairs × 5 bands) ───────────────────
    for ca, cb in COH_PAIRS:
        fc, cxy = sp_coh(win[ca], win[cb], fs=FS_MODEL, nperseg=_NPERSEG)
        cbi = _band_idx(fc)
        for name in BAND_NAMES:
            idx = cbi[name]
            fv.append(np.array([cxy[idx].mean() if len(idx) else 0.0]))

    # ── 4: power spectral entropy ─────────────────────────────────────────
    pse = np.zeros(N_EEG)
    for ch in range(N_EEG):
        p = psds[ch] / (psds[ch].sum() + 1e-10)
        p = np.where(p > 0, p, 1e-10)
        pse[ch] = -np.sum(p * np.log(p))
    fv.append(pse)

    # ── 4: peak frequency ─────────────────────────────────────────────────
    fv.append(fr[np.argmax(psds, axis=1)])

    feat = np.concatenate(fv).astype(np.float32)
    return np.nan_to_num(feat, nan=0.0, posinf=0.0, neginf=0.0)


# ─────────────────────────────────────────────────────────────────────────────
# Main predictor class
# ─────────────────────────────────────────────────────────────────────────────

class LikeDislikePredictor:
    """
    Loads the generic stacked ensemble and optionally a per-user profile.

    Usage
    -----
    predictor = LikeDislikePredictor()

    # During live streaming:
    result = predictor.predict(eeg_window_256hz)
    # → {'label': 'like', 'probability': 0.31, 'confidence': 0.38}

    # After calibration flow:
    predictor.build_user_profile(baseline_windows, cal_windows, labels)
    """

    # Accumulate this many Muse-256-Hz samples before making a prediction
    required_samples: int = WIN_MUSE  # 1024 samples = 4 s

    def __init__(self) -> None:
        self._model: Optional[object]          = None
        self._scaler: Optional[object]         = None
        self._global_baseline: Optional[np.ndarray] = None

        # Load base model files if they exist
        model_path    = os.path.join(MODEL_DIR, "generic_model.pkl")
        scaler_path   = os.path.join(MODEL_DIR, "scaler.pkl")
        baseline_path = os.path.join(MODEL_DIR, "global_baseline.npy")

        if os.path.exists(model_path):
            try:
                self._model = joblib.load(model_path)
            except Exception as e:
                print(f"⚠️  Could not load generic_model.pkl: {e}")
        else:
            print(f"⚠️  generic_model.pkl not found at {model_path} — predictions disabled until calibration")

        if os.path.exists(scaler_path):
            try:
                self._scaler = joblib.load(scaler_path)
            except Exception as e:
                print(f"⚠️  Could not load scaler.pkl: {e}")

        if os.path.exists(baseline_path):
            try:
                self._global_baseline = np.load(baseline_path)
            except Exception as e:
                print(f"⚠️  Could not load global_baseline.npy: {e}")

        self._user: Optional[dict] = self._load_user_pkl()
        print(f"✓ LikeDislikePredictor ready  "
              f"(model: {'yes' if self._model else 'no'}, "
              f"user profile: {'yes' if self._user else 'no'})")

    # ── persistence ───────────────────────────────────────────────────────

    @staticmethod
    def _load_user_pkl() -> Optional[dict]:
        if os.path.exists(USER_PKL):
            try:
                with open(USER_PKL, "rb") as fh:
                    user = pickle.load(fh)
                # Backfill fields for older profiles
                if isinstance(user, dict):
                    if "has_iso" not in user:
                        user["has_iso"] = bool(user.get("iso_calibrator"))
                    if "n_cal_windows" not in user:
                        user["n_cal_windows"] = 0
                return user
            except Exception as e:
                print(f"⚠️  Could not load user.pkl: {e}")
        return None

    def _save_user_pkl(self, user: dict) -> None:
        os.makedirs(MODEL_DIR, exist_ok=True)
        with open(USER_PKL, "wb") as fh:
            pickle.dump(user, fh)
        self._user = user
        print(f"✓ user.pkl saved → {USER_PKL}")

    # ── public helpers ────────────────────────────────────────────────────

    def has_user_profile(self) -> bool:
        return self._user is not None

    def reload_user_profile(self) -> None:
        """Re-read user.pkl from disk (call after calibration POST)."""
        self._user = self._load_user_pkl()

    # ── baseline from raw windows ─────────────────────────────────────────

    @staticmethod
    def windows_from_buffer(eeg_buffer_256hz: list, win_size: int = WIN_MUSE) -> list:
        """
        Convert a flat list of {'tp9','af7','af8','tp10'} dicts (at 256 Hz)
        into a list of non-overlapping (4, 1024) numpy windows.
        """
        n = len(eeg_buffer_256hz)
        windows = []
        for start in range(0, n - win_size + 1, win_size):
            chunk = eeg_buffer_256hz[start: start + win_size]
            win = np.array([
                [s["tp9"]  for s in chunk],
                [s["af7"]  for s in chunk],
                [s["af8"]  for s in chunk],
                [s["tp10"] for s in chunk],
            ], dtype=np.float32)
            windows.append(win)
        return windows

    # ── prediction ────────────────────────────────────────────────────────

    def predict(
        self,
        eeg_window_256hz: np.ndarray,
    ) -> dict:
        """
        Parameters
        ----------
        eeg_window_256hz : np.ndarray (4, 1024) at 256 Hz

        Returns
        -------
        dict with keys:
            label       : 'like' or 'dislike'
            probability : float  P(dislike),  0→strongly like, 1→strongly dislike
            confidence  : float  0–1,  distance from decision boundary
        """
        if self._model is None or self._scaler is None:
            return {'label': 'unknown', 'probability': 0.5, 'confidence': 0.0}

        # Resample to 128 Hz
        win = downsample_eeg(eeg_window_256hz)   # (4, 512)

        # Baseline correction
        # global_baseline may be (4,) per-channel mean OR (4, 512) full window
        if self._user and "baseline" in self._user:
            baseline = self._user["baseline"]                  # (4, 512)
        elif self._global_baseline is not None:
            gb = self._global_baseline
            if gb.ndim == 1:
                baseline = gb.reshape(N_EEG, 1)               # (4,) → (4,1) broadcastable
            elif gb.shape == win.shape:
                baseline = gb                                   # (4, 512) — exact match
            elif gb.shape == (N_EEG, WIN_MUSE):
                # global_baseline.npy was saved at 256 Hz — downsample on the fly
                baseline = downsample_eeg(gb)                  # → (4, 512)
            else:
                baseline = np.zeros_like(win)                  # unexpected shape → skip
        else:
            baseline = np.zeros_like(win)                      # no correction
        win_corr = win - baseline

        # Per-user Z-score normalisation
        # zscore_mu/sig stored as (4, 1, 1) — reshape to (4, 1) for (4, 512) broadcasting
        if self._user and "zscore_mu" in self._user:
            # stored as (4,1,1) — reshape to (4,1) for (4,512) broadcasting
            mu  = np.asarray(self._user["zscore_mu"]).reshape(N_EEG, 1).astype(np.float32)
            sig = np.asarray(self._user["zscore_sig"]).reshape(N_EEG, 1).astype(np.float32)
            win_corr = (win_corr - mu) / (np.maximum(sig, 1e-8))

        # Feature extraction
        feat    = extract_105(win_corr).reshape(1, -1)
        feat_sc = self._scaler.transform(feat)

        # Predict
        raw_prob = float(self._model.predict_proba(feat_sc)[0, 1])  # P(dislike)
        prob     = raw_prob

        # Isotonic recalibration (only if calibrator was actually fitted and not collapsed)
        if self._user and self._user.get("iso_calibrator") is not None:
            iso  = self._user["iso_calibrator"]
            prob = float(iso.predict([raw_prob])[0])

        threshold  = 0.5 if not self._user else self._user.get("threshold", 0.5)
        label      = "dislike" if prob >= threshold else "like"
        confidence = float(abs(prob - threshold) * 2)

        return {
            "label":         label,
            "probability":   round(prob, 3),
            "raw_probability": round(raw_prob, 3),
            "confidence":    round(confidence, 3),
            "threshold":     round(threshold, 3),
            "calibrated":    bool(self._user and (self._user.get("has_iso") or
                                                   self._user.get("threshold", 0.5) != 0.5)),
            "n_cal_windows": int(self._user.get("n_cal_windows", 0)) if self._user else 0,
        }

    # ── profile building (called after calibration) ───────────────────────

    def build_user_profile(
        self,
        baseline_windows: list,
        calibration_windows: list,
        labels: list,
    ) -> dict:
        """
        Build and persist a per-user profile.

        Parameters
        ----------
        baseline_windows    : list of np.ndarray (4, 1024) at 256 Hz
                              Collected during the 2–3 min resting baseline.
        calibration_windows : list of np.ndarray (4, 1024) at 256 Hz
                              EEG windows collected while the user listened to
                              each calibration song clip.
        labels              : list of int  (0 = like, 1 = dislike)
                              One label per *calibration* window.

        Returns
        -------
        user_data dict (also saved to user.pkl)
        """
        from sklearn.isotonic import IsotonicRegression

        if not baseline_windows:
            raise ValueError("Need at least one baseline window.")
        if len(calibration_windows) != len(labels):
            raise ValueError("calibration_windows and labels must have the same length.")

        # ── 1. Compute user baseline ──────────────────────────────────────
        baseline_128 = np.array([downsample_eeg(w) for w in baseline_windows])  # (N, 4, 512)
        nan_count = int(np.isnan(baseline_128).sum())
        if nan_count > 0:
            print(f"  [WARN] baseline_128 contains {nan_count} NaN values "
                  f"(likely from lost-channel samples) → replacing with 0")
            baseline_128 = np.nan_to_num(baseline_128, nan=0.0, posinf=0.0, neginf=0.0)
        baseline_mean = baseline_128.mean(axis=0)          # (4, 512)

        # ── 2. Compute Z-score stats across ALL user windows (baseline + calibration)
        # This exactly matches the training notebook which used axis=(0,2) across all
        # participant windows. Using only calibration or only baseline gives noisy stats.
        cal_128 = (
            np.array([downsample_eeg(w) for w in calibration_windows], dtype=np.float32)
            if calibration_windows
            else np.empty((0, N_EEG, WIN_MODEL), dtype=np.float32)
        )
        if len(cal_128) > 0:
            nan_cal = int(np.isnan(cal_128).sum())
            if nan_cal > 0:
                print(f"  [WARN] cal_128 contains {nan_cal} NaN values → replacing with 0")
                cal_128 = np.nan_to_num(cal_128, nan=0.0, posinf=0.0, neginf=0.0)

        # Baseline-correct both sets, then pool them for Z-score computation.
        baseline_corr = (baseline_128 - baseline_mean).astype(np.float32)   # (N_base, 4, 512)
        if len(cal_128) > 0:
            cal_corr = (cal_128 - baseline_mean).astype(np.float32)          # (N_cal, 4, 512)
            all_corr = np.concatenate([baseline_corr, cal_corr], axis=0)     # (N_total, 4, 512)
        else:
            all_corr = baseline_corr
        zscore_source = "all_windows"

        zscore_mu  = all_corr.mean(axis=(0, 2), keepdims=True)   # (1, 4, 1)
        zscore_sig = all_corr.std( axis=(0, 2), keepdims=True)   # (1, 4, 1)
        # Reshape for broadcasting: (4, 1, 1)
        zscore_mu  = zscore_mu.squeeze(0).reshape(N_EEG, 1, 1).astype(np.float32)
        zscore_sig = zscore_sig.squeeze(0).reshape(N_EEG, 1, 1).astype(np.float32)

        # ── 3. Extract features from calibration windows ──────────────────
        # z-score mu/sig have shape (4,1,1); we need (4,1) for 2-D windows.
        _zmu  = zscore_mu[:, :, 0]   # (4, 1)
        _zsig = zscore_sig[:, :, 0]  # (4, 1)

        iso = None
        if self._model is not None and self._scaler is not None:
            feats = []
            for win_256 in calibration_windows:
                win = downsample_eeg(win_256) - baseline_mean
                win = (win - _zmu) / (_zsig + 1e-8)
                feats.append(extract_105(win))

            feats    = np.nan_to_num(np.array(feats, dtype=np.float32))
            feats_sc = self._scaler.transform(feats)
            labels_arr = np.array(labels, dtype=np.int32)

            # ── 4. Compute calibration-optimal threshold (robust for small n_cal) ──
            # Sweep thresholds and pick the one that maximises balanced accuracy on
            # the calibration set.  Works reliably even with 10–30 windows.
            from sklearn.metrics import balanced_accuracy_score as _ba_score
            label_counts = {int(k): int(v) for k, v in zip(*np.unique(labels_arr, return_counts=True))}
            probs = (self._model.predict_proba(feats_sc)[:, 1]
                     if (self._model is not None and self._scaler is not None)
                     else np.full(len(feats_sc), 0.5, dtype=np.float32))

            best_thresh = 0.5
            best_ba     = 0.0
            for _t in np.arange(0.10, 0.91, 0.05):
                _preds = (probs >= _t).astype(int)
                if len(np.unique(_preds)) < 2:
                    continue
                _ba = _ba_score(labels_arr, _preds)
                if _ba > best_ba:
                    best_ba, best_thresh = _ba, float(_t)
            print(f"  Optimal threshold: {best_thresh:.2f}  (cal BA={best_ba:.1%}  "
                  f"prob range=[{probs.min():.3f}, {probs.max():.3f}])")

            # ── 5. Fit isotonic recalibrator (only if enough data + both classes) ──
            # Skip if the isotonic collapses to ≤ 2 unique output values — that means
            # the raw probabilities have too little variance to recalibrate usefully.
            iso = None
            if len(feats_sc) >= MIN_CAL_WINDOWS_FOR_ISO and len(np.unique(labels_arr)) >= 2:
                _iso_cand = IsotonicRegression(out_of_bounds="clip")
                _iso_cand.fit(probs, labels_arr)
                # Evaluate on a grid to detect collapse
                _iso_test  = _iso_cand.predict(np.linspace(0.0, 1.0, 51))
                _n_unique  = len(np.unique(_iso_test))
                _iso_range = _iso_test.max() - _iso_test.min()
                if _n_unique >= 3 and _iso_range >= 0.05:
                    iso = _iso_cand
                    print(f"  Isotonic OK: {_n_unique} unique outputs, range={_iso_range:.3f}")
                else:
                    print(f"  [WARN] Isotonic collapsed ({_n_unique} unique values, "
                          f"range={_iso_range:.3f}) — using threshold-only personalisation")
        else:
            print("  No base model available — saving baseline/Z-score stats only.")
            label_counts = {}
            best_thresh  = 0.5

        # ── 6. Persist ────────────────────────────────────────────────────
        user_data: dict = {
            "baseline":        baseline_mean,
            "zscore_mu":       zscore_mu,
            "zscore_sig":      zscore_sig,
            "iso_calibrator":  iso,
            "threshold":       best_thresh,
            "n_cal_windows":   len(calibration_windows),
            "zscore_source":   zscore_source,
            "has_iso":         bool(iso),
            "label_counts":    label_counts,
        }
        self._save_user_pkl(user_data)
        return user_data

    # ── convenience ───────────────────────────────────────────────────────

    def delete_user_profile(self) -> None:
        """Remove user.pkl and revert to generic model."""
        if os.path.exists(USER_PKL):
            os.remove(USER_PKL)
        self._user = None
        print("✓ user.pkl deleted — reverted to generic model")
