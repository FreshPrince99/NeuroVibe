"""
LSTM-based EEG emotion prediction for real-time classification.
This module processes Muse EEG data and predicts emotions: POSITIVE, NEUTRAL, or NEGATIVE.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import tensorflow as tf
from scipy import signal
from scipy.fft import fft


@dataclass(frozen=True)
class EmotionPrediction:
    """Stores the predicted emotion and its confidence scores."""
    emotion: str  # POSITIVE, NEUTRAL, or NEGATIVE
    negative_prob: float
    neutral_prob: float
    positive_prob: float


class LSTMEmotionPredictor:
    """
    Predict emotions from EEG data using an LSTM trained on FFT features.
    
    The model expects:
    - 750 FFT features (matching training data: fft_0_b through fft_749_b)
    - Input shape: (batch_size, 750, 1)
    - Channels: AF7, TP9, TP10, AF8 (4 channels from Muse headband)
    
    Output classes:
    - 0: NEGATIVE
    - 1: NEUTRAL
    - 2: POSITIVE
    """

    LABEL_MAPPING = {0: 'NEGATIVE', 1: 'NEUTRAL', 2: 'POSITIVE'}
    NUM_FFT_FEATURES = 750  # Matches training data (750 FFT bins)
    CHANNELS = ['AF7', 'TP9', 'TP10', 'AF8']

    def __init__(
        self,
        model_path: str = "models/lstm_model(1).h5",
        sample_rate: int = 256,
        window_seconds: int = 60,
    ) -> None:
        """
        Initialize the LSTM emotion predictor.
        
        Args:
            model_path: Path to the trained LSTM model file
            sample_rate: Sampling rate of EEG data (Hz)
            window_seconds: Duration of EEG window for prediction (seconds)
        """
        self.sample_rate = sample_rate
        self.window_seconds = window_seconds
        self.required_samples = sample_rate * window_seconds
        
        # Resolve model path relative to this file's directory
        if not Path(model_path).is_absolute():
            model_path = str(Path(__file__).parent / model_path)
        
        self.model = self._load_model(model_path)
        print(f"✓ LSTM model loaded from {model_path}")
        print(f"  Required samples: {self.required_samples} ({window_seconds}s @ {sample_rate}Hz)")

    def _build_model_architecture(self, input_shape: int) -> tf.keras.Model:
        """
        Rebuild the LSTM model architecture to match the trained model.
        Architecture: Input -> Reshape -> LSTM(256) -> Dropout(0.5) -> Dense(3)
        Note: LSTM without return_sequences, so output is (batch, 256)
        """
        inputs = tf.keras.Input(shape=(input_shape,))
        
        # Reshape to add time dimension for LSTM: (batch, 750) -> (batch, 750, 1)
        expand_dims = tf.keras.layers.Reshape((input_shape, 1))(inputs)
        
        # LSTM layer (256 units, no return_sequences)
        lstm = tf.keras.layers.LSTM(256)(expand_dims)
        
        # Dropout layer
        dropout = tf.keras.layers.Dropout(0.5)(lstm)
        
        # Output layer
        outputs = tf.keras.layers.Dense(3, activation='softmax')(dropout)
        
        # Create model
        model = tf.keras.Model(inputs=inputs, outputs=outputs)
        return model
    
    def _load_model(self, model_path: str) -> tf.keras.Model:
        """Load the trained LSTM model by reconstructing architecture and loading weights."""
        model_file = Path(model_path)
        if not model_file.exists():
            raise FileNotFoundError(f"LSTM model file not found: {model_path}")
        
        try:
            # Rebuild the model architecture
            model = self._build_model_architecture(self.NUM_FFT_FEATURES)
            
            # Load only the weights from the H5 file
            model.load_weights(str(model_file))
            
            # Compile the model
            model.compile(
                optimizer='adam',
                loss='sparse_categorical_crossentropy',
                metrics=['accuracy']
            )
            return model
        except Exception as e:
            print(f"❌ Error loading model: {e}")
            import traceback
            traceback.print_exc()
            raise

    def _extract_fft_features(self, eeg_data: np.ndarray) -> np.ndarray:
        """
        Extract 750 FFT features from multi-channel EEG data.
        
        The model expects exactly 750 features to match the training data format
        (fft_0_b through fft_749_b). We compute FFT for each channel and downsample
        to get 750 total features.
        
        Args:
            eeg_data: Shape (num_channels, num_samples) - raw EEG data
            
        Returns:
            FFT features: Shape (750,) - downsampled FFT magnitudes
        """
        num_channels, num_samples = eeg_data.shape
        
        # Apply Hanning window to reduce spectral leakage
        window = signal.windows.hann(num_samples)
        
        all_channel_features = []
        
        for channel_idx in range(num_channels):
            # Apply window and compute FFT
            windowed_signal = eeg_data[channel_idx] * window
            fft_result = fft(windowed_signal)
            
            # Take magnitude of FFT (only positive frequencies)
            fft_magnitude = np.abs(fft_result[:num_samples // 2])
            
            # Normalize by length
            fft_magnitude = fft_magnitude / num_samples
            
            all_channel_features.append(fft_magnitude)
        
        # Concatenate all channels: 4 channels × 7680 bins = 30,720 bins
        all_features = np.concatenate(all_channel_features)
        
        # Downsample to 750 features by averaging bins
        # This matches the training data format
        target_size = self.NUM_FFT_FEATURES  # 750
        current_size = len(all_features)
        
        if current_size > target_size:
            # Calculate how many bins to average together
            bin_size = current_size / target_size
            
            # Downsample by averaging bins intelligently
            downsampled = np.zeros(target_size)
            for i in range(target_size):
                start_idx = int(i * bin_size)
                end_idx = int((i + 1) * bin_size)
                downsampled[i] = np.mean(all_features[start_idx:end_idx])
            
            all_features = downsampled
        elif current_size < target_size:
            # Unlikely case: pad with zeros if we have too few features
            padding = np.zeros(target_size - current_size)
            all_features = np.concatenate([all_features, padding])
        
        return all_features

    def _prepare_input(self, channels_data: Dict[str, np.ndarray]) -> np.ndarray:
        """
        Prepare EEG data for model input.
        
        Args:
            channels_data: Dictionary with keys 'af7', 'tp9', 'tp10', 'af8'
                          Each value is a numpy array of EEG samples
                          
        Returns:
            Input tensor ready for model prediction: Shape (1, 750)
        """
        # Stack channels in order: AF7, TP9, TP10, AF8
        eeg_array = np.array([
            channels_data['af7'],
            channels_data['tp9'],
            channels_data['tp10'],
            channels_data['af8']
        ], dtype=np.float32)
        
        # Validate shape
        if eeg_array.shape[1] != self.required_samples:
            raise ValueError(
                f"Expected {self.required_samples} samples per channel, "
                f"got {eeg_array.shape[1]}"
            )
        
        # Extract FFT features
        fft_features = self._extract_fft_features(eeg_array)
        
        # Add batch dimension: (750,) -> (1, 750)
        return fft_features.reshape(1, -1)

    def predict(self, channels_data: Dict[str, np.ndarray]) -> EmotionPrediction:
        """
        Predict emotion from EEG data.
        
        Args:
            channels_data: Dictionary containing EEG data:
                          {'af7': array, 'tp9': array, 'tp10': array, 'af8': array}
                          Each array should have shape (required_samples,)
                          
        Returns:
            EmotionPrediction with emotion label and class probabilities
        """
        # Prepare input
        model_input = self._prepare_input(channels_data)
        
        # Make prediction
        predictions = self.model.predict(model_input, verbose=0)
        
        # Get probabilities for each class
        probs = predictions[0]
        negative_prob = float(probs[0])
        neutral_prob = float(probs[1])
        positive_prob = float(probs[2])
        
        # Get predicted class
        predicted_class = int(np.argmax(probs))
        emotion_label = self.LABEL_MAPPING[predicted_class]
        
        return EmotionPrediction(
            emotion=emotion_label,
            negative_prob=negative_prob,
            neutral_prob=neutral_prob,
            positive_prob=positive_prob
        )

    def predict_emotion(self, channels_data: Dict[str, np.ndarray]) -> Tuple[str, EmotionPrediction]:
        """
        Predict emotion and return both the label and full prediction details.
        This method signature matches the CNN predictor for compatibility.
        
        Args:
            channels_data: Dictionary containing EEG data
            
        Returns:
            Tuple of (emotion_label, prediction_details)
        """
        prediction = self.predict(channels_data)
        return prediction.emotion.lower(), prediction


def main():
    """Test the LSTM emotion predictor with synthetic data."""
    print("Testing LSTM Emotion Predictor...")
    
    try:
        # Initialize predictor
        predictor = LSTMEmotionPredictor(
            model_path='models/best_lstm_model.h5',
            sample_rate=256,
            window_seconds=60
        )
        
        # Generate synthetic test data
        num_samples = predictor.required_samples
        print(f"\nGenerating synthetic test data ({num_samples} samples)...")
        
        # Create synthetic EEG data (normally distributed)
        test_data = {
            'af7': np.random.randn(num_samples) * 50,  # Typical EEG amplitude in µV
            'tp9': np.random.randn(num_samples) * 50,
            'tp10': np.random.randn(num_samples) * 50,
            'af8': np.random.randn(num_samples) * 50,
        }
        
        # Make prediction
        print("Making prediction...")
        emotion, prediction = predictor.predict_emotion(test_data)
        
        # Display results
        print("\n" + "="*60)
        print(f"🧠 PREDICTED EMOTION: {emotion.upper()}")
        print("-"*60)
        print(f"   Negative probability: {prediction.negative_prob:.4f} ({prediction.negative_prob*100:.2f}%)")
        print(f"   Neutral probability:  {prediction.neutral_prob:.4f} ({prediction.neutral_prob*100:.2f}%)")
        print(f"   Positive probability: {prediction.positive_prob:.4f} ({prediction.positive_prob*100:.2f}%)")
        print("="*60)
        
        print("\n✓ Test completed successfully!")
        
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == '__main__':
    main()
