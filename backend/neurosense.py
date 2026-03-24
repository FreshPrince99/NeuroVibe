"""
neurosense.py
=============
Real-time valence inference using the NeuroSense stacked ensemble model.
Replaces the Emognition like/dislike predictor — no per-user calibration required.

Inference pipeline (matches preprocess_neurosense_local.py exactly):
  1. Receive (4, 1024) EEG window at 256 Hz  [TP9, AF7, AF8, TP10]
  2. Apply 50 Hz notch + 1–45 Hz bandpass filter
  3. Per-window, per-channel z-score normalisation  (mean/std over 1024 samples)
  4. Extract 128 frequency-domain features
  5. StandardScaler transform  (fit on training split)
  6. Stacked ensemble predict_proba  → prob_negative  (0.0 = positive, 1.0 = negative)
  7. Append to 15-window rolling buffer  (~60 s of smoothing)
  8. Apply dead-zone:
       smoothed < 0.40  →  POSITIVE
       smoothed > 0.60  →  NEGATIVE
       otherwise        →  UNCERTAIN  (no action taken by player)
"""

from __future__ import annotations

import threading
import warnings
from collections import deque
from pathlib import Path

import joblib
import numpy as np
from scipy.signal import butter, coherence, iirnotch, sosfiltfilt, tf2sos, welch

# ── Model artefact paths ───────────────────────────────────────────────────────
_MODEL_DIR    = Path(__file__).parent / "neurosense_models"
ENSEMBLE_PATH = _MODEL_DIR / "neurosense_ensemble_final.joblib"
SCALER_PATH   = _MODEL_DIR / "neurosense_scaler.joblib"

# ── Signal config (must match preprocessing script) ───────────────────────────
FS           = 256
WINDOW_SAMP  = 1024       # 4 s @ 256 Hz
N_PERSEG     = 256
BP_LOW       = 1.0
BP_HIGH      = 45.0
BP_ORDER     = 4
NOTCH_HZ     = 50.0
NOTCH_Q      = 30.0

# ── Smoothing / dead-zone ──────────────────────────────────────────────────────
SMOOTH_WINDOWS      = 15    # rolling window ≈ 60 s at one prediction per 4 s
POSITIVE_THRESHOLD  = 0.40  # smoothed < 0.40 → POSITIVE
NEGATIVE_THRESHOLD  = 0.60  # smoothed > 0.60 → NEGATIVE

# ── EEG bands (same order as training) ────────────────────────────────────────
BANDS = {
    "delta": (1.0,  4.0),
    "theta": (4.0,  8.0),
    "alpha": (8.0, 13.0),
    "beta":  (13.0, 30.0),
    "gamma": (30.0, 45.0),
}
BAND_NAMES = list(BANDS.keys())
N_BANDS    = len(BAND_NAMES)
N_CH       = 4
COH_PAIRS  = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]

_BAND_CACHE: dict[bytes, dict[str, np.ndarray]] = {}


# ── Build fixed filters once at import time ────────────────────────────────────
def _build_notch_sos() -> np.ndarray:
    b, a = iirnotch(NOTCH_HZ, NOTCH_Q, FS)
    return tf2sos(b, a)


def _build_bp_sos() -> np.ndarray:
    nyq = FS / 2.0
    return butter(BP_ORDER, [BP_LOW / nyq, BP_HIGH / nyq], btype="band", output="sos")


_NOTCH_SOS = _build_notch_sos()
_BP_SOS    = _build_bp_sos()


# ── Internal helpers ───────────────────────────────────────────────────────────

def _band_idx(freqs: np.ndarray) -> dict[str, np.ndarray]:
    key = freqs.tobytes()
    if key not in _BAND_CACHE:
        _BAND_CACHE[key] = {
            name: np.where((freqs >= lo) & (freqs < hi))[0]
            for name, (lo, hi) in BANDS.items()
        }
    return _BAND_CACHE[key]


def _filter_window(win: np.ndarray) -> np.ndarray:
    """Notch + bandpass per channel.  win: (4, 1024) → float64 (4, 1024)."""
    out = np.empty_like(win, dtype=np.float64)
    for ch in range(win.shape[0]):
        x = win[ch].astype(np.float64)
        x = np.nan_to_num(x, nan=0.0)
        x = sosfiltfilt(_NOTCH_SOS, x)
        x = sosfiltfilt(_BP_SOS, x)
        out[ch] = x
    return out


def _zscore_window(win: np.ndarray) -> np.ndarray:
    """Per-channel z-score using only this window's statistics (1024 samples)."""
    mu = win.mean(axis=1, keepdims=True)
    sd = win.std(axis=1, keepdims=True) + 1e-8
    return ((win - mu) / sd).astype(np.float32)


def extract_features(win: np.ndarray) -> np.ndarray:
    """
    Extract 128 frequency-domain features from one z-scored (4, 1024) window.
    Feature order matches preprocess_neurosense_local.py::extract_features().

    Feature breakdown (128 total):
      absolute band power        4 ch × 5 bands = 20
      relative band power        4 ch × 5 bands = 20
      differential entropy       4 ch × 5 bands = 20
      alpha/beta ratio           4 ch            =  4
      theta/beta  ratio          4 ch            =  4
      theta/alpha ratio          4 ch            =  4
      FAA frontal (α, θ, β)      3 scalars       =  3
      FAA temporal (α, θ, β)     3 scalars       =  3
      Hjorth mobility            4 ch            =  4
      Hjorth complexity          4 ch            =  4
      spectral centroid          4 ch            =  4
      power spectral entropy     4 ch            =  4
      peak frequency             4 ch            =  4
      inter-channel coherence    6 pairs × 5 b   = 30
                                               ─────
                                                 128
    """
    feats: list[np.ndarray] = []

    f, psd = welch(win, fs=FS, nperseg=N_PERSEG, axis=1, scaling="density")
    bidx = _band_idx(f)
    df   = f[1] - f[0]

    # ── absolute band power ──────────────────────────────────────────────────
    bp = np.zeros((N_CH, N_BANDS), dtype=np.float64)
    for bi, name in enumerate(BAND_NAMES):
        idx = bidx[name]
        if len(idx):
            bp[:, bi] = np.trapezoid(psd[:, idx], dx=df, axis=1)
    bp_safe     = np.where(bp > 1e-12, bp, 1e-12)
    total_power = np.sum(bp_safe, axis=1, keepdims=True)
    rbp         = bp_safe / (total_power + 1e-12)

    feats.append(bp_safe.ravel())                                  # 20
    feats.append(rbp.ravel())                                      # 20
    feats.append((0.5 * np.log(2.0 * np.pi * np.e * bp_safe)).ravel())  # 20

    # ── band ratios ──────────────────────────────────────────────────────────
    i_alpha = BAND_NAMES.index("alpha")
    i_beta  = BAND_NAMES.index("beta")
    i_theta = BAND_NAMES.index("theta")

    feats.append(bp_safe[:, i_alpha] / bp_safe[:, i_beta])        # 4
    feats.append(bp_safe[:, i_theta] / bp_safe[:, i_beta])        # 4
    feats.append(bp_safe[:, i_theta] / bp_safe[:, i_alpha])       # 4

    # ── frontal & temporal alpha asymmetry (FAA) ─────────────────────────────
    af_l, af_r = 1, 2   # AF7=ch1, AF8=ch2
    tp_l, tp_r = 0, 3   # TP9=ch0, TP10=ch3
    for b in [i_alpha, i_theta, i_beta]:
        feats.append(np.array([
            np.log(bp_safe[af_r, b]) - np.log(bp_safe[af_l, b])
        ]))                                                        # 3
    for b in [i_alpha, i_theta, i_beta]:
        feats.append(np.array([
            np.log(bp_safe[tp_r, b]) - np.log(bp_safe[tp_l, b])
        ]))                                                        # 3

    # ── Hjorth parameters ────────────────────────────────────────────────────
    hj_mob = np.zeros(N_CH, dtype=np.float64)
    hj_com = np.zeros(N_CH, dtype=np.float64)
    for ch in range(N_CH):
        x  = win[ch]
        d1 = np.diff(x)
        d2 = np.diff(d1)
        v0 = np.var(x)  + 1e-12
        v1 = np.var(d1) + 1e-12
        v2 = np.var(d2) + 1e-12
        mob        = np.sqrt(v1 / v0)
        hj_mob[ch] = mob
        hj_com[ch] = np.sqrt(v2 / v1) / mob
    feats.append(hj_mob)                                           # 4
    feats.append(hj_com)                                          # 4

    # ── spectral centroid ────────────────────────────────────────────────────
    psd_sum = np.sum(psd, axis=1, keepdims=True) + 1e-12
    feats.append(np.sum(psd * f, axis=1) / psd_sum.ravel())       # 4

    # ── power spectral entropy ───────────────────────────────────────────────
    pse = np.zeros(N_CH, dtype=np.float64)
    for ch in range(N_CH):
        p = psd[ch] / (np.sum(psd[ch]) + 1e-12)
        p = np.where(p > 1e-12, p, 1e-12)
        pse[ch] = -np.sum(p * np.log(p))
    feats.append(pse)                                              # 4

    # ── peak frequency ───────────────────────────────────────────────────────
    feats.append(f[np.argmax(psd, axis=1)])                        # 4

    # ── inter-channel coherence (6 pairs × 5 bands = 30) ────────────────────
    for a, b in COH_PAIRS:
        fc, cxy = coherence(win[a], win[b], fs=FS, nperseg=N_PERSEG)
        cb = _band_idx(fc)
        for bn in BAND_NAMES:
            idx = cb[bn]
            feats.append(np.array([cxy[idx].mean() if len(idx) else 0.0]))  # 30

    return np.concatenate(feats).astype(np.float32)


# ── Public predictor class ─────────────────────────────────────────────────────

class NeuroSensePredictor:
    """
    Real-time valence predictor wrapping the NeuroSense stacked ensemble.

    Usage:
        predictor = NeuroSensePredictor()
        result = predictor.predict(window)   # window: np.ndarray (4, 1024)
    """

    def __init__(self) -> None:
        self.model  = joblib.load(ENSEMBLE_PATH)
        self.scaler = joblib.load(SCALER_PATH)
        self._buffer: deque[float] = deque(maxlen=SMOOTH_WINDOWS)
        self._lock = threading.Lock()
        print(f"[NeuroSense] Model loaded from {ENSEMBLE_PATH.name}")
        print(f"[NeuroSense] Scaler loaded from {SCALER_PATH.name}")

    @property
    def required_samples(self) -> int:
        return WINDOW_SAMP

    def predict(self, window: np.ndarray) -> dict:
        """
        Run valence inference on one 4-second EEG window.

        Parameters
        ----------
        window : np.ndarray, shape (4, 1024), dtype float32 or float64
            Raw EEG at 256 Hz, channels in order [TP9, AF7, AF8, TP10].

        Returns
        -------
        dict with keys:
            valence        : "POSITIVE" | "NEGATIVE" | "UNCERTAIN"
            smoothed_score : float  — rolling mean of prob_negative over last 15 windows
            raw_score      : float  — this window's raw prob_negative
            n_windows      : int    — how many windows are in the rolling buffer so far
        """
        win     = _filter_window(window)
        win     = _zscore_window(win)
        feats   = extract_features(win)
        feats   = np.nan_to_num(feats, nan=0.0, posinf=0.0, neginf=0.0)
        scaled  = self.scaler.transform(feats.reshape(1, -1))
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")
            prob_negative = float(self.model.predict_proba(scaled)[0][1])

        with self._lock:
            self._buffer.append(prob_negative)
            n        = len(self._buffer)
            smoothed = sum(self._buffer) / n

        if smoothed < POSITIVE_THRESHOLD:
            valence = "POSITIVE"
        elif smoothed > NEGATIVE_THRESHOLD:
            valence = "NEGATIVE"
        else:
            valence = "UNCERTAIN"

        return {
            "valence":        valence,
            "smoothed_score": round(smoothed, 4),
            "raw_score":      round(prob_negative, 4),
            "n_windows":      n,
        }

    def reset(self) -> None:
        """Clear the smoothing buffer (call on disconnect / session restart)."""
        with self._lock:
            self._buffer.clear()
