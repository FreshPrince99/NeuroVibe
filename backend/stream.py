## Old legacy code to connect locally to BlueMuse's LSL stream. Not used in production, but kept for reference.

from pylsl import StreamInlet, resolve_byprop
import time
import numpy as np

def main():
    print("Looking for an EEG stream...")
    # Find the stream BlueMuse is broadcasting
    streams = resolve_byprop('type', 'EEG', timeout=2)
    
    if not streams:
        print("No EEG stream found. Is BlueMuse 'Start Streaming' active?")
        return

    inlet = StreamInlet(streams[0])
    print("Connected! Printing EEG signals (TP9, AF7, AF8, TP10, AUX)...")
    print("Channel order: TP9, AF7, AF8, TP10, AUX")
    print("Sampling rate: 256 Hz")

    try:
        sample_count = 0
        while True:
            # pull_sample() gets the latest data point - blocks if no data available
            # Use timeout=0.0 to avoid blocking indefinitely
            sample, timestamp = inlet.pull_sample(timeout=0.1)
            
            if sample:
                # Round to 2 decimal places for readability
                # Only show first 4 channels (TP9, AF7, AF8, TP10) - AUX is 5th
                formatted_sample = [round(val, 2) for val in sample[:4]]
                sample_count += 1
                
                # Show every 10th sample to reduce spam
                if sample_count % 10 == 0:
                    print(f"Sample #{sample_count:5d} | EEG: {formatted_sample} | Timestamp: {timestamp:.3f}", end='\r')
            
    except KeyboardInterrupt:
        print(f"\n✓ Stream stopped by user. Received {sample_count} samples total.")

if __name__ == '__main__':
    main()
