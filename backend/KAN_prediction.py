import os
import pickle
import numpy as np
import pandas as pd
import torch
from torch import nn
from pylsl import StreamInlet, resolve_byprop
from sklearn.preprocessing import StandardScaler, LabelEncoder
from scipy import signal # Required for butter filter and coherence
import warnings
import sys

warnings.filterwarnings("ignore")

# --- Import KAN Model ---
try:
    from kan import KAN
except ImportError:
    print("❌ Error: pykan library not found. Please install it:")
    print("   pip install pykan")
    sys.exit(1)

# --- Utility Functions ---
# The evaluate function is not strictly needed for prediction script, but included for completeness if desired
def accuracy_from_logits(logits, labels):
    preds = torch.argmax(logits, dim=1)
    return (preds == labels).float().mean().item()

def evaluate(model, loader, loss_fn):
    model.eval()
    total_loss = 0.0
    total_acc = 0.0
    count = 0
    with torch.no_grad():
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            logits = model(xb)
            loss = loss_fn(logits, yb)
            total_loss += loss.item() * len(xb)
            total_acc += accuracy_from_logits(logits, yb) * len(xb)
            count += len(xb)
    return total_loss / count, total_acc / count

# --- Advanced Feature Extraction Function (Improved Version) ---
def getAdvancedEEGFeatures(channels_data, SampleRate, debug=False):
    """
    Extract 38 features from EEG channels:
    - 20 per-channel power features (4 channels × 5 frequency bands)
    - 30 coherence features (6 pairs × 5 bands, trimmed to fit)
    - Preserves spatial and spectral information
    """
    nyquist = SampleRate / 2
    cutoff = 30  # Hz
    try:
        b, a = signal.butter(3, cutoff / nyquist, btype='low')
        channels_filtered = [signal.filtfilt(b, a, ch) for ch in channels_data]
    except Exception as e:
        if debug: print(f"Filter failed: {type(e).__name__}: {e}")
        return None

    if any(len(ch) == 0 for ch in channels_filtered):
        if debug: print("Channels empty after filtering")
        return None

    # IMPROVED: Compute power bins for EACH channel separately
    final_features = []
    all_channel_bins = []

    for channel_idx, channel in enumerate(channels_filtered):
        try:
            fftData = np.fft.fft(channel)
            freq = np.fft.fftfreq(len(channel)) * SampleRate
            outFftData = fftData[1:int(len(fftData)/2)]
            outMag = outFftData.real**2 + outFftData.imag**2
            outFreq = freq[1:int(len(freq)/2)]
        except Exception as e:
            if debug: print(f"FFT failed on channel {channel_idx}: {e}")
            return None

        binsTotal = [0, 0, 0, 0, 0]
        binsCount = [0, 0, 0, 0, 0]

        for point in range(len(outFreq)):
            frequency = outFreq[point]
            if frequency < 4:
                binsTotal[0] += outMag[point]
                binsCount[0] += 1
            elif frequency < 7.5:
                binsTotal[1] += outMag[point]
                binsCount[1] += 1
            elif frequency < 12.5:
                binsTotal[2] += outMag[point]
                binsCount[2] += 1
            elif frequency < 30:
                binsTotal[3] += outMag[point]
                binsCount[3] += 1
            elif frequency < 120:
                binsTotal[4] += outMag[point]
                binsCount[4] += 1

        # Compute relative power for this channel
        binsAverage = [total / count if count != 0 else 0 for total, count in zip(binsTotal, binsCount)]
        all_channel_bins.append(binsAverage)
        
        total_power = sum(binsAverage)
        if total_power > 0:
            relative_bins = [b / total_power for b in binsAverage]
        else:
            relative_bins = [0.0] * 5
        
        final_features.extend(relative_bins)

    # Add coherence features to capture inter-channel relationships
    try:
        coherence_features = []
        channel_pairs = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]
        freq_bands = {
            'Delta': (0.5, 4),
            'Theta': (4, 7.5),
            'Alpha': (7.5, 12.5),
            'Beta': (12.5, 30),
            'Gamma': (30, 120)
        }
        
        nperseg = min(256, len(channels_filtered[0]) // 4)
        if nperseg >= 8:
            noverlap = nperseg // 2
            for ch1_idx, ch2_idx in channel_pairs:
                ch1 = channels_filtered[ch1_idx]
                ch2 = channels_filtered[ch2_idx]
                if len(ch1) >= nperseg and len(ch2) >= nperseg:
                    try:
                        f, Cxy = signal.coherence(ch1, ch2, fs=SampleRate, nperseg=nperseg, noverlap=noverlap)
                        for band_name, (low, high) in freq_bands.items():
                            band_mask = (f >= low) & (f <= high)
                            if band_mask.any():
                                mean_coherence = np.mean(Cxy[band_mask])
                            else:
                                mean_coherence = 0.0
                            coherence_features.append(mean_coherence)
                    except:
                        coherence_features.extend([0.0] * len(freq_bands))
                else:
                    coherence_features.extend([0.0] * len(freq_bands))
        
        final_features.extend(coherence_features)
    except Exception as e:
        if debug: print(f"Coherence calculation warning: {e}")

    # Pad/trim to exactly 38 features
    if len(final_features) < 38:
        final_features.extend([0.0] * (38 - len(final_features)))
    elif len(final_features) > 38:
        final_features = final_features[:38]

    if debug:
        print(f"Per-channel power (20): {final_features[:20]}")
        print(f"Coherence features (18): {final_features[20:38]}")
        print(f"Total features: {len(final_features)}")

    return final_features

# --- Global Settings ---
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Using device: {device}")

class EmotionPredictor:
    """
    Handles emotion prediction from EEG brainwave data using a trained EmotionNet model.
    """

    def __init__(self, model_path='models/mood_model.pth',
                 scaler_path='models/scaler.pkl',
                 label_encoder_path='models/label_encoder.pkl',
                 sample_rate=256,
                 window_seconds=60):
        """
        Initialize the emotion predictor with model, scaler, and label encoder.

        Args:
            model_path: Path to the trained EmotionNet model (.pth file)
            scaler_path: Path to the StandardScaler (.pkl file)
            label_encoder_path: Path to the LabelEncoder (.pkl file)
            sample_rate: EEG sampling rate (default: 256 Hz for Muse S)
            window_seconds: Window size in seconds (default: 60)
        """
        self.model_path = model_path
        self.scaler_path = scaler_path
        self.label_encoder_path = label_encoder_path
        self.SampleRate = sample_rate
        self.window_seconds = window_seconds

        # Load model and preprocessors
        self._load_label_encoder() # Load label encoder first to get num_classes
        self._load_model()
        self._load_scaler()

        print("EmotionPredictor initialized successfully!")
    
    @property
    def required_samples(self) -> int:
        """Return the number of samples required for prediction."""
        return self.SampleRate * self.window_seconds

    def _load_model(self):
        """Load the trained KAN model."""
        try:
            # Load the checkpoint
            state = torch.load(self.model_path, map_location=device)
            
            # Check if this is a KAN model (has 'width' attribute in state or specific KAN keys)
            is_kan_model = any(key.startswith(('act_fun', 'node_bias', 'subnode_bias')) for key in state.keys())
            
            if is_kan_model:
                # Initialize KAN model with architecture: [38, 16, 8, 4]
                # This matches the notebook's KAN([38, 16, 8, 4], grid=3, k=3)
                num_classes = len(self.label_encoder.classes_)
                self.model = KAN(width=[38, 16, 8, num_classes], grid=3, k=3, seed=42, device=device)
                
                # Load the saved state dict
                self.model.load_state_dict(state)
                print(f"✓ KAN model loaded from: {self.model_path}")
            else:
                # Legacy: Old EmotionNet checkpoint (shouldn't reach here with new models)
                raise ValueError(
                    "This appears to be an old model format. "
                    "Please retrain with KAN_FINAL_MODIFIED.ipynb to generate "
                    "the new KAN model files."
                )
                
        except Exception as e:
            raise FileNotFoundError(f"Failed to load model: {e}")

    def _load_scaler(self):
        """Load the StandardScaler used during training."""
        try:
            with open(self.scaler_path, 'rb') as f:
                self.scaler = pickle.load(f)
            print(f"✓ Scaler loaded from: {self.scaler_path}")
        except Exception as e:
            raise FileNotFoundError(f"Failed to load scaler: {e}")

    def _load_label_encoder(self):
        """Load the LabelEncoder to decode predictions."""
        try:
            with open(self.label_encoder_path, 'rb') as f:
                obj = pickle.load(f)
            # Guard against accidental scaler saved in the encoder slot
            if hasattr(obj, "classes_"):
                self.label_encoder = obj
                print(f"✓ Label encoder loaded from: {self.label_encoder_path}")
            else:
                # Fallback: rebuild encoder with known class order
                fallback_classes = ["Angry", "Happy", "Relaxed", "Sad"]
                enc = LabelEncoder()
                enc.fit(fallback_classes)
                self.label_encoder = enc
                print(
                    "⚠️  Loaded object was not a LabelEncoder; "
                    "rebuilt encoder with default classes: "
                    f"{fallback_classes}"
                )
        except Exception as e:
            # Rebuild a minimal encoder if file missing/corrupt
            fallback_classes = ["Angry", "Happy", "Relaxed", "Sad"]
            enc = LabelEncoder()
            enc.fit(fallback_classes)
            self.label_encoder = enc
            print(
                "⚠️  Failed to load label encoder, using fallback classes: "
                f"{fallback_classes}. Error: {e}"
            )

    def stream_eeg_data(self, duration=5):
        """
        Stream EEG data from the Muse headset via LSL (BlueMuse).

        Args:
            duration: Duration in seconds to collect data

        Returns:
            List of numpy arrays, one for each EEG channel [channels x samples]
        """
        print(f"Looking for EEG stream... (will collect data for {duration}s)")

        # Find the EEG stream from BlueMuse
        streams = resolve_byprop('type', 'EEG', timeout=5)

        if not streams:
            raise RuntimeError("No EEG stream found. Is BlueMuse 'Start Streaming' active?")

        inlet = StreamInlet(streams[0])
        print("✓ Connected to EEG stream!")

        # Collect data
        samples_list = [] # Store samples as list of lists temporarily
        start_time = inlet.pull_sample()[1]

        try:
            while True:
                sample, timestamp = inlet.pull_sample()
                samples_list.append(sample[:4])  # Get first 4 channels (TP9, AF7, AF8, TP10)

                # Check if duration elapsed
                if timestamp - start_time >= duration:
                    break

        except KeyboardInterrupt:
            print("\nStream interrupted by user.")

        # Convert to numpy array [samples x channels] then transpose to [channels x samples]
        eeg_data_raw = np.array(samples_list).T
        # Convert each channel to a separate numpy array in a list
        eeg_channels_list = [eeg_data_raw[i, :] for i in range(eeg_data_raw.shape[0])]

        print(f"✓ Collected {eeg_data_raw.shape[1]} samples from {eeg_data_raw.shape[0]} channels")

        return eeg_channels_list # Return as list of numpy arrays for getAdvancedEEGFeatures

    def compute_all_advanced_features(self, eeg_channels_list, debug=False):
        """
        Compute all 38 advanced features (power bins, coherence, derived ratios)
        from raw EEG channels data.

        Args:
            eeg_channels_list: List of numpy arrays, one for each EEG channel.
            debug: Flag to print debug information.

        Returns:
            List of 38 feature values.
        """
        if not eeg_channels_list or any(len(ch) < self.SampleRate * 2 for ch in eeg_channels_list): # Need at least 2 seconds for coherence
            print("Insufficient data for feature extraction. Skipping.")
            return None

        # Use the adapted getAdvancedEEGFeatures function
        advanced_features_vector = getAdvancedEEGFeatures(eeg_channels_list, self.SampleRate, debug=debug)

        return advanced_features_vector

    def predict(self, advanced_features_vector):
        """
        Predict emotion from the advanced feature vector.

        Args:
            advanced_features_vector: List of 38 feature values.

        Returns:
            Predicted emotion as string
        """
        if advanced_features_vector is None:
            return "Undetermined (Insufficient Features)"

        # Convert to numpy array and reshape for scaler
        features_array = np.array(advanced_features_vector).reshape(1, -1)

        # Standardize using the same scaler from training
        features_scaled = self.scaler.transform(features_array)

        # DEBUG: Print scaled values
        # print(f"   Scaled features: {features_scaled[0]}")

        # Convert to tensor
        features_tensor = torch.tensor(features_scaled, dtype=torch.float32).to(device)

        # Make prediction
        with torch.no_grad():
            logits = self.model(features_tensor)
            predicted_class_idx = torch.argmax(logits, dim=1).item()

            # DEBUG: Print raw logits
            # print(f"   Raw logits: {logits[0].numpy()}")
            # print(f"   Predicted class: {predicted_class_idx}")

        # Use the persisted label encoder to decode class index
        try:
            predicted_emotion = self.label_encoder.inverse_transform([predicted_class_idx])[0]
        except Exception:
            # Fallback mapping if label encoder is unavailable or class not found
            emotion_map = {0: "Angry", 1: "Happy", 2: "Relaxed", 3: "Sad"}
            predicted_emotion = emotion_map.get(predicted_class_idx, "Unknown")

        # Map "Angry" to "Stressed" (as done in NeuroTune if applicable)
        if predicted_emotion == "Angry":
            predicted_emotion = "Stressed"

        return predicted_emotion

    def predict_from_stream(self, duration=5):
        """
        Complete pipeline: Stream EEG data, compute features, and predict emotion.

        Args:
            duration: Duration in seconds to collect EEG data

        Returns:
            Predicted emotion as string
        """
        print("\n" + "="*50)
        print("Starting Emotion Prediction Pipeline")
        print("="*50)

        # Step 1: Stream EEG data
        eeg_channels_list = self.stream_eeg_data(duration)

        # Step 2: Compute all advanced features
        advanced_features = self.compute_all_advanced_features(eeg_channels_list, debug=False)

        # Step 3: Predict emotion
        emotion = self.predict(advanced_features)

        print("="*50)
        print(f"🎯 PREDICTED EMOTION: {emotion.upper()}")
        print("="*50 + "\n")

        return emotion

    def predict_continuously(self, duration=5, interval=3):
        """
        Continuously predict emotions from live EEG stream.

        Args:
            duration: Duration in seconds to collect data for each prediction
            interval: Time in seconds to wait between predictions
        """
        import time

        print("\n" + "="*60)
        print("🔄 CONTINUOUS EMOTION MONITORING")
        print("="*60)
        print(f"Collecting {duration}s of data every {interval}s")
        print("Press Ctrl+C to stop\n")

        prediction_count = 0

        try:
            while True:
                prediction_count += 1
                print(f"\n--- Prediction #{prediction_count} ---")

                # Stream EEG data
                eeg_channels_list = self.stream_eeg_data(duration)

                # Compute advanced features
                advanced_features = self.compute_all_advanced_features(eeg_channels_list, debug=False)

                # Predict emotion
                emotion = self.predict(advanced_features)

                print(f"🎯 Detected Emotion: {emotion.upper()}")
                print("-" * 40)

                # Wait before next prediction
                if interval > 0:
                    print(f"⏳ Waiting {interval}s before next prediction...")
                    time.sleep(interval)

        except KeyboardInterrupt:
            print("\n\n" + "="*60)
            print(f"✓ Monitoring stopped after {prediction_count} predictions")
            print("="*60 + "\n")


def predict_emotion(duration=5):
    """
    Convenience function to predict emotion from live stream.

    Args:
        duration: Duration in seconds to collect EEG data

    Returns:
        Predicted emotion as string
    """
    predictor = EmotionPredictor()
    return predictor.predict_from_stream(duration)


def monitor_emotions_continuously(duration=5, interval=3):
    """
    Continuously monitor and predict emotions.

    Args:
        duration: Duration in seconds to collect data for each prediction
        interval: Time in seconds to wait between predictions
    """
    predictor = EmotionPredictor()
    predictor.predict_continuously(duration, interval)


if __name__ == "__main__":
    # Example usage
    import sys

    # Check if user wants continuous monitoring
    if len(sys.argv) > 1 and sys.argv[1] == "--continuous":
        try:
            print("\n🚀 Starting Continuous Emotion Monitoring...")
            monitor_emotions_continuously(duration=5, interval=3)
        except Exception as e:
            print(f"\n❌ Error: {e}")
            print("\nTroubleshooting:")
            print("1. Make sure BlueMuse is running and streaming")
            print("2. Check that model files exist in the models/ folder")
            print("3. Ensure the Muse headset is properly connected")
    else:
        # Single prediction
        try:
            emotion = predict_emotion(duration=5)
            print(f"\nFinal Result: {emotion}")
        except Exception as e:
            print(f"\n❌ Error: {e}")
            print("\nTroubleshooting:")
            print("1. Make sure BlueMuse is running and streaming")
            print("2. Check that model files exist in the models/ folder")
            print("3. Ensure the Muse headset is properly connected")
            print("\n💡 Tip: Use 'python KAN_prediction.py --continuous' for real-time monitoring")

