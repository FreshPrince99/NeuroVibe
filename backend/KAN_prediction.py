"""Emotion Prediction Module (EmotionNet)
Loads the trained neural network and predicts emotions from real-time EEG data."""

import os
import pickle
import numpy as np
import pandas as pd
import torch
from torch import nn
from pylsl import StreamInlet, resolve_byprop
from sklearn.preprocessing import StandardScaler, LabelEncoder
import warnings
warnings.filterwarnings("ignore")


class EmotionNet(nn.Module):
    """Lightweight feedforward network for EEG-derived features."""

    def __init__(self, input_dim=8, num_classes=4, hidden=64, dropout=0.25):
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
            nn.Linear(hidden // 2, num_classes),
        )

    def forward(self, x):
        return self.net(x)


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
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # Load model and preprocessors
        self._load_model()
        self._load_scaler()
        self._load_label_encoder()
        
        print("EmotionPredictor initialized successfully!")
    
    def _load_model(self):
        """Load the trained EmotionNet model."""
        try:
            self.model = EmotionNet(input_dim=8, num_classes=4)
            self.model.load_state_dict(torch.load(self.model_path, map_location=self.device))
            self.model.to(self.device)
            self.model.eval()
            print(f"✓ Model loaded from: {self.model_path}")
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

    @staticmethod
    def _build_feature_vector(brainwave_bins):
        """
        Convert raw band powers into the 8-feature vector used during training.

        Args:
            brainwave_bins: List/array of relative band powers [Delta, Theta, Alpha, Beta, Gamma]

        Returns:
            np.ndarray of shape (8,)
        """
        if len(brainwave_bins) < 5:
            raise ValueError("Expected five brainwave bins (Delta, Theta, Alpha, Beta, Gamma)")

        delta, theta, alpha, beta, gamma = brainwave_bins[:5]
        alpha_theta_ratio = alpha / (theta + 1e-8)
        beta_alpha_ratio = beta / (alpha + 1e-8)
        low_freq_high_freq = (delta + theta) / (beta + gamma + 1e-8)

        return np.array([
            delta,
            theta,
            alpha,
            beta,
            gamma,
            alpha_theta_ratio,
            beta_alpha_ratio,
            low_freq_high_freq,
        ], dtype=float)
    
    def stream_eeg_data(self, duration=5):
        """
        Stream EEG data from the Muse headset via LSL (BlueMuse).
        
        Args:
            duration: Duration in seconds to collect data
            
        Returns:
            numpy array of EEG data [channels x samples]
        """
        print(f"Looking for EEG stream... (will collect data for {duration}s)")
        
        # Find the EEG stream from BlueMuse
        streams = resolve_byprop('type', 'EEG', timeout=5)
        
        if not streams:
            raise RuntimeError("No EEG stream found. Is BlueMuse 'Start Streaming' active?")
        
        inlet = StreamInlet(streams[0])
        print("✓ Connected to EEG stream!")
        
        # Collect data
        samples = []
        start_time = inlet.pull_sample()[1]
        
        try:
            while True:
                sample, timestamp = inlet.pull_sample()
                samples.append(sample[:4])  # Get first 4 channels (TP9, AF7, AF8, TP10)
                
                # Check if duration elapsed
                if timestamp - start_time >= duration:
                    break
                    
        except KeyboardInterrupt:
            print("\nStream interrupted by user.")
        
        # Convert to numpy array [samples x channels] then transpose to [channels x samples]
        eeg_data = np.array(samples).T
        print(f"✓ Collected {eeg_data.shape[1]} samples from {eeg_data.shape[0]} channels")
        
        return eeg_data
    
    def compute_brainwave_bins(self, eeg_data):
        """
        Compute power bins (Delta, Theta, Alpha, Beta, Gamma) from raw EEG data.
        Uses FFT to transform time-domain signal to frequency domain.
        
        Args:
            eeg_data: numpy array [channels x samples]
            
        Returns:
            List of 5 power bin values [Delta, Theta, Alpha, Beta, Gamma]
        """
        # Average across available channels to reduce electrode-specific noise
        channel = eeg_data.mean(axis=0).copy()
        
        # Apply low-pass filter to remove high-frequency noise (like in NeuroTune training)
        # This is CRITICAL - training data was filtered!
        from scipy import signal
        nyquist = self.SampleRate / 2
        cutoff = 30  # Hz - remove frequencies above 50Hz (line noise, artifacts)
        b, a = signal.butter(3, cutoff / nyquist, btype='low')
        channel = signal.filtfilt(b, a, channel)
        
        # Perform FFT
        fftData = np.fft.fft(channel)
        freq = np.fft.fftfreq(len(channel)) * self.SampleRate
        
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
            
            if frequency < 4:  # Delta (0 - 4Hz)
                binsTotal[0] += outMag[point]
                binsCount[0] += 1
            elif frequency < 7.5:  # Theta (4 - 7.5Hz)
                binsTotal[1] += outMag[point]
                binsCount[1] += 1
            elif frequency < 12.5:  # Alpha (7.5 - 12.5Hz)
                binsTotal[2] += outMag[point]
                binsCount[2] += 1
            elif frequency < 30:  # Beta (12.5 - 30Hz)
                binsTotal[3] += outMag[point]
                binsCount[3] += 1
            elif frequency < 120:  # Gamma (30 - 120Hz)
                binsTotal[4] += outMag[point]
                binsCount[4] += 1
        
        # Compute absolute averages
        binsAverage = [total / count if count != 0 else 0 
                      for total, count in zip(binsTotal, binsCount)]
        
        # Convert to RELATIVE power (normalize by total)
        # This makes features robust across sessions and signal magnitudes
        total_power = sum(binsAverage)
        if total_power > 0:
            binsAverage = [b / total_power for b in binsAverage]
        
        print(f"✓ Brainwave bins computed (relative power): Delta={binsAverage[0]:.4f}, "
              f"Theta={binsAverage[1]:.4f}, Alpha={binsAverage[2]:.4f}, "
              f"Beta={binsAverage[3]:.4f}, Gamma={binsAverage[4]:.4f}")
        
        return binsAverage
    
    def predict(self, brainwave_bins):
        """
        Predict emotion from brainwave power bins.
        
        Args:
            brainwave_bins: List of 5 values [Delta, Theta, Alpha, Beta, Gamma]
            
        Returns:
            Predicted emotion as string
        """
        # Build full feature vector (absolute + derived ratios)
        features = self._build_feature_vector(brainwave_bins).reshape(1, -1)

        # Standardize using the same scaler from training
        bins_scaled = self.scaler.transform(features)
        
        # DEBUG: Print scaled values
        print(f"   Scaled features: {bins_scaled[0]}")
        
        # Convert to tensor
        bins_tensor = torch.tensor(bins_scaled, dtype=torch.float32, device=self.device)
        
        # Make prediction
        with torch.no_grad():
            logits = self.model(bins_tensor)
            predicted_class_idx = torch.argmax(logits, dim=1).item()

            # DEBUG: Print raw logits
            print(f"   Raw logits: {logits[0].detach().cpu().numpy()}")
            print(f"   Predicted class: {predicted_class_idx}")
        
        # Use the persisted label encoder to decode class index
        try:
            predicted_emotion = self.label_encoder.inverse_transform([predicted_class_idx])[0]
        except Exception:
            # Fallback mapping if label encoder is unavailable
            emotion_map = {0: "Angry", 1: "Happy", 2: "Relaxed", 3: "Sad"}
            predicted_emotion = emotion_map.get(predicted_class_idx, "Unknown")
        
        # Map "Angry" to "Stressed" (as done in NeuroTune)
        if predicted_emotion == "Angry":
            predicted_emotion = "Stressed"
        
        return predicted_emotion
    
    def predict_from_stream(self, duration=5):
        """
        Complete pipeline: Stream EEG data, compute bins, and predict emotion.
        
        Args:
            duration: Duration in seconds to collect EEG data
            
        Returns:
            Predicted emotion as string
        """
        print("\n" + "="*50)
        print("Starting Emotion Prediction Pipeline")
        print("="*50)
        
        # Step 1: Stream EEG data
        eeg_data = self.stream_eeg_data(duration)
        
        # Step 2: Compute brainwave bins
        brainwave_bins = self.compute_brainwave_bins(eeg_data)
        
        # Step 3: Predict emotion
        emotion = self.predict(brainwave_bins)
        
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
                eeg_data = self.stream_eeg_data(duration)
                
                # Compute brainwave bins
                brainwave_bins = self.compute_brainwave_bins(eeg_data)
                
                # Predict emotion
                emotion = self.predict(brainwave_bins)
                
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
