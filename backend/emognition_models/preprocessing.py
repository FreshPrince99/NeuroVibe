"""
build_emognition_full.py
========================
Creates  emognition_full.npz  —  a multimodal dataset from the Emognition
Muse 2 recordings that includes EEG, Accelerometer, and Gyroscope signals.

Channel layout in output  X  array  (axis 1):
  0-3  : EEG   [TP9, AF7, AF8, TP10]       (256 Hz → downsampled to 128 Hz)
  4-6  : ACC   [Accelerometer_X/Y/Z]        (native rate → resampled → 128 Hz)
  7-9  : GYRO  [Gyro_X/Y/Z]                (native rate → resampled → 128 Hz)

Output  X  shape : (N, 10, 512)             — 4-second windows at 128 Hz

SAM binary labels
  Like    (0)  : SAM valence >= 7
  Dislike (1)  : SAM valence <= 3
  Dropped      : SAM valence 4-6  (ambiguous — excluded from training)

NPZ keys
  X              (N, 10, 512)  float32  — multimodal windows
  y_vad          (N,  3)       float32  — [valence, arousal, dominance] raw
  y_binary       (N,)          int8     — 0=Like, 1=Dislike
  participant_id (N,)          int16
  emotion        (N,)          str
  X_base         (M, 10, 512)  float32  — BASELINE windows, same layout
  base_pid       (M,)          int16
"""

import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import butter, iirnotch, sosfiltfilt, resample_poly
from scipy.signal import tf2sos

# ── Configuration ──────────────────────────────────────────────────────────
BASE_DIR         = Path(__file__).parent
DATA_DIR         = BASE_DIR / "_study_data"
COMPLETENESS_CSV = BASE_DIR / "data_completness.csv"
OUTPUT_NPZ       = BASE_DIR / "emognition_full.npz"

FS_IN   = 256           # Muse 2 EEG native rate (Hz)
FS_OUT  = 128           # Target rate after downsampling
WIN_SEC = 4.0           # Window length (s)
STEP_FRAC = 0.5         # 50 % overlap

WIN_SAMP_IN  = int(WIN_SEC * FS_IN)    # 1024
STEP_SAMP_IN = int(WIN_SAMP_IN * (1 - STEP_FRAC))   # 512
WIN_SAMP_OUT = int(WIN_SEC * FS_OUT)   # 512

MIN_HEADBAND_ON = 0.5

EEG_CHANNELS  = ["RAW_TP9", "RAW_AF7", "RAW_AF8", "RAW_TP10"]
ACC_CHANNELS  = ["Accelerometer_X", "Accelerometer_Y", "Accelerometer_Z"]
GYRO_CHANNELS = ["Gyro_X", "Gyro_Y", "Gyro_Z"]

NOTCH_FREQ = 50.0;  NOTCH_Q  = 30.0
BP_LOW     = 1.0;   BP_HIGH  = 40.0;  BP_ORDER = 4

LIKE_THRESH    = 7
DISLIKE_THRESH = 3

STIMULUS_EMOTIONS = [
    "AWE", "DISGUST", "SURPRISE", "ANGER", "ENTHUSIASM",
    "LIKING", "FEAR", "AMUSEMENT", "SADNESS", "NEUTRAL",
]
BASELINE_EMOTION = "BASELINE"

# ── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[logging.StreamHandler()],
)
log = logging.getLogger(__name__)


# ── Filter builders ────────────────────────────────────────────────────────
def _notch_sos(fs):
    b, a = iirnotch(NOTCH_FREQ, NOTCH_Q, fs)
    return tf2sos(b, a)

def _bp_sos(fs):
    nyq = fs / 2.0
    return butter(BP_ORDER, [BP_LOW / nyq, BP_HIGH / nyq],
                  btype="band", output="sos")


# ── Signal utilities ───────────────────────────────────────────────────────
def _interp_nans(sig):
    """Linear-interpolate NaNs in a 1-D array."""
    if not np.any(np.isnan(sig)):
        return sig
    x = np.arange(len(sig))
    ok = ~np.isnan(sig)
    return np.interp(x, x[ok], sig[ok]) if ok.any() else np.zeros_like(sig)


def _resample_to_length(sig, target_len):
    """Resample 1-D array to exactly target_len via linear interpolation."""
    if len(sig) == target_len:
        return sig
    x_old = np.linspace(0.0, 1.0, len(sig))
    x_new = np.linspace(0.0, 1.0, target_len)
    return np.interp(x_new, x_old, sig)


def _segment(array, win, step):
    """(C, T) → (n_windows, C, win)"""
    _, T = array.shape
    if T < win:
        return np.empty((0, array.shape[0], win), dtype=np.float32)
    starts = range(0, T - win + 1, step)
    return np.stack([array[:, s:s + win] for s in starts]).astype(np.float32)


def _downsample_2to1(windows):
    """(N, C, 1024) → (N, C, 512) via resample_poly 1:2."""
    N, C, _ = windows.shape
    out = np.zeros((N, C, WIN_SAMP_OUT), dtype=np.float32)
    for c in range(C):
        for n in range(N):
            out[n, c] = resample_poly(windows[n, c], 1, 2).astype(np.float32)
    return out


# ── Load one MUSE JSON file ───────────────────────────────────────────────
def load_muse_file(filepath):
    """
    Returns (array, ok):
      array : (10, n_eeg_samples) float32  — [EEG×4, ACC×3, GYRO×3]
      ok    : False if any required channel is missing
    """
    if not filepath.exists():
        return None, False

    with open(filepath, "r") as f:
        raw = json.load(f)

    # ── EEG ─────────────────────────────────────────────────────────────
    eeg_channels = []
    for ch in EEG_CHANNELS:
        if ch not in raw:
            return None, False
        eeg_channels.append(np.array(raw[ch], dtype=np.float64))

    lengths = [len(c) for c in eeg_channels]
    eeg_len = min(lengths)
    eeg_channels = [c[:eeg_len] for c in eeg_channels]

    notch_sos = _notch_sos(FS_IN)
    bp_sos    = _bp_sos(FS_IN)
    eeg_clean = []
    for ch in eeg_channels:
        ch = _interp_nans(ch)
        ch = sosfiltfilt(notch_sos, ch)
        ch = sosfiltfilt(bp_sos,    ch)
        eeg_clean.append(ch.astype(np.float32))

    # ── ACC / GYRO (resample to EEG length) ─────────────────────────────
    inertial = []
    for ch_name in ACC_CHANNELS + GYRO_CHANNELS:
        if ch_name not in raw:
            # Channel absent in this file — fill with zeros
            inertial.append(np.zeros(eeg_len, dtype=np.float32))
            continue
        sig = np.array(raw[ch_name], dtype=np.float64)
        sig = _interp_nans(sig)
        sig = _resample_to_length(sig, eeg_len)
        inertial.append(sig.astype(np.float32))

    combined = np.stack(eeg_clean + inertial, axis=0)  # (10, eeg_len)
    return combined, True


# ── Load VAD labels ────────────────────────────────────────────────────────
def load_vad(questionnaire_path, emotion):
    if not questionnaire_path.exists():
        return None
    with open(questionnaire_path, "r") as f:
        data = json.load(f)
    for entry in data.get("questionnaires", []):
        if entry.get("movie") == emotion:
            sam = entry.get("sam", {})
            v = sam.get("VALENCE");  a = sam.get("AROUSAL")
            d = sam.get("MOTIVATION")
            if None in (v, a, d):
                return None
            return float(v), float(a), float(d)
    return None


# ── Completeness table ─────────────────────────────────────────────────────
def load_completeness():
    df = pd.read_csv(COMPLETENESS_CSV)
    df.columns = df.columns.str.strip()
    out = {}
    for _, row in df.iterrows():
        pid     = int(row["UID"])
        emotion = str(row["Film"]).strip().upper()
        raw     = row["Muse 2"]
        if pd.isna(raw) or str(raw).strip() == "":
            score = None
        else:
            try:
                score = float(raw)
            except ValueError:
                score = None
        out[(pid, emotion)] = score
    return out


# ── Main ───────────────────────────────────────────────────────────────────
def build():
    log.info("=" * 65)
    log.info("Emognition Full Build  (EEG + ACC + GYRO)")
    log.info("  Output channels: [TP9, AF7, AF8, TP10, Ax, Ay, Az, Gx, Gy, Gz]")
    log.info("  Window: %.0f s  |  Overlap: %.0f%%  |  FS_out: %d Hz",
             WIN_SEC, STEP_FRAC * 100, FS_OUT)
    log.info("=" * 65)

    completeness = load_completeness()

    p_dirs = sorted(
        [d for d in DATA_DIR.iterdir() if d.is_dir() and d.name.isdigit()],
        key=lambda d: int(d.name),
    )

    stim_X  = [];  stim_vad = [];  stim_bin = []
    stim_pid = []; stim_emo = []
    base_X  = [];  base_pid = []

    for p_dir in p_dirs:
        pid     = int(p_dir.name)
        q_file  = p_dir / f"{pid}_QUESTIONNAIRES.json"
        pp_X    = [];  pp_vad = [];  pp_bin = [];  pp_emo = []
        pp_base = []

        # ── Stimulus emotions ────────────────────────────────────────────
        for emo in STIMULUS_EMOTIONS:
            score = completeness.get((pid, emo))
            if score is None or score < MIN_HEADBAND_ON:
                continue

            fpath = p_dir / f"{pid}_{emo}_STIMULUS_MUSE.json"
            data, ok = load_muse_file(fpath)
            if not ok:
                log.warning("  [SKIP] %d / %s — file missing or bad channels", pid, emo)
                continue

            vad = load_vad(q_file, emo)
            if vad is None:
                continue

            valence = vad[0]
            if valence >= LIKE_THRESH:
                label = 0       # Like
            elif valence <= DISLIKE_THRESH:
                label = 1       # Dislike
            else:
                continue        # Drop ambiguous mid-valence

            wins = _segment(data, WIN_SAMP_IN, STEP_SAMP_IN)
            if len(wins) == 0:
                continue

            wins_ds = _downsample_2to1(wins)

            pp_X.append(wins_ds)
            pp_vad.extend([list(vad)] * len(wins_ds))
            pp_bin.extend([label] * len(wins_ds))
            pp_emo.extend([emo] * len(wins_ds))

            log.info("  [OK] %d / %-12s  val=%.0f → %s  wins=%d",
                     pid, emo, valence,
                     "Like" if label == 0 else "Dislike", len(wins_ds))

        # ── Baseline ─────────────────────────────────────────────────────
        b_score = completeness.get((pid, BASELINE_EMOTION))
        if b_score is not None and b_score >= MIN_HEADBAND_ON:
            b_fpath = p_dir / f"{pid}_{BASELINE_EMOTION}_STIMULUS_MUSE.json"
            b_data, b_ok = load_muse_file(b_fpath)
            if b_ok:
                b_wins = _segment(b_data, WIN_SAMP_IN, STEP_SAMP_IN)
                if len(b_wins) > 0:
                    b_wins_ds = _downsample_2to1(b_wins)
                    pp_base.append(b_wins_ds)
                    log.info("  [BASE] %d  baseline wins=%d", pid, len(b_wins_ds))

        if not pp_X:
            log.info("  No stimulus windows for participant %d", pid)
            continue

        # ── Per-participant Z-score normalisation ─────────────────────────
        # Normalise stimulus + baseline together so they share the same
        # scale — critical for baseline correction later in Colab.
        all_wins = np.concatenate(pp_X + pp_base, axis=0) \
                   if pp_base else np.concatenate(pp_X, axis=0)
        # all_wins: (N, 10, 512)
        flat = all_wins.reshape(len(all_wins), -1)        # (N, 10*512)
        mu   = flat.mean(axis=0, keepdims=True)
        sd   = flat.std(axis=0, keepdims=True) + 1e-8
        norm = ((flat - mu) / sd).reshape(all_wins.shape).astype(np.float32)

        n_stim = sum(len(w) for w in pp_X)
        stim_norm = norm[:n_stim]
        base_norm = norm[n_stim:]

        # Accumulate stimulus
        stim_X.append(stim_norm)
        stim_vad.extend(pp_vad)
        stim_bin.extend(pp_bin)
        stim_pid.extend([pid] * n_stim)
        stim_emo.extend(pp_emo)

        # Accumulate baseline
        if base_norm.shape[0] > 0:
            base_X.append(base_norm)
            base_pid.extend([pid] * len(base_norm))

    # ── Assemble ───────────────────────────────────────────────────────────
    X         = np.concatenate(stim_X,  axis=0).astype(np.float32)
    y_vad     = np.array(stim_vad,   dtype=np.float32)
    y_binary  = np.array(stim_bin,   dtype=np.int8)
    pid_arr   = np.array(stim_pid,   dtype=np.int16)
    emo_arr   = np.array(stim_emo)

    X_base    = np.concatenate(base_X, axis=0).astype(np.float32) \
                if base_X else np.empty((0, 10, WIN_SAMP_OUT), np.float32)
    base_pid_arr = np.array(base_pid, dtype=np.int16) \
                   if base_pid else np.array([], dtype=np.int16)

    bc = np.bincount(y_binary.astype(int))
    log.info("=" * 65)
    log.info("Done.")
    log.info("  Stimulus windows   : %d", len(X))
    log.info("  Like (0)           : %d  (%.1f%%)",
             bc[0], bc[0] / len(X) * 100)
    log.info("  Dislike (1)        : %d  (%.1f%%)",
             bc[1], bc[1] / len(X) * 100)
    log.info("  Baseline windows   : %d", len(X_base))
    log.info("  X shape            : %s", X.shape)
    log.info("  Channels           : [TP9, AF7, AF8, TP10, Ax, Ay, Az, Gx, Gy, Gz]")

    np.savez_compressed(
        OUTPUT_NPZ,
        X             = X,
        y_vad         = y_vad,
        y_binary      = y_binary,
        participant_id= pid_arr,
        emotion       = emo_arr,
        X_base        = X_base,
        base_pid      = base_pid_arr,
    )
    log.info("  Saved → %s", OUTPUT_NPZ)
    log.info("=" * 65)


if __name__ == "__main__":
    build()
