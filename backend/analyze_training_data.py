"""
Analyze all training CSV files to get true feature distribution statistics
"""
import numpy as np
import pickle
from pathlib import Path
import sys
sys.path.append('.')
from KAN_prediction import getAdvancedEEGFeatures

# Path to your training data
training_data_path = Path('C:/Users/Aaditya Nair/Documents/Third-year-project-stuff/NeuroTune/emotions_dataset')

print("="*60)
print("TRAINING DATA ANALYSIS")
print("="*60)
print(f"Scanning: {training_data_path}")

if not training_data_path.exists():
    print(f"ERROR: Path not found: {training_data_path}")
    exit(1)

# Collect features from all training files
all_features = []
all_emotions = []
emotion_features = {'Happy': [], 'Sad': [], 'Angry': [], 'Relaxed': []}
file_count = 0
skipped_count = 0

for emotion_dir in training_data_path.iterdir():
    if not emotion_dir.is_dir():
        continue
    
    emotion = emotion_dir.name
    print(f"\nProcessing {emotion}...")
    
    csv_files = list(emotion_dir.glob("*.csv"))
    print(f"  Found {len(csv_files)} CSV files")
    
    for csv_file in csv_files:
        try:
            # Load CSV file
            channels_data = [[], [], [], []]
            with open(csv_file, 'r') as f:
                for line in f:
                    parts = line.strip().split(',')
                    for i in range(4):
                        channels_data[i].append(float(parts[i]))
            
            channels_list = [np.array(ch) for ch in channels_data]
            
            # Extract features
            features = getAdvancedEEGFeatures(channels_list, SampleRate=256, debug=False)
            
            if features is not None:
                all_features.append(features)
                all_emotions.append(emotion)
                emotion_features[emotion].append(features)
                file_count += 1
            else:
                skipped_count += 1
                
        except Exception as e:
            print(f"    Error processing {csv_file.name}: {e}")
            skipped_count += 1

print(f"\n{'='*60}")
print(f"Successfully processed: {file_count} files")
print(f"Skipped: {skipped_count} files")
print(f"{'='*60}")

if file_count == 0:
    print("ERROR: No files processed successfully")
    exit(1)

# Convert to numpy array for analysis
all_features = np.array(all_features)

print(f"\nTotal samples: {len(all_features)}")
print(f"Features per sample: {all_features.shape[1]}")

# Analyze power bins (first 5 features)
print(f"\n{'='*60}")
print("POWER BIN STATISTICS (Relative Power)")
print(f"{'='*60}")

band_names = ['Delta (0-4Hz)', 'Theta (4-7.5Hz)', 'Alpha (7.5-12.5Hz)', 
              'Beta (12.5-30Hz)', 'Gamma (30-120Hz)']

print(f"\n{'Band':<20} {'Mean':>8} {'Std':>8} {'Min':>8} {'Max':>8} {'Median':>8}")
print("-" * 60)

for i, band in enumerate(band_names):
    mean = np.mean(all_features[:, i])
    std = np.std(all_features[:, i])
    min_val = np.min(all_features[:, i])
    max_val = np.max(all_features[:, i])
    median = np.median(all_features[:, i])
    print(f"{band:<20} {mean:>8.4f} {std:>8.4f} {min_val:>8.4f} {max_val:>8.4f} {median:>8.4f}")

# Per-emotion statistics
print(f"\n{'='*60}")
print("POWER BINS BY EMOTION")
print(f"{'='*60}")

for emotion in ['Happy', 'Sad', 'Angry', 'Relaxed']:
    if len(emotion_features[emotion]) == 0:
        print(f"\n{emotion}: No data")
        continue
    
    emotion_data = np.array(emotion_features[emotion])
    print(f"\n{emotion} (n={len(emotion_data)}):")
    print(f"{'Band':<20} {'Mean':>8} {'Std':>8}")
    print("-" * 30)
    
    for i, band in enumerate(['Delta', 'Theta', 'Alpha', 'Beta', 'Gamma']):
        mean = np.mean(emotion_data[:, i])
        std = np.std(emotion_data[:, i])
        print(f"{band:<20} {mean:>8.4f} {std:>8.4f}")

# Compare to your live data
print(f"\n{'='*60}")
print("COMPARISON: TRAINING vs YOUR LIVE DATA")
print(f"{'='*60}")

live_power = np.array([0.627524, 0.296388, 0.063135, 0.012628, 0.000324])
training_mean = np.mean(all_features[:, :5], axis=0)
training_std = np.std(all_features[:, :5], axis=0)

print(f"\n{'Band':<20} {'Training Mean':>15} {'Your Live':>12} {'Diff':>10} {'Z-Score':>10}")
print("-" * 70)

for i, band in enumerate(['Delta', 'Theta', 'Alpha', 'Beta', 'Gamma']):
    t_mean = training_mean[i]
    live_val = live_power[i]
    diff = live_val - t_mean
    z_score = (live_val - t_mean) / (training_std[i] + 1e-8)
    
    marker = "🔴" if abs(z_score) > 2 else "🟡" if abs(z_score) > 1 else "🟢"
    print(f"{band:<20} {t_mean:>15.4f} {live_val:>12.4f} {diff:>+10.4f} {z_score:>+10.2f} {marker}")

print(f"\nZ-Score interpretation:")
print(f"  🟢 |z| < 1.0: Normal variation")
print(f"  🟡 1.0 < |z| < 2.0: Moderate difference")
print(f"  🔴 |z| > 2.0: Large difference (>2 std deviations)")

# Coherence statistics
print(f"\n{'='*60}")
print("COHERENCE FEATURES (30 features)")
print(f"{'='*60}")

coherence_mean = np.mean(all_features[:, 5:35], axis=0)
coherence_std = np.std(all_features[:, 5:35], axis=0)

print(f"Overall statistics:")
print(f"  Mean: {np.mean(coherence_mean):.4f}")
print(f"  Std:  {np.mean(coherence_std):.4f}")
print(f"  Range: [{np.min(all_features[:, 5:35]):.4f}, {np.max(all_features[:, 5:35]):.4f}]")

# Derived ratios
print(f"\n{'='*60}")
print("DERIVED RATIOS (3 features)")
print(f"{'='*60}")

ratio_names = ['Alpha/Theta', 'Beta/Alpha', 'LowFreq/HighFreq']
print(f"\n{'Ratio':<20} {'Mean':>10} {'Std':>10} {'Min':>10} {'Max':>10}")
print("-" * 60)

for i, name in enumerate(ratio_names):
    idx = 35 + i
    mean = np.mean(all_features[:, idx])
    std = np.std(all_features[:, idx])
    min_val = np.min(all_features[:, idx])
    max_val = np.max(all_features[:, idx])
    print(f"{name:<20} {mean:>10.4f} {std:>10.4f} {min_val:>10.4f} {max_val:>10.4f}")

# Save statistics
print(f"\n{'='*60}")
print("SAVING STATISTICS")
print(f"{'='*60}")

training_stats = {
    'power_mean': training_mean,
    'power_std': training_std,
    'coherence_mean': coherence_mean,
    'coherence_std': coherence_std,
    'n_samples': file_count,
    'emotions': list(emotion_features.keys())
}

with open('training_statistics.pkl', 'wb') as f:
    pickle.dump(training_stats, f)

print(f"✓ Saved to: training_statistics.pkl")
print(f"\nYou can use these statistics to:")
print(f"1. Verify your live data is within expected ranges")
print(f"2. Normalize live data if needed")
print(f"3. Understand what the model was trained on")
