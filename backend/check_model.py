import pickle
import pandas as pd
import numpy as np

# Check label encoder
print("=" * 50)
print("LABEL ENCODER CHECK")
print("=" * 50)
with open('models/label_encoder.pkl', 'rb') as f:
    le = pickle.load(f)
    print(f"Classes: {le.classes_}")
    print(f"Mapping: {dict(zip(range(len(le.classes_)), le.classes_))}")

# Check scaler
print("\n" + "=" * 50)
print("SCALER CHECK")
print("=" * 50)
with open('models/scaler.pkl', 'rb') as f:
    scaler = pickle.load(f)
    print(f"Mean: {scaler.mean_}")
    print(f"Scale (std): {scaler.scale_}")
    print(f"Feature names: Delta, Theta, Alpha, Beta, Gamma")
    
print("\n" + "=" * 50)
print("SAMPLE DATA FROM TRAINING")
print("=" * 50)

# Try to find and load a sample CSV to see the scale of training data
import os
csv_path = "../../NeuroTune/emotions_dataset/Happy/Brainwaves_Happy_1.csv"
if os.path.exists(csv_path):
    channel = []
    with open(csv_path, "r") as data:
        for line in data:
            line = line.split(",")
            channel.append(float(line[1]))
    
    # Compute FFT bins like in training
    SampleRate = 256
    fftData = np.fft.fft(channel)
    freq = np.fft.fftfreq(len(channel)) * SampleRate
    
    outFftData = fftData[1:int(len(fftData)/2)]
    outMag = outFftData.real**2 + outFftData.imag**2
    outFreq = freq[1:int(len(freq)/2)]
    
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
    
    binsAverage = [total / count if count != 0 else 0 
                  for total, count in zip(binsTotal, binsCount)]
    
    print(f"Sample CSV brainwave bins:")
    print(f"  Delta:  {binsAverage[0]:.2f}")
    print(f"  Theta:  {binsAverage[1]:.2f}")
    print(f"  Alpha:  {binsAverage[2]:.2f}")
    print(f"  Beta:   {binsAverage[3]:.2f}")
    print(f"  Gamma:  {binsAverage[4]:.2f}")
    
    # Show what happens after scaling
    bins_scaled = scaler.transform([binsAverage])
    print(f"\nAfter scaling: {bins_scaled[0]}")
else:
    print("Sample CSV not found")
