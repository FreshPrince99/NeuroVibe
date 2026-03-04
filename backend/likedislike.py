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
MIN_CAL_WINDOWS_FOR_ISO    = 20   # need ≥20 windows (notebook used ~30) for isotonic to be reliable
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


def _reject_artefacts(win: np.ndarray, threshold: float = 400.0) -> np.ndarray:
    """
    Replace any channel whose peak-to-peak amplitude exceeds `threshold` µV
    with the mean of the remaining channels.  Operates in-place on a copy.

    Parameters
    ----------
    win       : (4, 512) float32 — Z-scored window
    threshold : peak-to-peak threshold in µV (default 400 µV)
    """
    win = win.copy()
    ptp = win.max(axis=1) - win.min(axis=1)          # (4,)
    bad = np.where(ptp > threshold)[0]
    if len(bad) > 0 and len(bad) < win.shape[0]:
        good = np.array([i for i in range(win.shape[0]) if i not in bad])
        win[bad] = win[good].mean(axis=0)
    return win


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

        # Incremental Z-score accumulator — grows during a session.
        # Notebook computes Z-score from ALL participant windows; we replicate
        # this by seeding from baseline+cal windows and adding live windows.
        self._zscore_windows: list = []  # list of (4, 512) baseline-corrected arrays
        if self._user is not None:
            self._seed_zscore_from_profile()

        print(f"✓ LikeDislikePredictor ready  "
              f"(model: {'yes' if self._model else 'no'}, "
              f"user profile: {'yes' if self._user else 'no'}, "
              f"zscore_seed={len(self._zscore_windows)} windows)")

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
        self._zscore_windows = []
        if self._user is not None:
            self._seed_zscore_from_profile()

    # ── Z-score accumulator helpers ──────────────────────────────────────

    def _seed_zscore_from_profile(self) -> None:
        """
        Pre-seed _zscore_windows from the stored mu/sig in user.pkl so that
        predict() has a reasonable Z-score from the very first window.
        We generate synthetic seed vectors that reproduce the stored statistics.
        Notebook used ~200 windows per participant; we can't regenerate those,
        so we create N_SEED representative vectors instead.
        """
        if self._user is None:
            return
        n_cal = int(self._user.get("n_cal_windows", 0))
        n_seed = max(20, n_cal)  # match the number of windows we had at calibration
        mu  = np.asarray(self._user["zscore_mu"]).reshape(N_EEG, 1)   # (4, 1)
        sig = np.asarray(self._user["zscore_sig"]).reshape(N_EEG, 1)  # (4, 1)
        rng = np.random.RandomState(42)
        for _ in range(n_seed):
            # z = (x - mu) / sig  → x = z*sig + mu  where z ~ N(0,1)
            z = rng.randn(N_EEG, WIN_MODEL).astype(np.float32)
            x = z * sig + mu  # (4, 512) — baseline-corrected synthetic window
            self._zscore_windows.append(x)

    def _recompute_zscore(self) -> tuple:
        """
        Recompute Z-score mu/sig from all accumulated windows.
        Matches notebook Step 2:  mu = X.mean(axis=(0,2))  sig = X.std(axis=(0,2))
        Returns (mu, sig) each shaped (4, 1).
        """
        if not self._zscore_windows:
            return (np.zeros((N_EEG, 1), dtype=np.float32),
                    np.ones( (N_EEG, 1), dtype=np.float32))
        stack = np.stack(self._zscore_windows, axis=0)  # (N, 4, 512)
        mu  = stack.mean(axis=(0, 2)).reshape(N_EEG, 1).astype(np.float32)  # (4, 1)
        sig = (stack.std(axis=(0, 2)) + 1e-8).reshape(N_EEG, 1).astype(np.float32)
        return mu, sig

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

        # ── 1. Downsample 256→128 Hz ──────────────────────────────────────
        win = downsample_eeg(eeg_window_256hz).astype(np.float32)  # (4, 512)
        win = np.nan_to_num(win, nan=0.0, posinf=0.0, neginf=0.0)

        # ── 2. Baseline correction ────────────────────────────────────────
        if self._user and "baseline" in self._user:
            baseline = np.asarray(self._user["baseline"])   # (4, 512)
        elif self._global_baseline is not None:
            gb = self._global_baseline
            if gb.shape == (N_EEG, WIN_MUSE):
                baseline = downsample_eeg(gb)
            elif gb.shape == (N_EEG, WIN_MODEL):
                baseline = gb
            else:
                baseline = np.zeros((N_EEG, WIN_MODEL), dtype=np.float32)
        else:
            baseline = np.zeros((N_EEG, WIN_MODEL), dtype=np.float32)

        win_corr = win - baseline  # (4, 512), still in µV scale

        # ── 3. Incremental Z-score (notebook Step 2 match) ────────────────
        # Add this window to the accumulator and recompute Z-score.
        # Notebook: mu/sig computed over ALL participant windows.
        # We replicate this by growing the accumulator each call.
        self._zscore_windows.append(win_corr.copy())
        # Recompute every 5 windows (cheap; avoids O(n²) cost per window)
        n_acc = len(self._zscore_windows)
        if n_acc % 5 == 0 or n_acc == 1:
            zmu, zsig = self._recompute_zscore()
            if self._user is not None:
                self._user["_live_zmu"]  = zmu
                self._user["_live_zsig"] = zsig

        # Use live Z-score if available, else fall back to stored calibration stats
        if self._user is not None and "_live_zmu" in self._user:
            zmu  = self._user["_live_zmu"]
            zsig = self._user["_live_zsig"]
        elif self._user and "zscore_mu" in self._user:
            zmu  = np.asarray(self._user["zscore_mu"]).reshape(N_EEG, 1).astype(np.float32)
            zsig = np.asarray(self._user["zscore_sig"]).reshape(N_EEG, 1).astype(np.float32)
        else:
            zmu  = np.zeros((N_EEG, 1), dtype=np.float32)
            zsig = np.ones( (N_EEG, 1), dtype=np.float32)

        win_z = (win_corr - zmu) / (zsig + 1e-8)  # (4, 512)
        win_z = _reject_artefacts(win_z)

        # ── 4. Feature extraction + scale ────────────────────────────────
        feat    = extract_105(win_z).reshape(1, -1)  # (1, 105)
        feat    = np.nan_to_num(feat, nan=0.0, posinf=0.0, neginf=0.0)
        feat_sc = self._scaler.transform(feat)

        # ── 5. Generic model raw probability ─────────────────────────────
        raw_prob = float(self._model.predict_proba(feat_sc)[0, 1])  # P(dislike)

        # ── 6. Isotonic recalibration (notebook Step 9) ───────────────────
        # Threshold is ALWAYS 0.5 — notebook never does a threshold sweep.
        iso = self._user.get("iso_calibrator") if self._user else None
        if iso is not None:
            prob = float(iso.predict([raw_prob])[0])
        else:
            prob = raw_prob

        threshold  = 0.5  # always — isotonic output is a true probability
        label      = "dislike" if prob >= threshold else "like"
        span       = (1.0 - threshold) if label == "dislike" else threshold
        confidence = float(min(abs(prob - threshold) / max(span, 1e-8), 1.0))

        return {
            "label":         label,
            "probability":   round(prob, 3),
            "raw_probability": round(raw_prob, 3),
            "confidence":    round(confidence, 3),
            "threshold":     round(threshold, 3),
            "calibrated":    bool(self._user and self._user.get("has_iso")),
            "n_cal_windows": int(self._user.get("n_cal_windows", 0)) if self._user else 0,
            "n_zscore_win":  n_acc,
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
        label_counts = {}
        if self._model is not None and self._scaler is not None:

            # ── 3. Feature extraction ─────────────────────────────────────
            feats = []
            for win_256 in calibration_windows:
                win = downsample_eeg(win_256).astype(np.float32)
                win = np.nan_to_num(win, nan=0.0, posinf=0.0, neginf=0.0)
                win = win - baseline_mean
                win = (win - _zmu) / (_zsig + 1e-8)
                win = _reject_artefacts(win)
                feats.append(extract_105(win))

            feats      = np.nan_to_num(np.array(feats, dtype=np.float32),
                                        nan=0.0, posinf=0.0, neginf=0.0)
            feats_sc   = self._scaler.transform(feats)
            labels_arr = np.array(labels, dtype=np.int32)
            label_counts = {
                int(k): int(v)
                for k, v in zip(*np.unique(labels_arr, return_counts=True))
            }

            # ── 4. Raw probabilities from generic model ───────────────────
            probs = self._model.predict_proba(feats_sc)[:, 1]
            print(f"  Raw prob range: [{probs.min():.3f}, {probs.max():.3f}]  "
                  f"label_counts={label_counts}")

            # ── 5. Isotonic recalibration (notebook Step 9) ───────────────
            # Threshold is ALWAYS 0.5 after isotonic — that is what the
            # notebook does.  No threshold sweep — it was not in the notebook
            # design and its output cannot be trusted on small calibration sets.
            if (len(feats_sc) >= MIN_CAL_WINDOWS_FOR_ISO
                    and len(np.unique(labels_arr)) >= 2):

                _iso_cand = IsotonicRegression(out_of_bounds="clip")
                _iso_cand.fit(probs, labels_arr)

                # Validate on a fine grid across the actual prob range
                _grid     = np.linspace(probs.min(), probs.max(), 101)
                _iso_out  = _iso_cand.predict(_grid)
                _n_unique = len(np.unique(np.round(_iso_out, 3)))
                _rng      = float(_iso_out.max() - _iso_out.min())

                # Also check that isotonic improves (or at least doesn't hurt) BA
                from sklearn.metrics import balanced_accuracy_score as _ba
                _raw_ba = _ba(labels_arr, (probs >= 0.5).astype(int))
                _iso_ba = _ba(labels_arr, (_iso_cand.predict(probs) >= 0.5).astype(int))

                print(f"  Isotonic: unique={_n_unique}  range={_rng:.3f}  "
                      f"raw_BA={_raw_ba*100:.1f}%  iso_BA={_iso_ba*100:.1f}%")

                # Accept isotonic if:
                #  (a) good resolution: ≥5 unique values, range≥0.10, no BA hurt  (normal case)
                #  (b) strong BA improvement: ≥8% gain + range≥0.20               (inverted model case)
                #      e.g. raw_BA=42% → iso_BA=56% means model is inverted for
                #      this user; isotonic flips it and must be accepted.
                _ba_gain  = _iso_ba - _raw_ba
                _accept_a = _n_unique >= 5 and _rng >= 0.10 and _ba_gain >= -0.02
                _accept_b = _ba_gain >= 0.08 and _rng >= 0.20
                if _accept_a or _accept_b:
                    iso = _iso_cand
                    reason = "good resolution" if _accept_a else "strong BA improvement (inverted model corrected)"
                    print(f"  ✓ Isotonic accepted ({reason})")
                else:
                    print(f"  ⚠ Isotonic rejected (unique={_n_unique}, range={_rng:.3f}, "
                          f"BA_gain={_ba_gain*100:+.1f}%) — using raw probs with thresh=0.5")
                    if _raw_ba <= 0.52:
                        print(f"  ⚠ NOTE: raw_BA={_raw_ba*100:.1f}% ≈ chance. "
                              f"The generic model may not transfer well to your "
                              f"EEG. Predictions will still run but may be noisy.")
            else:
                if len(np.unique(labels_arr)) < 2:
                    print(f"  ⚠ Isotonic skipped — calibration labels are all "
                          f"the same class. Need at least 1 like AND 1 dislike.")
                else:
                    print(f"  ⚠ Isotonic skipped — only {len(feats_sc)} windows "
                          f"(need ≥{MIN_CAL_WINDOWS_FOR_ISO})")
        else:
            print("  No base model available — saving baseline/Z-score stats only.")

        # ── 6. Seed the Z-score accumulator from baseline + cal windows ───
        # This ensures predict() starts with the same Z-score distribution
        # that was computed during build_user_profile.
        self._zscore_windows = []
        for _w in [baseline_corr, cal_corr] if len(cal_128) > 0 \
                   else [baseline_corr]:
            for _row in _w:
                self._zscore_windows.append(_row.copy())
        print(f"  Z-score accumulator seeded: {len(self._zscore_windows)} windows")

        # ── 7. Persist ────────────────────────────────────────────────────
        user_data: dict = {
            "baseline":        baseline_mean,
            "zscore_mu":       zscore_mu,
            "zscore_sig":      zscore_sig,
            "iso_calibrator":  iso,
            "threshold":       0.5,    # always 0.5 — notebook never changes this
            "n_cal_windows":   len(calibration_windows),
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
