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

warnings.filterwarnings("ignore")

# --- Model Definition (EmotionNet) ---
# Copy the EmotionNet class definition from the notebook
class EmotionNet(nn.Module):
    def __init__(self, input_dim=38, num_classes=4, hidden=128, dropout=0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden),
            nn.BatchNorm1d(hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, hidden // 2),
            nn.BatchNorm1d(hidden // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden // 2, num_classes)
        )

    def forward(self, x):
        return self.net(x)

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

# --- Advanced Feature Extraction Function (Adapted for numpy array input) ---
def getAdvancedEEGFeatures(channels_data, SampleRate, debug=False):
    # channels_data is expected to be a list of numpy arrays, one for each EEG channel

    # Apply low-pass filter to each channel (as in getPowerBinsFromFilename)
    nyquist = SampleRate / 2
    cutoff = 30  # Hz, consistent with previous filtering
    try:
        b, a = signal.butter(3, cutoff / nyquist, btype='low')
        channels_filtered = [signal.filtfilt(b, a, ch) for ch in channels_data]
    except Exception as e:
        if debug: print(f"Coherence feature generation: Filter failed: {type(e).__name__}: {e}")
        return None

    if any(len(ch) == 0 for ch in channels_filtered):
        if debug: print(f"Coherence feature generation: Channels empty after filtering.")
        return None

    # --- Calculate 5 Relative Power Bins (from average of filtered channels) ---
    # Average across available channels
    avg_channel = np.array(channels_filtered).mean(axis=0).copy()

    # Perform FFT
    fftData = np.fft.fft(avg_channel)
    freq = np.fft.fftfreq(len(avg_channel)) * SampleRate

    # Get positive frequencies only
    outFftData = fftData[1:int(len(fftData)/2)]
    outMag = outFftData.real**2 + outFftData.imag**2
    outFreq = freq[1:int(len(freq)/2)]

    # Initialize bins
    binsTotal = [0, 0, 0, 0, 0]
    binsCount = [0, 0, 0, 0, 0]

    # Bin the frequencies
    for point in range(len(outFreq)):
        frequency = outFreq[point]
        if frequency < 4:      # Delta (0 - 4Hz)
            binsTotal[0] += outMag[point]
            binsCount[0] += 1
        elif frequency < 7.5:  # Theta (4 - 7.5Hz)
            binsTotal[1] += outMag[point]
            binsCount[1] += 1
        elif frequency < 12.5: # Alpha (7.5 - 12.5Hz)
            binsTotal[2] += outMag[point]
            binsCount[2] += 1
        elif frequency < 30:   # Beta  (12.5 - 30Hz)
            binsTotal[3] += outMag[point]
            binsCount[3] += 1
        elif frequency < 120:  # Gamma (30 - 120Hz)
            binsTotal[4] += outMag[point]
            binsCount[4] += 1

    # Compute absolute averages
    abs_avg_bins = [total / count if count != 0 else 0 for total, count in zip(binsTotal, binsCount)]

    # Convert to RELATIVE power (normalize by total)
    total_power = sum(abs_avg_bins)
    if total_power > 0:
        original_relative_bins = [b / total_power for b in abs_avg_bins]
    else:
        original_relative_bins = [0.0] * 5

    # --- Coherence-based Features ---
    coherence_features = []
    channel_pairs = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)] # 6 unique pairs

    freq_bands = {
        'Delta': (0.5, 4),
        'Theta': (4, 7.5),
        'Alpha': (7.5, 12.5),
        'Beta': (12.5, 30),
        'Gamma': (30, 120)
    }

    nperseg = min(256, len(channels_filtered[0]) // 4)
    if nperseg < 8:
        if debug: print(f"Coherence feature generation: Signal too short for coherence (len={len(channels_filtered[0])})")
        return None
    noverlap = nperseg // 2

    for ch1_idx, ch2_idx in channel_pairs:
        ch1 = channels_filtered[ch1_idx]
        ch2 = channels_filtered[ch2_idx]

        if len(ch1) < nperseg or len(ch2) < nperseg:
            if debug: print(f"Coherence feature generation: Channel pair {ch1_idx}-{ch2_idx} too short for coherence.")
            return None

        try:
            f, Cxy = signal.coherence(ch1, ch2, fs=SampleRate, nperseg=nperseg, noverlap=noverlap)
            for band_name, (low, high) in freq_bands.items():
                band_indices = np.where((f >= low) & (f < high))
                if len(band_indices[0]) > 0:
                    avg_coherence = np.mean(Cxy[band_indices])
                else:
                    avg_coherence = 0.0
                coherence_features.append(avg_coherence)
        except Exception as e:
            if debug: print(f"Coherence calculation for pair {ch1_idx}-{ch2_idx} failed: {e}")
            coherence_features.extend([0.0] * len(freq_bands))

    # --- Calculate 3 Derived Ratios (from original relative power bins) ---
    delta, theta, alpha, beta, gamma = original_relative_bins[:5]
    alpha_theta_ratio = alpha / (theta + 1e-8)
    beta_alpha_ratio = beta / (alpha + 1e-8)
    low_freq_high_freq = (delta + theta) / (beta + gamma + 1e-8)

    # Combine all 38 features
    final_features = original_relative_bins + coherence_features + \
                     [alpha_theta_ratio, beta_alpha_ratio, low_freq_high_freq]

    if debug:
        print(f"Original relative bins: {original_relative_bins}")
        print(f"Coherence features (first 5 of 30): {coherence_features[:5]}")
        print(f"Derived ratios: {[alpha_theta_ratio, beta_alpha_ratio, low_freq_high_freq]}")
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
                 label_encoder_path='models/label_encoder.pkl'):
        """
        Initialize the emotion predictor with model, scaler, and label encoder.

        Args:
            model_path: Path to the trained EmotionNet model (.pth file)
            scaler_path: Path to the StandardScaler (.pkl file)
            label_encoder_path: Path to the LabelEncoder (.pkl file)
        """
        self.model_path = model_path
        self.scaler_path = scaler_path
        self.label_encoder_path = label_encoder_path
        self.SampleRate = 256  # Muse S sampling rate

        # Load model and preprocessors
        self._load_label_encoder() # Load label encoder first to get num_classes
        self._load_model()
        self._load_scaler()

        print("EmotionPredictor initialized successfully!")

    def _load_model(self):
        """Load the trained EmotionNet model."""
        try:
            # Initialize EmotionNet with correct architecture parameters
            # input_dim=38 (5 power bins + 30 coherence features + 3 derived ratios)
            # num_classes from label_encoder
            # hidden=128, dropout=0.1 from Optuna's best hyperparameters
            self.model = EmotionNet(
                input_dim=38,
                num_classes=len(self.label_encoder.classes_),
                hidden=128,
                dropout=0.1
            ).to(device)

            # Load the saved state dict
            self.model.load_state_dict(torch.load(self.model_path, map_location=device))
            self.model.eval()  # Set to evaluation mode

            print(f"✓ EmotionNet model loaded from: {self.model_path}")
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
                self.label_encoder = pickle.load(f)
            print(f"✓ Label encoder loaded from: {self.label_encoder_path}")
        except Exception as e:
            raise FileNotFoundError(f"Failed to load label encoder: {e}")

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

