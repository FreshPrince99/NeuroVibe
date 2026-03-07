"""
Rule-based / scored state machine emotion classifier for NeuroVibe.

Classifies EEG + PPG biosignals into one of four states:
    focus | stress | relaxed | tired

No ML model is required. Band-power features are extracted from raw EEG via
Welch's PSD; frontal alpha asymmetry, theta/alpha, and beta/alpha ratios
provide the core EEG evidence. PPG-derived heart rate (BPM) and heart-rate
variability (RMSSD) provide supplementary cardiovascular evidence.

Usage
-----
predictor = RuleBasedEmotionPredictor()
emotion, scores = predictor.predict_emotion(channels_data, ppg_data=ppg_array)

    channels_data : dict with keys 'tp9', 'af7', 'af8', 'tp10' → np.ndarray
    ppg_data      : optional np.ndarray of PPG samples (~64 Hz, Muse 2)
    emotion       : str  – one of 'focus', 'stress', 'relaxed', 'tired'
    scores        : EmotionScores – raw score for each state (0–1)
"""

import numpy as np
from scipy.signal import welch, find_peaks, butter, filtfilt
from dataclasses import dataclass, asdict
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

EEG_SAMPLE_RATE: int = 256          # Hz
PPG_SAMPLE_RATE: int = 64           # Hz  (Muse 2 PPG)
REQUIRED_SAMPLES: int = 1280        # 5 s of EEG @ 256 Hz

FREQ_BANDS = {
    "delta": (0.5, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta":  (13.0, 30.0),
    "gamma": (30.0, 50.0),
}

EMOTIONS = ("focus", "stress", "relaxed", "tired")


# ─────────────────────────────────────────────────────────────────────────────
# Data containers
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class EmotionScores:
    """Normalised evidence score (0–1) for each emotion state."""
    focus:   float
    stress:  float
    relaxed: float
    tired:   float

    def as_dict(self) -> dict:
        return {
            "focus":   round(self.focus,   3),
            "stress":  round(self.stress,  3),
            "relaxed": round(self.relaxed, 3),
            "tired":   round(self.tired,   3),
        }

    @property
    def dominant(self) -> str:
        d = self.as_dict()
        return max(d, key=d.get)  # type: ignore[arg-type]


@dataclass
class PPGFeatures:
    available: bool
    bpm:   Optional[float] = None   # beats per minute
    rmssd: Optional[float] = None   # ms  (root-mean-square of successive RR diffs)


# ─────────────────────────────────────────────────────────────────────────────
# Feature extraction helpers
# ─────────────────────────────────────────────────────────────────────────────

def _band_power(signal: np.ndarray, fs: int, low: float, high: float) -> float:
    """Area under the Welch PSD curve between *low* and *high* Hz."""
    nperseg = min(len(signal), fs * 2)          # at most 2-s window
    freqs, psd = welch(signal, fs=fs, nperseg=nperseg, average="mean")
    mask = (freqs >= low) & (freqs < high)
    return float(np.trapezoid(psd[mask], freqs[mask]))


def extract_eeg_features(channels_data: dict, fs: int = EEG_SAMPLE_RATE) -> dict:
    """
    Compute per-channel band powers and frontal composite indices.

    Returns a flat dict of floats.
    """
    features: dict = {}
    ch_names = ("tp9", "af7", "af8", "tp10")

    for ch in ch_names:
        sig = np.asarray(channels_data[ch], dtype=np.float64)
        # Z-score normalise → removes DC offset and amplitude scale differences
        sig = (sig - sig.mean()) / (sig.std() + 1e-8)
        for band, (lo, hi) in FREQ_BANDS.items():
            features[f"{ch}_{band}"] = _band_power(sig, fs, lo, hi)

    # Frontal mean (AF7 + AF8 average for each band)
    for band in FREQ_BANDS:
        features[f"frontal_{band}"] = (
            features[f"af7_{band}"] + features[f"af8_{band}"]
        ) / 2.0

    # ── Frontal Alpha Asymmetry (FAA) ─────────────────────────────────────
    # Defined as ln(AF8_alpha) – ln(AF7_alpha)
    # Positive FAA  → right-frontal dominance → withdrawal / stress
    # Negative FAA  → left-frontal dominance  → approach  / positive affect
    af7_a = max(features["af7_alpha"], 1e-8)
    af8_a = max(features["af8_alpha"], 1e-8)
    features["frontal_alpha_asymmetry"] = float(np.log(af8_a) - np.log(af7_a))

    # ── Derived ratios (frontal) ──────────────────────────────────────────
    fa = features["frontal_alpha"] + 1e-8
    fb = features["frontal_beta"]  + 1e-8
    ft = features["frontal_theta"] + 1e-8

    features["theta_alpha_ratio"] = ft / fa          # high → drowsy / tired
    features["beta_alpha_ratio"]  = fb / fa          # high → activated / stress-focus
    features["theta_beta_ratio"]  = ft / fb          # high → fatigue

    # ── Global means across all four channels ────────────────────────────
    for band in FREQ_BANDS:
        features[f"mean_{band}"] = float(
            np.mean([features[f"{c}_{band}"] for c in ch_names])
        )

    return features


def extract_ppg_features(
    ppg_array,
    fs: int = PPG_SAMPLE_RATE,
) -> PPGFeatures:
    """
    Derive BPM and RMSSD from a raw PPG signal.

    Requires at least 2 seconds of data. Returns PPGFeatures(available=False)
    if the signal is absent or too noisy for reliable peak detection.
    """
    if ppg_array is None:
        return PPGFeatures(available=False)

    arr = np.asarray(ppg_array, dtype=np.float64)
    if arr.size < int(4 * fs):
        return PPGFeatures(available=False)

    try:
        arr = (arr - arr.mean()) / (arr.std() + 1e-8)

        # Band-pass filter for typical heart rates (0.7–3.0 Hz ≈ 42–180 bpm)
        try:
            b, a = butter(2, [0.7, 3.0], btype="bandpass", fs=fs)
            filt = filtfilt(b, a, arr)
        except Exception:
            filt = arr

        filt = (filt - filt.mean()) / (filt.std() + 1e-8)
        min_dist = int(0.35 * fs)  # ≥ 350 ms between peaks
        prominence = 0.4 * np.std(filt)
        peaks, _ = find_peaks(filt, distance=min_dist, prominence=prominence)

        if len(peaks) < 3:
            return PPGFeatures(available=False)

        rri_s = np.diff(peaks).astype(float) / fs
        rri_s = rri_s[(rri_s > 0.3) & (rri_s < 2.0)]
        if len(rri_s) < 3:
            return PPGFeatures(available=False)

        bpm = float(60.0 / np.median(rri_s))
        if not (30.0 < bpm < 200.0):
            return PPGFeatures(available=False)

        cv = rri_s.std() / (rri_s.mean() + 1e-8)
        if cv > 0.40:
            return PPGFeatures(available=False)

        rmssd = float(np.sqrt(np.mean(np.diff(rri_s * 1000.0) ** 2)))  # ms
        return PPGFeatures(available=True, bpm=round(bpm, 1), rmssd=round(rmssd, 2))
    except Exception:
        return PPGFeatures(available=False)


# ─────────────────────────────────────────────────────────────────────────────
# Scored state machine
# ─────────────────────────────────────────────────────────────────────────────

class RuleBasedEmotionPredictor:
    """
    Scored state machine that maps EEG + optional PPG features to one of:
        focus | stress | relaxed | tired

    Each emotion accumulates weighted evidence from individual features.
    The emotion with the highest total score wins, subject to a short
    temporal-smoothing history (majority vote over the last N predictions).

    If a baseline EEG recording is provided during init, personalised thresholds
    are computed from it. Otherwise, generic thresholds are used.

    Scoring rationale
    -----------------
    focus   : elevated beta & gamma, moderate alpha, low theta
    stress  : high beta, low alpha, right-biased frontal asymmetry, high HR, low HRV
    relaxed : high alpha, low beta, left-biased frontal asymmetry, normal HR, high HRV
    tired   : high theta & delta, high theta/alpha ratio, low HR
    """

    # How many recent predictions to use for majority-vote smoothing
    HISTORY_WINDOW: int = 5

    # Buffer size that the server should accumulate before calling predict_emotion
    required_samples: int = REQUIRED_SAMPLES

    def __init__(
        self,
        history_window: int = 5,
        baseline_channels: Optional[dict] = None,
    ) -> None:
        """
        Parameters
        ----------
        history_window : int
            Number of recent predictions to use for majority-vote smoothing.
        baseline_channels : dict or None
            If provided, extract baseline features and compute personalised thresholds.
            Keys: 'tp9', 'af7', 'af8', 'tp10' → np.ndarray
        """
        self.HISTORY_WINDOW = history_window
        self._history: list[str] = []
        
        # Baseline features (computed if baseline is provided)
        self._baseline_features: Optional[dict] = None
        
        # Personalised thresholds for this user's brain
        self._thresholds = self._generic_thresholds()
        
        if baseline_channels is not None:
            self._compute_baseline_thresholds(baseline_channels)
    
    @staticmethod
    def _generic_thresholds() -> dict:
        """
        Hardcoded generic thresholds used when no baseline is available.
        These are tuned for typical adult EEG on Muse 2.
        """
        return {
            # Relative band power thresholds (as fraction of total)
            "alpha_threshold":         0.16,      # relaxed if > 16%
            "beta_threshold":          0.12,      # focused if > 12%
            "theta_threshold":         0.30,      # tired if > 30% (global)
            "gamma_threshold":         0.04,      # some focus if > 4%
            "theta_alpha_ratio":       2.5,       # tired if > 2.5
            "beta_alpha_ratio":        1.2,       # focused if > 1.2
            # Asymmetry thresholds (log difference)
            "faa_stress":              0.8,       # positive FAA > 0.8 → stress
            "faa_calm":               -0.8,       # negative FAA < -0.8 → calm
            # Heart rate thresholds
            "hr_very_high":           110.0,      # > 110 bpm → stress/exercise
            "hr_high":                 90.0,      # > 90 bpm → moderately activated
            "hr_normal_high":          80.0,      # > 80 bpm → mildly elevated
            "hr_low":                  70.0,      # < 70 bpm → resting
            "hr_very_low":             60.0,      # < 60 bpm → drowsy
            # HRV thresholds
            "rmssd_very_high":        60.0,       # > 60 ms → high parasympathetic
            "rmssd_high":             40.0,       # > 40 ms → parasympathetic
            "rmssd_moderate":         25.0,       # > 25 ms → balanced
            "rmssd_low":              15.0,       # < 15 ms → sympathetic
        }
    
    def _compute_baseline_thresholds(self, baseline_channels: dict) -> None:
        """
        Extract features from baseline EEG and compute personalised thresholds.
        
        Baseline should be a 2.5–3 minute quiet rest recording.
        """
        self._baseline_features = extract_eeg_features(baseline_channels)
        baseline = self._baseline_features
        
        # Extract key metrics from baseline
        alpha_baseline = baseline["mean_alpha"]
        beta_baseline  = baseline["mean_beta"]
        theta_baseline = baseline["mean_theta"]
        delta_baseline = baseline["mean_delta"]
        gamma_baseline = baseline["mean_gamma"]
        faa_baseline   = baseline["frontal_alpha_asymmetry"]
        thr_baseline   = baseline["theta_alpha_ratio"]
        bar_baseline   = baseline["beta_alpha_ratio"]
        
        # Compute total for relative power
        total = alpha_baseline + beta_baseline + theta_baseline + delta_baseline + gamma_baseline + 1e-8
        
        # Relative powers
        ra_base = alpha_baseline / total
        rb_base = beta_baseline / total
        rt_base = theta_baseline / total
        rg_base = gamma_baseline / total
        
        # Personalised thresholds: set ABOVE the baseline rest values so a
        # genuine state change is required to score highly.
        #
        # alpha: relaxed scores when alpha exceeds rest by ~50%.
        #        Using 1.5× ensures the threshold isn't trivially reached
        #        at rest while still being reachable during genuine relaxation.
        # beta:  focus/stress score when beta is 30% above resting beta.
        # theta: tired scores when theta is 40% above resting theta.
        # FAA:   stress/calm require FAA to exceed baseline magnitude by 0.5
        #        (a meaningful directional shift, not random EEG noise).
        self._thresholds = {
            "alpha_threshold":         max(0.06, ra_base + ra_base * 0.50),  # 50% above baseline
            "beta_threshold":          max(0.08, rb_base + rb_base * 0.30),  # 30% above baseline
            "theta_threshold":         max(0.25, rt_base + rt_base * 0.40),  # 40% above baseline
            "gamma_threshold":         max(0.02, rg_base + rg_base * 0.50),  # 50% above baseline
            "theta_alpha_ratio":       thr_baseline + 0.5,
            "beta_alpha_ratio":        bar_baseline + 0.3,
            # FAA thresholds: symmetric, require a real directional shift
            "faa_stress":              max(0.3, abs(faa_baseline) + 0.5),
            "faa_calm":               -max(0.3, abs(faa_baseline) + 0.5),
            # Heart rate / HRV: use generic (PPG not typically recorded during baseline)
            "hr_very_high":           110.0,
            "hr_high":                 90.0,
            "hr_normal_high":          80.0,
            "hr_low":                  70.0,
            "hr_very_low":             60.0,
            "rmssd_very_high":        60.0,
            "rmssd_high":             40.0,
            "rmssd_moderate":         25.0,
            "rmssd_low":              15.0,
        }
        
        print("[OK] Personalised emotion thresholds computed from baseline:")
        print(f"  Alpha threshold:       {self._thresholds['alpha_threshold']:.3f} (baseline={ra_base:.3f})")
        print(f"  Beta threshold:        {self._thresholds['beta_threshold']:.3f} (baseline={rb_base:.3f})")
        print(f"  Theta/Alpha ratio:     {self._thresholds['theta_alpha_ratio']:.3f} (baseline={thr_baseline:.3f})")
        print(f"  FAA stress threshold:  {self._thresholds['faa_stress']:.3f} (baseline={faa_baseline:.3f})")
        print(f"  FAA calm threshold:    {self._thresholds['faa_calm']:.3f}")

    # ── internal scoring ──────────────────────────────────────────────────

    def _score(self, eeg: dict, ppg: PPGFeatures) -> EmotionScores:
        """
        Compute a [0, 1] score for each emotion from feature evidence.
        Uses personalised thresholds if baseline was provided, otherwise generic.
        """
        sc = {e: 0.0 for e in EMOTIONS}
        t = self._thresholds  # shorthand for threshold dict

        # Convenience aliases
        alpha  = eeg["mean_alpha"]
        beta   = eeg["mean_beta"]
        theta  = eeg["mean_theta"]
        delta  = eeg["mean_delta"]
        gamma  = eeg["mean_gamma"]
        faa    = eeg["frontal_alpha_asymmetry"]
        thr    = eeg["theta_alpha_ratio"]
        bar    = eeg["beta_alpha_ratio"]

        total = alpha + beta + theta + delta + gamma + 1e-8
        ra = alpha / total     # relative alpha
        rb = beta  / total     # relative beta
        rt = theta / total     # relative theta
        rg = gamma / total     # relative gamma

        # ── FOCUS ─────────────────────────────────────────────────────────
        # Evidence for: elevated beta, high beta/alpha, low theta/alpha,
        # and BALANCED FAA (neither left nor right — frontal symmetry)
        # KEY differentiator from stress: focus has |FAA| near zero
        sc["focus"] += 0.28 * min(rb / t["beta_threshold"], 1.0)
        sc["focus"] += 0.22 * min(bar / t["beta_alpha_ratio"], 1.0)
        sc["focus"] += 0.18 * max(0.0, 1.0 - thr / max(t["theta_alpha_ratio"] * 2.0, 2.0))
        sc["focus"] += 0.12 * min(rg / t["gamma_threshold"], 1.0)
        # Frontal balance: score drops off as FAA magnitude grows
        sc["focus"] += 0.20 * max(0.0, 1.0 - abs(faa) / max(t["faa_stress"], 0.5))

        # ── STRESS ────────────────────────────────────────────────────────
        # Evidence for: elevated beta, alpha SUPPRESSION, POSITIVE FAA
        # (right-frontal dominance = withdrawal affect = stress/anxiety)
        # KEY differentiator from focus: requires positive FAA
        sc["stress"] += 0.22 * min(rb / t["beta_threshold"], 1.0)
        sc["stress"] += 0.38 * min(max(faa, 0.0) / max(t["faa_stress"], 0.5), 1.0)
        sc["stress"] += 0.28 * max(0.0, 1.0 - ra / t["alpha_threshold"])
        sc["stress"] += 0.12 * min(bar / (t["beta_alpha_ratio"] + 0.8), 1.0)

        # ── RELAXED ───────────────────────────────────────────────────────
        # Evidence for: elevated alpha, low beta, NEGATIVE FAA
        # (left-frontal dominance = approach affect = positive/calm)
        sc["relaxed"] += 0.35 * min(ra / t["alpha_threshold"], 1.0)
        sc["relaxed"] += 0.30 * min(max(-faa, 0.0) / max(abs(t["faa_calm"]), 0.5), 1.0)
        sc["relaxed"] += 0.15 * max(0.0, 1.0 - thr / max(t["theta_alpha_ratio"] * 1.5, 2.0))
        sc["relaxed"] += 0.12 * max(0.0, 1.0 - rb / t["beta_threshold"])
        sc["relaxed"] += 0.08 * max(0.0, 1.0 - rt / t["theta_threshold"])

        # ── TIRED ─────────────────────────────────────────────────────────
        # Evidence for: high theta, high theta/alpha ratio, low beta.
        # Additive scoring — no multiplicative gate that collapses to ~0.
        # A drowsy-but-awake state has moderate beta and still fires theta.
        sc["tired"] += 0.40 * min(thr / max(t["theta_alpha_ratio"], 2.0), 1.0)
        sc["tired"] += 0.35 * min(rt  / max(t["theta_threshold"],   0.25), 1.0)
        sc["tired"] += 0.15 * max(0.0, 1.0 - rb / t["beta_threshold"])
        sc["tired"] += 0.10 * max(0.0, 1.0 - ra / t["alpha_threshold"])

        # ── PPG / cardiovascular adjustments ──────────────────────────────
        if ppg.available and ppg.bpm is not None and ppg.rmssd is not None:
            bpm   = ppg.bpm
            rmssd = ppg.rmssd

            if bpm > t["hr_very_high"]:
                sc["stress"]  += 0.40
                sc["focus"]   += 0.10
                sc["tired"]   -= 0.40
                sc["relaxed"] -= 0.20
            elif bpm > t["hr_high"]:
                sc["stress"]  += 0.22
                sc["focus"]   += 0.08
                sc["tired"]   -= 0.20
                sc["relaxed"] -= 0.10
            elif bpm > t["hr_normal_high"]:
                sc["stress"]  += 0.12
                sc["focus"]   += 0.06
                sc["tired"]   -= 0.08
            elif bpm < t["hr_very_low"]:
                sc["tired"]   += 0.15
                sc["relaxed"] += 0.08
            elif bpm < t["hr_low"]:
                sc["tired"]   += 0.06
                sc["relaxed"] += 0.08

            if rmssd > t["rmssd_very_high"]:
                sc["relaxed"] += 0.18
                sc["stress"]  -= 0.10
            elif rmssd > t["rmssd_high"]:
                sc["relaxed"] += 0.12
                sc["stress"]  -= 0.04
            elif rmssd > t["rmssd_moderate"]:
                sc["relaxed"] += 0.06
                sc["tired"]   -= 0.04
            elif rmssd < t["rmssd_low"]:
                sc["stress"]  += 0.18
                sc["relaxed"] -= 0.10
                sc["tired"]   -= 0.05
            elif rmssd < t["rmssd_moderate"]:
                sc["stress"]  += 0.10
                sc["relaxed"] -= 0.05

            if rmssd < (t["rmssd_moderate"] - 5.0) and bpm > t["hr_high"]:
                sc["stress"]  += 0.15
                sc["relaxed"] -= 0.08
                sc["tired"]   -= 0.08
            elif rmssd > t["rmssd_high"] and bpm < t["hr_low"]:
                sc["relaxed"] += 0.10
                sc["stress"]  -= 0.05

        # Clamp all scores to [0, 1]
        for k in sc:
            sc[k] = max(0.0, min(1.0, sc[k]))

        return EmotionScores(
            focus=sc["focus"],
            stress=sc["stress"],
            relaxed=sc["relaxed"],
            tired=sc["tired"],
        )

    # ── public API ────────────────────────────────────────────────────────

    def predict_emotion(
        self,
        channels_data: dict,
        ppg_data: Optional[np.ndarray] = None,
    ) -> tuple[str, EmotionScores]:
        """
        Predict the current emotional state from EEG (and optionally PPG).

        Parameters
        ----------
        channels_data : dict
            Keys: 'tp9', 'af7', 'af8', 'tp10' → np.ndarray of shape (N,)
            where N == required_samples (1280 samples / 5 s at 256 Hz).
        ppg_data : np.ndarray or None
            Raw PPG signal sampled at ~64 Hz. Pass None if unavailable.

        Returns
        -------
        emotion : str
            Dominant emotion after temporal smoothing.
        scores : EmotionScores
            Raw per-emotion scores for the current window (before smoothing).
        """
        eeg_features = extract_eeg_features(channels_data)
        ppg_features = extract_ppg_features(ppg_data)
        scores       = self._score(eeg_features, ppg_features)

        raw_dominant = scores.dominant

        # Temporal smoothing: majority vote over the last HISTORY_WINDOW predictions
        self._history.append(raw_dominant)
        if len(self._history) > self.HISTORY_WINDOW:
            self._history.pop(0)

        counts: dict[str, int] = {}
        for e in self._history:
            counts[e] = counts.get(e, 0) + 1
        emotion = max(counts, key=counts.get)  # type: ignore[arg-type]

        return emotion, scores

    def reset(self) -> None:
        """Clear prediction history (call on new session / reconnect)."""
        self._history.clear()

    def get_history(self) -> list[str]:
        """Return a copy of the recent emotion history used for smoothing."""
        return list(self._history)
