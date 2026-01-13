"""
WebSocket server for real-time EEG emotion prediction.
Receives EEG samples from frontend and returns emotion predictions.
"""

from flask import Flask
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from CNN_prediction import CNNEmotionPredictor
import numpy as np
import sys

# Initialize Flask app
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Initialize the emotion predictor
print("Initializing CNNEmotionPredictor...")
try:
    predictor = CNNEmotionPredictor(
        model_path='models/eeg_emotion_prediction_model.keras'
    )
    print("✓ CNNEmotionPredictor ready!")
except Exception as e:
    print(f"❌ Failed to initialize predictor: {e}")
    sys.exit(1)

# Global buffer to store EEG samples
# We need 60 seconds of data at 256 Hz = 15360 samples
eeg_buffer = []
BUFFER_SIZE = predictor.required_samples
SAMPLE_RATE = 256
is_processing = False  # Flag to prevent multiple simultaneous predictions

@socketio.on('connect')
def handle_connect():
    """Handle client connection."""
    print('✓ Client connected')
    emit('status', {'message': 'Connected to emotion prediction server'})

@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection."""
    print('✗ Client disconnected')
    global eeg_buffer
    eeg_buffer = []  # Clear buffer on disconnect

@socketio.on('eeg_sample')
def handle_eeg_sample(data):
    """
    Handle incoming EEG sample from frontend.
    
    Expected data format:
    {
        'tp9': float,
        'af7': float,
        'af8': float,
        'tp10': float,
        'timestamp': float
    }
    """
    global eeg_buffer, is_processing
    
    try:
        # Skip if currently processing
        if is_processing:
            return
            
        # Validate data format
        if not all(key in data for key in ['tp9', 'af7', 'af8', 'tp10']):
            print(f"⚠️  Invalid data format: {data}")
            emit('error', {'message': 'Invalid data format'})
            return
        
        # Filter out None values - replace with 0 if signal is lost
        cleaned_data = {
            'tp9': data['tp9'] if data['tp9'] is not None else 0.0,
            'af7': data['af7'] if data['af7'] is not None else 0.0,
            'af8': data['af8'] if data['af8'] is not None else 0.0,
            'tp10': data['tp10'] if data['tp10'] is not None else 0.0,
            'timestamp': data.get('timestamp', 0)
        }
        
        # Add sample to buffer
        eeg_buffer.append(cleaned_data)
        
        # Log progress every 256 samples (1 second)
        if len(eeg_buffer) % 256 == 0:
            print(f"📊 Received {len(eeg_buffer)}/{BUFFER_SIZE} samples ({len(eeg_buffer)/SAMPLE_RATE:.1f}s)")
        
        # Once we have enough samples (60 seconds), make a prediction
        if len(eeg_buffer) >= BUFFER_SIZE and not is_processing:
            is_processing = True  # Set flag to prevent re-entry
            print(f"\n🔄 Buffer full with {len(eeg_buffer)} samples, processing...")
            
            try:
                # Convert buffer to channel arrays (as numpy arrays)
                channels_data = {
                    'tp9': np.array([sample['tp9'] for sample in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                    'af7': np.array([sample['af7'] for sample in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                    'af8': np.array([sample['af8'] for sample in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                    'tp10': np.array([sample['tp10'] for sample in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64)
                }
                
                # Calculate channel averages for display
                channel_means = {
                    'TP9': np.mean(channels_data['tp9']),
                    'AF7': np.mean(channels_data['af7']),
                    'AF8': np.mean(channels_data['af8']),
                    'TP10': np.mean(channels_data['tp10'])
                }
                
                print(f"📈 Computing PSD from {channels_data['tp9'].shape[0]} samples per channel...")

                emotion, raw_vad, clamped_vad = predictor.predict_emotion(channels_data)

                # Save timestamp and buffer size before clearing
                last_timestamp = eeg_buffer[-1]['timestamp'] if eeg_buffer else 0
                buffer_size = len(eeg_buffer)

                # Print clean summary
                print("\n" + "="*60)
                print(f"🧠 EMOTION: {emotion.upper()}")
                print("-"*60)
                print(
                    f"   VAD (raw): {raw_vad.valence:6.2f}, "
                    f"{raw_vad.arousal:6.2f}, {raw_vad.dominance:6.2f}"
                )
                print(
                    f"   VAD (1-9): {clamped_vad.valence:6.2f}, "
                    f"{clamped_vad.arousal:6.2f}, {clamped_vad.dominance:6.2f}"
                )
                print(f"   TP9:  {channel_means['TP9']:8.2f} µV")
                print(f"   AF7:  {channel_means['AF7']:8.2f} µV")
                print(f"   AF8:  {channel_means['AF8']:8.2f} µV")
                print(f"   TP10: {channel_means['TP10']:8.2f} µV")
                print("="*60 + "\n")

                # Send prediction back to client
                emit('emotion_prediction', {
                    'emotion': emotion,
                    'vad': {
                        'valence': clamped_vad.valence,
                        'arousal': clamped_vad.arousal,
                        'dominance': clamped_vad.dominance
                    },
                    'raw_vad': {
                        'valence': raw_vad.valence,
                        'arousal': raw_vad.arousal,
                        'dominance': raw_vad.dominance
                    },
                    'timestamp': last_timestamp,
                    'samples_processed': buffer_size
                })
            
            except Exception as processing_error:
                print(f"❌ Processing error: {processing_error}\n")
                import traceback
                traceback.print_exc()
                emit('error', {'message': f'Processing failed: {str(processing_error)}'})
            finally:
                # Always clear buffer and reset flag, even if there was an error
                eeg_buffer = []
                is_processing = False
                print(f"🔄 Buffer cleared, ready for next prediction\n")
                
    except Exception as e:
        is_processing = False  # Reset flag on error
        print(f"❌ Error: {e}\n")
        import traceback
        traceback.print_exc()
        emit('error', {'message': str(e)})
        eeg_buffer = []

@socketio.on('reset_buffer')
def handle_reset_buffer():
    """Reset the EEG buffer."""
    global eeg_buffer
    eeg_buffer = []
    print('Buffer reset')
    emit('status', {'message': 'Buffer reset'})

@app.route('/health')
def health_check():
    """Simple health check endpoint."""
    return {
        'status': 'ok',
        'predictor_loaded': predictor is not None,
        'buffer_size': len(eeg_buffer)
    }

if __name__ == '__main__':
    print("\n" + "="*60)
    print("🧠 EEG Emotion Prediction WebSocket Server")
    print("="*60)
    print(f"Server starting on http://localhost:5000")
    print(f"Buffer size: {BUFFER_SIZE} samples ({BUFFER_SIZE/SAMPLE_RATE}s)")
    print("Waiting for connections...")
    print("="*60 + "\n")
    
    # Run the Flask-SocketIO server
    # Note: use_reloader=False prevents Flask reloader conflicts with SocketIO
    socketio.run(
        app,
        host='0.0.0.0',
        port=5000,
        debug=True,
        use_reloader=False,  # Disable Flask reloader to fix SocketIO compatibility
        allow_unsafe_werkzeug=True
    )
