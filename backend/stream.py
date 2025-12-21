from pylsl import StreamInlet, resolve_byprop
import time

def main():
    print("Looking for an EEG stream...")
    # Find the stream BlueMuse is broadcasting
    streams = resolve_byprop('type', 'EEG', timeout=2)
    
    if not streams:
        print("No EEG stream found. Is BlueMuse 'Start Streaming' active?")
        return

    inlet = StreamInlet(streams[0])
    print("Connected! Printing EEG signals (TP9, AF7, AF8, TP10, AUX)...")

    try:
        while True:
            # pull_sample() gets the latest data point
            sample, timestamp = inlet.pull_sample()
            
            if sample:
                # Round to 2 decimal places for readability
                formatted_sample = [round(val, 2) for val in sample]
                print(f"EEG: {formatted_sample}", end='\r') # '\r' overwrites the same line
                
            # Optional: Slow down the print slightly to make it readable
            time.sleep(0.01) 
            
    except KeyboardInterrupt:
        print("\nStream stopped by user.")

if __name__ == '__main__':
    main()
