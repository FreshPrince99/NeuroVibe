"""
Collect training data directly from Muse headset for each emotion.
This ensures training and inference data have the same distribution.
"""
import numpy as np
import os
from pylsl import StreamInlet, resolve_byprop
from datetime import datetime

def collect_emotion_data(emotion_name, duration=30, output_dir='new_training_data'):
    """
    Collect EEG data for a specific emotion.
    
    Args:
        emotion_name: Name of emotion (Happy, Sad, Angry, Relaxed)
        duration: Duration in seconds to collect
        output_dir: Directory to save CSV files
    """
    print(f"\n{'='*60}")
    print(f"COLLECTING DATA FOR: {emotion_name.upper()}")
    print(f"{'='*60}")
    print(f"Duration: {duration} seconds")
    print(f"\nInstructions:")
    print(f"- Get into a {emotion_name.lower()} state")
    print(f"- Try to maintain that emotion for {duration} seconds")
    print(f"- Stay still to minimize artifacts")
    
    input(f"\nPress ENTER when ready to start recording {emotion_name}...")
    
    # Create output directory
    emotion_dir = os.path.join(output_dir, emotion_name)
    os.makedirs(emotion_dir, exist_ok=True)
    
    # Connect to stream
    print("\nConnecting to EEG stream...")
    streams = resolve_byprop('type', 'EEG', timeout=10)
    if not streams:
        print("ERROR: No EEG stream found!")
        print("Make sure BlueMuse is running and 'Start Streaming' is active.")
        return False
    
    inlet = StreamInlet(streams[0])
    print("Connected!")
    
    # Collect data
    print(f"\n🔴 RECORDING for {duration} seconds...")
    samples_list = []
    start_time = inlet.pull_sample()[1]
    
    try:
        while True:
            sample, timestamp = inlet.pull_sample()
            samples_list.append(sample[:4])  # First 4 channels
            
            elapsed = timestamp - start_time
            if elapsed >= duration:
                break
            
            # Progress indicator every 5 seconds
            if int(elapsed) % 5 == 0 and int(elapsed) > 0:
                remaining = duration - int(elapsed)
                print(f"   {int(elapsed)}s / {duration}s - {remaining}s remaining...")
        
        print("✓ Recording complete!")
        
    except KeyboardInterrupt:
        print("\n⚠️  Recording interrupted by user")
        return False
    
    # Convert to CSV format
    eeg_data = np.array(samples_list)
    
    # Generate filename
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = os.path.join(emotion_dir, f"Brainwaves_{emotion_name}_{timestamp_str}.csv")
    
    # Save as CSV (4 columns, one per channel)
    np.savetxt(filename, eeg_data, delimiter=',', fmt='%.6f')
    
    print(f"\n✓ Saved to: {filename}")
    print(f"  Samples: {len(eeg_data)} ({len(eeg_data)/256:.1f} seconds)")
    print(f"  Channels: {eeg_data.shape[1]}")
    
    # Show signal stats
    print(f"\n  Signal statistics:")
    for i in range(4):
        print(f"    Ch{i+1}: mean={np.mean(eeg_data[:, i]):7.2f} µV, std={np.std(eeg_data[:, i]):7.2f} µV")
    
    return True

def main():
    """
    Main function to collect training data for all emotions.
    """
    print("="*60)
    print("EEG TRAINING DATA COLLECTION")
    print("="*60)
    print("\nThis script will collect EEG data for each emotion.")
    print("You'll need to get into each emotional state and maintain it.")
    print("\nTips for better data:")
    print("- Find a quiet place with minimal distractions")
    print("- Ensure good electrode contact (check BlueMuse signal quality)")
    print("- Stay as still as possible during recording")
    print("- Take breaks between emotions to reset")
    print("- Record multiple sessions per emotion (3-5 recommended)")
    
    emotions = ['Happy', 'Sad', 'Angry', 'Relaxed']
    duration = 30  # seconds per recording
    sessions_per_emotion = 3
    
    print(f"\nConfiguration:")
    print(f"- Emotions: {', '.join(emotions)}")
    print(f"- Duration per session: {duration} seconds")
    print(f"- Sessions per emotion: {sessions_per_emotion}")
    print(f"- Total time: ~{len(emotions) * sessions_per_emotion * duration / 60:.1f} minutes")
    
    proceed = input("\nProceed with data collection? (yes/no): ")
    if proceed.lower() not in ['yes', 'y']:
        print("Data collection cancelled.")
        return
    
    # Collect data
    output_dir = 'new_training_data'
    successful_recordings = 0
    total_recordings = 0
    
    for emotion in emotions:
        print(f"\n{'='*60}")
        print(f"EMOTION: {emotion.upper()}")
        print(f"{'='*60}")
        print(f"Record {sessions_per_emotion} sessions of {duration} seconds each")
        
        for session in range(sessions_per_emotion):
            print(f"\n--- Session {session+1}/{sessions_per_emotion} ---")
            total_recordings += 1
            
            success = collect_emotion_data(emotion, duration, output_dir)
            if success:
                successful_recordings += 1
            
            if session < sessions_per_emotion - 1:
                print(f"\nTake a short break before next session...")
                input("Press ENTER when ready for next session...")
        
        if emotion != emotions[-1]:
            print(f"\n{'='*60}")
            print(f"Moving to next emotion: {emotions[emotions.index(emotion)+1]}")
            print(f"Take a break to reset your emotional state.")
            input("Press ENTER when ready...")
    
    # Summary
    print(f"\n{'='*60}")
    print("DATA COLLECTION COMPLETE")
    print(f"{'='*60}")
    print(f"Successful recordings: {successful_recordings}/{total_recordings}")
    print(f"Data saved to: {os.path.abspath(output_dir)}")
    print(f"\nNext steps:")
    print(f"1. Inspect the CSV files to verify data quality")
    print(f"2. Update your training notebook to use '{output_dir}' instead of 'emotions_dataset'")
    print(f"3. Retrain the model with this new data")
    print(f"4. Test live prediction again - it should work much better!")

if __name__ == "__main__":
    main()
