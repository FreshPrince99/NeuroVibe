"""
preprocess_neurosense_local.py
==============================
Local NeuroSense preprocessing script.

What it does:
1. Loads BIDS EDF sessions.
2. Parses AVG_Valence from *_eeg.json metadata.
3. Binarizes labels:
   - positive (0): valence >= pos_thresh
   - negative (1): valence <= neg_thresh
   - drops middle range
4. Preprocesses EEG (resample to 256 Hz if needed, 50 Hz notch, 1-45 Hz bandpass).
5. Windows signal into 4 s with 50% overlap.
6. Runs quality filtering.
7. Per-window, per-channel z-score normalization (mean/std over 1024 samples).
   This is exactly replicable at real-time inference without needing session context.
8. Extracts 128 handcrafted EEG features per window.
9. Saves one NPZ for feature-based training/testing.

Output NPZ keys:
  features      : float32 (N, 128)
  eeg_windows   : float32 (N, 4, 1024)
  labels        : int8    (N,)
  subject_id    : str     (N,)
  session_id    : str     (N,)
  avg_valence   : float32 (N,)

Usage:
  python preprocess_neurosense_local.py \
    --dataset_root NeuroSenseEEGDataset/BIDS \
    --out_dir neurosense_preprocessed
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import mne

from scipy.signal import butter, iirnotch, sosfiltfilt, welch, coherence, resample_poly


# -----------------------------------------------------------------------------
# Signal / window config
# -----------------------------------------------------------------------------
FS_TARGET = 256
WINDOW_SEC = 4.0
WINDOW_SAMP = int(FS_TARGET * WINDOW_SEC)   # 1024
STEP_SAMP = WINDOW_SAMP // 2                 # 50% overlap

BP_LOW = 1.0
BP_HIGH = 45.0
BP_ORDER = 4
NOTCH_HZ = 50.0
NOTCH_Q = 30.0

# Standard channel order for this pipeline
CH_STD = ["TP9", "AF7", "AF8", "TP10"]

# Quality thresholds (both unit scales supported)
MAX_ABS_UV = 300.0
MIN_STD_UV = 1e-3
MAX_ABS_V = 300e-6
MIN_STD_V = 1e-6

# Feature config
BANDS = {
    "delta": (1.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "gamma": (30.0, 45.0),
}
BAND_NAMES = list(BANDS.keys())
N_BANDS = len(BAND_NAMES)
N_CH = 4
N_PERSEG = 256
COH_PAIRS = [
    (0, 1), (0, 2), (0, 3),
    (1, 2), (1, 3), (2, 3),
]

_BAND_CACHE: dict[bytes, dict[str, np.ndarray]] = {}


def build_notch_sos(fs: float, freq: float = NOTCH_HZ, q: float = NOTCH_Q):
    b, a = iirnotch(freq, q, fs)
    from scipy.signal import tf2sos
    return tf2sos(b, a)


def build_bandpass_sos(
    fs: float,
    low: float = BP_LOW,
    high: float = BP_HIGH,
    order: int = BP_ORDER,
):
    nyq = fs / 2.0
    return butter(order, [low / nyq, high / nyq], btype="band", output="sos")


def parse_avg_valence(json_path: Path) -> float:
    """Extract AVG_Valence from NeuroSense JSON metadata."""
    with open(json_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    for k in ["AVG_Valence", "Avg_Valence", "avg_valence"]:
        if k in meta:
            return float(meta[k])

    desc = str(meta.get("TaskDescription", ""))
    m = re.search(r"AVG_Valence\s*:\s*([\d.]+)", desc)
    if m:
        return float(m.group(1))

    raise ValueError(f"AVG_Valence not found in {json_path}")


def binarize_valence(v: float, pos_thresh: float, neg_thresh: float) -> int:
    if v >= pos_thresh:
        return 0
    if v <= neg_thresh:
        return 1
    return -1


def load_reordered_eeg(edf_path: Path, ch_tsv_path: Path) -> tuple[np.ndarray, float]:
    """Load EDF and reorder channels to CH_STD = [TP9, AF7, AF8, TP10]."""
    raw = mne.io.read_raw_edf(str(edf_path), preload=True, verbose=False)
    sfreq = float(raw.info["sfreq"])

    if ch_tsv_path.exists():
        ch_map = pd.read_csv(ch_tsv_path, sep="\t")
        names = [str(x).strip().upper() for x in ch_map["name"].tolist()]
    else:
        names = [str(x).strip().upper() for x in raw.ch_names]

    data = raw.get_data().astype(np.float32)
    idx_by_name = {nm: i for i, nm in enumerate(names)}

    try:
        idx = [idx_by_name[nm] for nm in CH_STD]
    except KeyError as e:
        raise ValueError(f"Missing channel {e} in {edf_path.name}; available={names}")

    return data[idx, :], sfreq


def preprocess_session_signal(sig: np.ndarray, sfreq: float) -> np.ndarray:
    """Resample to 256 Hz if needed, then apply notch + bandpass."""
    if abs(sfreq - FS_TARGET) > 1e-6:
        fs_in = int(round(sfreq))
        fs_out = FS_TARGET
        g = np.gcd(fs_in, fs_out)
        up = fs_out // g
        down = fs_in // g
        sig = resample_poly(sig, up, down, axis=1).astype(np.float32)

    notch = build_notch_sos(FS_TARGET)
    bp = build_bandpass_sos(FS_TARGET)

    out = np.empty_like(sig, dtype=np.float32)
    for ch in range(sig.shape[0]):
        x = sig[ch].astype(np.float64)
        x = np.nan_to_num(x, nan=0.0)
        x = sosfiltfilt(notch, x)
        x = sosfiltfilt(bp, x)
        out[ch] = x.astype(np.float32)

    return out


def segment_windows(sig: np.ndarray, window: int = WINDOW_SAMP, step: int = STEP_SAMP) -> np.ndarray:
    """(4, T) -> (N, 4, window)"""
    n_ch, n = sig.shape
    if n < window:
        return np.empty((0, n_ch, window), dtype=np.float32)
    starts = range(0, n - window + 1, step)
    return np.stack([sig[:, s:s + window] for s in starts]).astype(np.float32)


def quality_mask_windows(wins: np.ndarray) -> np.ndarray:
    """Return boolean keep mask for high-quality windows."""
    if len(wins) == 0:
        return np.array([], dtype=bool)

    med_abs = float(np.median(np.abs(wins)))
    if med_abs < 1e-2:
        max_abs_thr = MAX_ABS_V
        min_std_thr = MIN_STD_V
    else:
        max_abs_thr = MAX_ABS_UV
        min_std_thr = MIN_STD_UV

    finite = np.isfinite(wins).all(axis=(1, 2))
    max_abs = np.max(np.abs(wins), axis=(1, 2)) <= max_abs_thr
    ch_std = np.std(wins, axis=2)
    non_flat = np.all(ch_std >= min_std_thr, axis=1)

    return finite & max_abs & non_flat


def _band_idx(freqs: np.ndarray) -> dict[str, np.ndarray]:
    key = freqs.tobytes()
    if key not in _BAND_CACHE:
        _BAND_CACHE[key] = {
            name: np.where((freqs >= lo) & (freqs < hi))[0]
            for name, (lo, hi) in BANDS.items()
        }
    return _BAND_CACHE[key]


def extract_features(win: np.ndarray) -> np.ndarray:
    """Extract 140-d feature vector from one window shape (4, 1024)."""
    feats: list[np.ndarray] = []

    f, psd = welch(win, fs=FS_TARGET, nperseg=N_PERSEG, axis=1, scaling="density")
    bidx = _band_idx(f)
    df = f[1] - f[0]

    bp = np.zeros((N_CH, N_BANDS), dtype=np.float64)
    for bi, name in enumerate(BAND_NAMES):
        idx = bidx[name]
        if len(idx):
            bp[:, bi] = np.trapezoid(psd[:, idx], dx=df, axis=1)

    bp_safe = np.where(bp > 1e-12, bp, 1e-12)
    total_power = np.sum(bp_safe, axis=1, keepdims=True)
    rbp = bp_safe / (total_power + 1e-12)

    feats.append(bp_safe.ravel())
    feats.append(rbp.ravel())

    de = 0.5 * np.log(2.0 * np.pi * np.e * bp_safe)
    feats.append(de.ravel())

    i_alpha = BAND_NAMES.index("alpha")
    i_beta = BAND_NAMES.index("beta")
    i_theta = BAND_NAMES.index("theta")

    feats.append(bp_safe[:, i_alpha] / bp_safe[:, i_beta])
    feats.append(bp_safe[:, i_theta] / bp_safe[:, i_beta])
    feats.append(bp_safe[:, i_theta] / bp_safe[:, i_alpha])

    af_l, af_r = 1, 2
    tp_l, tp_r = 0, 3
    for b in [i_alpha, i_theta, i_beta]:
        feats.append(np.array([np.log(bp_safe[af_r, b]) - np.log(bp_safe[af_l, b])]))
    for b in [i_alpha, i_theta, i_beta]:
        feats.append(np.array([np.log(bp_safe[tp_r, b]) - np.log(bp_safe[tp_l, b])]))

    hj_mob = np.zeros(N_CH, dtype=np.float64)
    hj_com = np.zeros(N_CH, dtype=np.float64)
    for ch in range(N_CH):
        x = win[ch]
        d1 = np.diff(x)
        d2 = np.diff(d1)
        v0 = np.var(x) + 1e-12
        v1 = np.var(d1) + 1e-12
        v2 = np.var(d2) + 1e-12
        mob = np.sqrt(v1 / v0)
        hj_mob[ch] = mob
        hj_com[ch] = np.sqrt(v2 / v1) / mob
    feats.append(hj_mob)
    feats.append(hj_com)

    psd_sum = np.sum(psd, axis=1, keepdims=True) + 1e-12
    centroid = np.sum(psd * f, axis=1) / psd_sum.ravel()
    feats.append(centroid)

    pse = np.zeros(N_CH, dtype=np.float64)
    for ch in range(N_CH):
        p = psd[ch] / (np.sum(psd[ch]) + 1e-12)
        p = np.where(p > 1e-12, p, 1e-12)
        pse[ch] = -np.sum(p * np.log(p))
    feats.append(pse)

    peak_f = f[np.argmax(psd, axis=1)]
    feats.append(peak_f)

    # NOTE: mean/std/var per channel are omitted — after per-window z-score they
    # are constant (0, 1, 1) and carry no information.

    for a, b in COH_PAIRS:
        fc, cxy = coherence(win[a], win[b], fs=FS_TARGET, nperseg=N_PERSEG)
        cb = _band_idx(fc)
        for bn in BAND_NAMES:
            idx = cb[bn]
            feats.append(np.array([cxy[idx].mean() if len(idx) else 0.0]))

    return np.concatenate(feats).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset_root", type=str, default="NeuroSenseEEGDataset/BIDS")
    ap.add_argument("--out_dir", type=str, default="neurosense_preprocessed")
    ap.add_argument("--pos_thresh", type=float, default=6.0)
    ap.add_argument("--neg_thresh", type=float, default=4.0)
    ap.add_argument("--max_sessions", type=int, default=0, help="0 = all sessions")
    args = ap.parse_args()

    dataset_root = Path(args.dataset_root)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    out_npz = out_dir / "neurosense_features_256hz.npz"
    out_manifest = out_dir / "preprocess_manifest.json"

    if not dataset_root.exists():
        raise FileNotFoundError(f"Dataset root not found: {dataset_root}")

    edf_files = sorted(dataset_root.rglob("*_eeg.edf"))
    if args.max_sessions > 0:
        edf_files = edf_files[: args.max_sessions]

    print("=" * 70)
    print("NeuroSense local preprocessing")
    print("=" * 70)
    print(f"Sessions discovered: {len(edf_files):,}")

    F_list: list[np.ndarray] = []
    W_list: list[np.ndarray] = []
    y_list: list[int] = []
    subj_list: list[str] = []
    sess_list: list[str] = []
    val_list: list[float] = []

    stats = {
        "total_sessions": 0,
        "used_sessions": 0,
        "dropped_mid_valence": 0,
        "dropped_missing_label": 0,
        "dropped_bad_channels": 0,
        "dropped_too_short": 0,
        "dropped_all_bad_windows": 0,
    }

    for i, edf_path in enumerate(edf_files, start=1):
        stats["total_sessions"] += 1

        json_path = edf_path.with_suffix(".json")
        ch_tsv = edf_path.with_name(edf_path.name.replace("_eeg.edf", "_channels.tsv"))

        stem_parts = edf_path.stem.split("_")
        sub_id = stem_parts[0].replace("sub-", "")
        ses_id = stem_parts[1].replace("ses-", "")
        sess_uid = f"{sub_id}_{ses_id}"

        try:
            v = parse_avg_valence(json_path)
        except Exception:
            stats["dropped_missing_label"] += 1
            continue

        y_bin = binarize_valence(v, args.pos_thresh, args.neg_thresh)
        if y_bin == -1:
            stats["dropped_mid_valence"] += 1
            continue

        try:
            sig, sfreq = load_reordered_eeg(edf_path, ch_tsv)
        except Exception:
            stats["dropped_bad_channels"] += 1
            continue

        sig = preprocess_session_signal(sig, sfreq)

        wins_raw = segment_windows(sig, WINDOW_SAMP, STEP_SAMP)
        if len(wins_raw) == 0:
            stats["dropped_too_short"] += 1
            continue

        keep = quality_mask_windows(wins_raw)
        if not np.any(keep):
            stats["dropped_all_bad_windows"] += 1
            continue

        # Per-window, per-channel z-score normalization.
        # Each window is normalized using only its own statistics (1024 samples),
        # which is exactly what can be done at real-time inference.
        wins_kept = wins_raw[keep]  # (N_kept, 4, 1024)
        mu = wins_kept.mean(axis=2, keepdims=True)   # (N_kept, 4, 1)
        sd = wins_kept.std(axis=2, keepdims=True) + 1e-8
        wins = ((wins_kept - mu) / sd).astype(np.float32)

        if len(wins) == 0:
            stats["dropped_all_bad_windows"] += 1
            continue

        # Feature extraction per kept window (128 features)
        feats = np.zeros((len(wins), 128), dtype=np.float32)
        for j in range(len(wins)):
            feats[j] = extract_features(wins[j])

        F_list.append(feats)
        W_list.append(wins.astype(np.float32))
        y_list.extend([y_bin] * len(wins))
        subj_list.extend([sub_id] * len(wins))
        sess_list.extend([sess_uid] * len(wins))
        val_list.extend([v] * len(wins))
        stats["used_sessions"] += 1

        if i % 100 == 0 or i == len(edf_files):
            print(f"  processed {i:,}/{len(edf_files):,} sessions", end="\r")

    print()

    if not F_list:
        print("Drop summary:")
        for k, v in stats.items():
            print(f"  {k:<28}: {v}")
        raise RuntimeError("No valid sessions found after preprocessing.")

    F = np.concatenate(F_list, axis=0).astype(np.float32)
    W = np.concatenate(W_list, axis=0).astype(np.float32)
    y = np.array(y_list, dtype=np.int8)
    subjects = np.array(subj_list)
    sessions = np.array(sess_list)
    avg_valence = np.array(val_list, dtype=np.float32)

    F = np.nan_to_num(F, nan=0.0, posinf=0.0, neginf=0.0)
    W = np.nan_to_num(W, nan=0.0, posinf=0.0, neginf=0.0)

    np.savez_compressed(
        out_npz,
        features=F,
        eeg_windows=W,
        labels=y,
        subject_id=subjects,
        session_id=sessions,
        avg_valence=avg_valence,
    )

    bc = np.bincount(y)
    manifest = {
        "dataset_root": str(dataset_root.resolve()),
        "output_npz": str(out_npz.resolve()),
        "fs_target": FS_TARGET,
        "window_samples": WINDOW_SAMP,
        "step_samples": STEP_SAMP,
        "channels_order": CH_STD,
        "label_positive_threshold": args.pos_thresh,
        "label_negative_threshold": args.neg_thresh,
        "n_windows": int(len(F)),
        "window_shape": [int(W.shape[1]), int(W.shape[2])],
        "n_features": int(F.shape[1]),
        "n_subjects": int(len(np.unique(subjects))),
        "n_sessions": int(len(np.unique(sessions))),
        "class_counts": {
            "positive_0": int(bc[0]) if len(bc) > 0 else 0,
            "negative_1": int(bc[1]) if len(bc) > 1 else 0,
        },
        "drop_stats": stats,
    }

    with open(out_manifest, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("=" * 70)
    print("Done.")
    print(f"Saved features: {out_npz}")
    print(f"Saved manifest: {out_manifest}")
    print(f"Windows: {len(F):,} | EEG shape: {W.shape[1:]} | Features: {F.shape[1]} (128) | Subjects: {len(np.unique(subjects))}")
    print(f"Class balance: pos(0)={manifest['class_counts']['positive_0']:,}, "
          f"neg(1)={manifest['class_counts']['negative_1']:,}")
    print("=" * 70)


if __name__ == "__main__":
    main()
