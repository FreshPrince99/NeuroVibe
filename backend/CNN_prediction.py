"""
CNN-based EEG emotion prediction using VAD (Valence, Arousal, Dominance).
This module mirrors the preprocessing pipeline used during model training.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import mne
import tensorflow as tf


@dataclass(frozen=True)
class VADPrediction:
    valence: float
    arousal: float
    dominance: float


class CNNEmotionPredictor:
    """
    Predict emotions from EEG data using a CNN trained on PSD features.

    The preprocessing mirrors training:
    - Channels: AF7, TP9, TP10, AF8
    - Convert microvolts to volts (MNE expects volts)
    - Average reference
    - IIR Butterworth band-pass filter 0.5-45 Hz (order=4)
    - PSD via Welch (n_fft=512, fmin=0.5, fmax=45)
    - Input shape: (1, 4, 90, 1)
    """

    def __init__(
        self,
        model_path: str = "models/eeg_emotion_prediction_model.keras",
        sample_rate: int = 256,
        window_seconds: int = 60,
        microvolts_to_volts: float = 1e-6,
        n_fft: int = 512,
        fmin: float = 0.5,
        fmax: float = 45.0,
    ) -> None:
        self.sample_rate = sample_rate
        self.window_seconds = window_seconds
        self.microvolts_to_volts = microvolts_to_volts
        self.n_fft = n_fft
        self.fmin = fmin
        self.fmax = fmax

        self.channel_order = ["AF7", "TP9", "TP10", "AF8"]
        self._info = mne.create_info(
            ch_names=self.channel_order,
            sfreq=self.sample_rate,
            ch_types=["eeg"] * len(self.channel_order),
        )
        self.model = self._load_model(model_path)

    def _load_model(self, model_path: str) -> tf.keras.Model:
        """Load the trained CNN model, with a fallback name if needed."""
        model_file = Path(model_path)
        if not model_file.exists():
            fallback = model_file.with_name("eeg_emotion_prediction.keras")
            if fallback.exists():
                model_file = fallback
            else:
                raise FileNotFoundError(
                    f"CNN model file not found: {model_path} (or {fallback.name})"
                )
        return tf.keras.models.load_model(model_file)

    def _build_raw(self, eeg_segment: np.ndarray) -> mne.io.RawArray:
        raw = mne.io.RawArray(eeg_segment, self._info, verbose=False)
        raw.pick_channels(self.channel_order, verbose=False)
        raw.set_eeg_reference("average", verbose=False)
        raw.filter(
            self.fmin,
            self.fmax,
            method="iir",
            iir_params=dict(order=4, ftype="butter"),
            verbose=False,
        )
        if raw.info["sfreq"] != self.sample_rate:
            raw.resample(self.sample_rate, verbose=False)
        return raw

    def _compute_psd_features(self, eeg_segment: np.ndarray) -> np.ndarray:
        raw = self._build_raw(eeg_segment)
        duration = raw.times[-1]
        events = mne.make_fixed_length_events(raw, start=0, duration=duration)
        epoch = mne.Epochs(
            raw,
            events=events,
            tmin=0,
            tmax=duration,
            baseline=None,
            preload=True,
            verbose=False,
        )
        psd = epoch.compute_psd(
            method="welch",
            fmin=self.fmin,
            fmax=self.fmax,
            picks="eeg",
            n_fft=self.n_fft,
            verbose=False,
        )
        features = psd.get_data()[0]
        model_input = np.expand_dims(features, axis=0)
        model_input = np.expand_dims(model_input, axis=-1)
        return model_input

    def _categorize(self, value: float) -> str:
        if value >= 5.5:
            return "high"
        if value <= 4.5:
            return "low"
        return "mid"

    def vad_to_emotion(self, vad: VADPrediction) -> str:
        v_cat = self._categorize(vad.valence)
        a_cat = self._categorize(vad.arousal)
        d_cat = self._categorize(vad.dominance)

        if v_cat == "mid" and a_cat == "mid":
            return "Neutral"
        if v_cat == "high" and a_cat == "high":
            return "Excited" if d_cat == "high" else "Energized"
        if v_cat == "high" and a_cat == "low":
            return "Content" if d_cat == "high" else "Relaxed"
        if v_cat == "low" and a_cat == "high":
            return "Angry" if d_cat == "high" else "Anxious"
        if v_cat == "low" and a_cat == "low":
            return "Bored" if d_cat == "high" else "Sad"
        if v_cat == "mid" and a_cat == "high":
            return "Alert" if d_cat == "high" else "Stressed"
        if v_cat == "mid" and a_cat == "low":
            return "Calm"
        if v_cat == "high" and a_cat == "mid":
            return "Happy"
        if v_cat == "low" and a_cat == "mid":
            return "Tired"
        return "Neutral"

    def predict_vad(self, eeg_samples: Dict[str, np.ndarray]) -> Tuple[VADPrediction, VADPrediction]:
        ordered_channels = [
            eeg_samples["af7"],
            eeg_samples["tp9"],
            eeg_samples["tp10"],
            eeg_samples["af8"],
        ]
        eeg_segment = np.stack(ordered_channels, axis=0).astype(np.float64)
        eeg_segment *= self.microvolts_to_volts
        model_input = self._compute_psd_features(eeg_segment)

        raw_prediction = self.model.predict(model_input, verbose=0)[0]
        raw_vad = VADPrediction(
            valence=float(raw_prediction[0]),
            arousal=float(raw_prediction[1]),
            dominance=float(raw_prediction[2]),
        )
        clamped_vad = VADPrediction(
            valence=float(np.clip(raw_vad.valence, 1, 9)),
            arousal=float(np.clip(raw_vad.arousal, 1, 9)),
            dominance=float(np.clip(raw_vad.dominance, 1, 9)),
        )
        return raw_vad, clamped_vad

    def predict_emotion(self, eeg_samples: Dict[str, np.ndarray]) -> Tuple[str, VADPrediction, VADPrediction]:
        raw_vad, clamped_vad = self.predict_vad(eeg_samples)
        emotion = self.vad_to_emotion(clamped_vad)
        return emotion, raw_vad, clamped_vad

    @property
    def required_samples(self) -> int:
        return self.sample_rate * self.window_seconds
