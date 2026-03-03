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

    Scoring rationale
    -----------------
    focus   : elevated beta & gamma, moderate alpha, low theta
    stress  : high beta, low alpha, right-biased frontal asymmetry, high HR, low HRV
    relaxed : high alpha, low beta, left-biased frontal asymmetry, normal HR, high HRV
    tired   : high theta & delta, high theta/alpha ratio, low HR
    """

    # How many recent predictions to use for majority-vote smoothing
    HISTORY_WINDOW: int = 3

    # Buffer size that the server should accumulate before calling predict_emotion
    required_samples: int = REQUIRED_SAMPLES

    def __init__(self, history_window: int = 3) -> None:
        self.HISTORY_WINDOW = history_window
        self._history: list[str] = []

    # ── internal scoring ──────────────────────────────────────────────────

    def _score(self, eeg: dict, ppg: PPGFeatures) -> EmotionScores:
        """
        Compute a [0, 1] score for each emotion from feature evidence.
        Scores are not normalised across emotions — the dominant emotion is
        the one with the highest absolute score.
        """
        sc = {e: 0.0 for e in EMOTIONS}

        # Convenience aliases
        alpha  = eeg["mean_alpha"]
        beta   = eeg["mean_beta"]
        theta  = eeg["mean_theta"]
        delta  = eeg["mean_delta"]
        gamma  = eeg["mean_gamma"]
        faa    = eeg["frontal_alpha_asymmetry"]   # + → stress, – → calm
        thr    = eeg["theta_alpha_ratio"]
        bar    = eeg["beta_alpha_ratio"]

        total = alpha + beta + theta + delta + gamma + 1e-8

        # Relative (fractional) band powers, more robust than absolute values
        # Typical Muse ranges (awake, normal): delta 35-45%, theta 20-30%,
        # alpha 10-18%, beta 8-14%, gamma 1-5%. Thresholds are calibrated to
        # these realistic ranges — NOT idealized textbook values.
        ra = alpha / total     # relative alpha
        rb = beta  / total     # relative beta
        rt = theta / total     # relative theta
        rg = gamma / total     # relative gamma
        # delta / total is intentionally excluded — chronically elevated on Muse

        # ── FOCUS ─────────────────────────────────────────────────────────
        # Evidence for: elevated beta (>10%), high beta/alpha, low theta/alpha
        sc["focus"] += 0.32 * min(rb  / 0.12, 1.0)               # beta > 12 %
        sc["focus"] += 0.22 * min(bar / 1.2,  1.0)               # beta/alpha > 1.2
        sc["focus"] += 0.20 * max(0.0, 1.0 - thr / 2.5)          # theta/alpha < 2.5
        sc["focus"] += 0.12 * min(rg  / 0.04, 1.0)               # some gamma
        sc["focus"] += 0.14 * max(0.0, 1.0 - abs(faa) / 1.2)    # symmetric FAA

        # ── STRESS ────────────────────────────────────────────────────────
        # Evidence for: elevated beta, alpha suppression, positive FAA
        sc["stress"] += 0.32 * min(rb  / 0.12, 1.0)
        sc["stress"] += 0.28 * min(max(faa,  0.0) / 0.8, 1.0)    # positive FAA → stress
        sc["stress"] += 0.28 * max(0.0, 1.0 - ra / 0.12)         # alpha suppression
        sc["stress"] += 0.12 * min(bar / 2.0,  1.0)              # high beta/alpha

        # ── RELAXED ───────────────────────────────────────────────────────
        # Evidence for: elevated alpha (>15%), low beta, negative FAA
        sc["relaxed"] += 0.36 * min(ra  / 0.16, 1.0)             # alpha > 16 %
        sc["relaxed"] += 0.28 * min(max(-faa, 0.0) / 0.8, 1.0)   # negative FAA → calm
        sc["relaxed"] += 0.18 * max(0.0, 1.0 - thr / 2.0)        # low theta/alpha
        sc["relaxed"] += 0.10 * max(0.0, 1.0 - rb  / 0.12)       # low beta
        sc["relaxed"] += 0.08 * max(0.0, 1.0 - rt  / 0.30)       # low theta

        # ── TIRED ─────────────────────────────────────────────────────────
        # Tired = high theta/alpha AND genuinely LOW beta.
        # Key discriminator: elevated beta means the brain is ACTIVATED (alert/stress/focus),
        # which is incompatible with fatigue. Gate the entire tired score by beta activity.
        #   fatigue_gate → 1.0 when rb = 0   (no beta → could be tired)
        #   fatigue_gate → 0.0 when rb ≥ 10% (beta present → clearly awake/activated)
        fatigue_gate    = max(0.0, 1.0 - min(rb / 0.10, 1.0))
        # alpha_supp_gate: suppresses tired when alpha is reasonably present (relaxed state)
        # At ra=16% gate=0 (no tired); at ra=8% gate=0.5; at ra=0 gate=1.0
        alpha_supp_gate = max(0.0, 1.0 - min(ra / 0.16, 1.0))
        tired_gate      = fatigue_gate * alpha_supp_gate           # BOTH conditions required
        sc["tired"] += 0.45 * min(thr / 3.0, 1.0) * tired_gate   # thr > 3 AND low beta AND low alpha
        sc["tired"] += 0.35 * min(rt  / 0.35, 1.0) * tired_gate  # high theta AND low beta AND low alpha
        sc["tired"] += 0.20 * max(0.0, 1.0 - ra  / 0.10)         # extreme alpha suppression (<10% only)

        # ── PPG / cardiovascular adjustments ──────────────────────────────
        # HR is a STRONG physiological signal — weight it heavily.
        # Physical exercise (push-ups, running) drives HR to 100–170 bpm.
        # That clearly contradicts "tired" and strongly suggests stress/arousal.
        if ppg.available and ppg.bpm is not None and ppg.rmssd is not None:
            bpm   = ppg.bpm
            rmssd = ppg.rmssd

            # ── Heart Rate contribution ────────────────────────────────────
            if bpm > 110:
                # Very high HR (exercise / acute stress) — hard override
                sc["stress"]  += 0.40
                sc["focus"]   += 0.10
                sc["tired"]   -= 0.40   # physiologically incompatible with fatigue
                sc["relaxed"] -= 0.20
            elif bpm > 90:
                # Moderately elevated HR — likely activated state
                sc["stress"]  += 0.22
                sc["focus"]   += 0.08
                sc["tired"]   -= 0.20
                sc["relaxed"] -= 0.10
            elif bpm > 80:
                # Mildly elevated HR
                sc["stress"]  += 0.12
                sc["focus"]   += 0.06
                sc["tired"]   -= 0.08
            elif bpm < 60:
                # Very low HR — likely resting / drowsy
                sc["tired"]   += 0.15
                sc["relaxed"] += 0.08
            elif bpm < 70:
                # Low-normal HR → lean toward relaxed over tired
                sc["tired"]   += 0.06
                sc["relaxed"] += 0.08

            # ── HRV (RMSSD) contribution ───────────────────────────────────
            # High HRV  = parasympathetic dominance → relaxed / resting
            # Low HRV   = sympathetic dominance → stress / high arousal
            if rmssd > 60:
                sc["relaxed"] += 0.18
                sc["stress"]  -= 0.10
            elif rmssd > 40:
                sc["relaxed"] += 0.12
                sc["stress"]  -= 0.04
            elif rmssd > 25:
                # Moderate HRV — mildly parasympathetic, lean relaxed over tired
                sc["relaxed"] += 0.06
                sc["tired"]   -= 0.04
            elif rmssd < 15:
                sc["stress"]  += 0.18
                sc["relaxed"] -= 0.10
                sc["tired"]   -= 0.05   # low HRV + (probably) high HR → not tired
            elif rmssd < 25:
                sc["stress"]  += 0.10
                sc["relaxed"] -= 0.05

            # Combined HR + HRV cues
            if rmssd < 20 and bpm > 85:
                sc["stress"]  += 0.15
                sc["relaxed"] -= 0.08
                sc["tired"]   -= 0.08
            elif rmssd > 50 and bpm < 75:
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
