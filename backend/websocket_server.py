"""
WebSocket server for real-time EEG emotion prediction.
Receives EEG samples from frontend and returns emotion predictions.
"""

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from CNN_prediction import CNNEmotionPredictor
from LSTM_prediction import LSTMEmotionPredictor
from KAN_prediction import EmotionPredictor as KANEmotionPredictor
from emotion import RuleBasedEmotionPredictor
from likedislike import LikeDislikePredictor, USER_PKL
import numpy as np
import os
import sys
import argparse
import threading
import time
from collections import Counter

# Parse command line arguments
parser = argparse.ArgumentParser(description='EEG Emotion Prediction WebSocket Server')
parser.add_argument(
    '--model', type=str, default='rule',
    choices=['cnn', 'lstm', 'kan', 'rule'],
    help='Choose prediction model: cnn, lstm, kan, or rule (default: rule)'
)
args = parser.parse_args()

# Initialize Flask app
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading',
                    ping_timeout=120, ping_interval=25)

# Initialize the emotion predictor based on argument
MODEL_TYPE = args.model.upper()
print(f"Initializing {MODEL_TYPE} Emotion Predictor...")
try:
    if args.model == 'cnn':
        predictor = CNNEmotionPredictor(
            model_path='models/eeg_emotion_prediction_model.keras'
        )
    elif args.model == 'lstm':
        predictor = LSTMEmotionPredictor(
            model_path='models/lstm_model.h5'
        )
    elif args.model == 'kan':
        predictor = KANEmotionPredictor(
            model_path='models/mood_model.pth',
            scaler_path='models/scaler.pkl',
            label_encoder_path='models/label_encoder.pkl'
        )
    else:  # rule (default)
        predictor = RuleBasedEmotionPredictor()
    print(f"✓ {MODEL_TYPE} Predictor ready!")
except Exception as e:
    print(f"❌ Failed to initialize predictor: {e}")
    sys.exit(1)

# Initialize Like/Dislike predictor (non-fatal if models are missing)
print("Initializing Like/Dislike Predictor...")
try:
    ld_predictor = LikeDislikePredictor()
except Exception as e:
    print(f"⚠️  Like/Dislike predictor unavailable: {e}")
    ld_predictor = None

# Global buffers for EEG and PPG samples
eeg_buffer = []
ppg_buffer: list = []   # raw PPG float values (~64 Hz, Muse 2)
ld_buffer:  list = []   # separate 4-s window buffer for like/dislike (1024 samples)
BUFFER_SIZE = predictor.required_samples
LD_BUFFER_SIZE = 1024   # 4 s @ 256 Hz — matches model window
SAMPLE_RATE = 256
is_processing = False  # Flag to prevent multiple simultaneous predictions
ld_is_processing = False

# Emotion log: list of (wall_clock_time, emotion_string) recorded each prediction
emotion_log: list = []
emotion_log_lock = threading.Lock()
session_start = time.time()

def _emotion_reporter():
    """Daemon thread: every 60 s, print a tally of all emotions recorded so far."""
    while True:
        time.sleep(60)
        elapsed = int(time.time() - session_start)
        with emotion_log_lock:
            if not emotion_log:
                print(f"\n\U0001f4ca [Emotion Report | {elapsed//60}m {elapsed%60}s] No emotions recorded yet.\n")
                continue
            counts = Counter(e for _, e in emotion_log)
            total = sum(counts.values())
            print("\n" + "="*60)
            print(f"\U0001f4ca EMOTION REPORT  (session time: {elapsed//60}m {elapsed%60}s, {total} readings)")
            print("-"*60)
            for em, cnt in counts.most_common():
                pct = cnt / total * 100
                bar = "\u2588" * max(1, int(pct / 5))
                print(f"   {em:<16} {bar:<20} {pct:5.1f}%  ({cnt} readings)")
            dominant = counts.most_common(1)[0][0]
            print(f"\n   \u25b6 Dominant emotion: {dominant.upper()}")
            print("="*60 + "\n")

_reporter_thread = threading.Thread(target=_emotion_reporter, daemon=True, name="emotion-reporter")
_reporter_thread.start()

@socketio.on('connect')
def handle_connect():
    """Handle client connection."""
    print('✓ Client connected')
    emit('status', {'message': 'Connected to emotion prediction server'})

@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection."""
    print('✗ Client disconnected')
    global eeg_buffer, ppg_buffer, ld_buffer
    eeg_buffer = []
    ppg_buffer = []
    ld_buffer  = []
    if args.model == 'rule':
        predictor.reset()  # clear prediction history

@socketio.on('ppg_sample')
def handle_ppg_sample(data):
    """
    Handle a single PPG sample from the frontend.

    Expected data format: {'value': float, 'timestamp': float}
    The frontend emits individual PPG values at ~64 Hz (Muse 2).
    """
    global ppg_buffer
    try:
        value = data.get('value')
        if value is not None:
            ppg_buffer.append(float(value))
            # Keep at most 30 seconds of PPG history (64 Hz × 30 = 1920 samples)
            if len(ppg_buffer) > 1920:
                ppg_buffer = ppg_buffer[-1920:]
    except Exception as e:
        print(f"⚠️  PPG sample error: {e}")


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
    global eeg_buffer, ppg_buffer, is_processing

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
            'tp9':  data['tp9']  if data['tp9']  is not None else 0.0,
            'af7':  data['af7']  if data['af7']  is not None else 0.0,
            'af8':  data['af8']  if data['af8']  is not None else 0.0,
            'tp10': data['tp10'] if data['tp10'] is not None else 0.0,
            'timestamp': data.get('timestamp', 0),
        }
        
        # Add sample to both EEG and Like/Dislike buffers
        eeg_buffer.append(cleaned_data)
        ld_buffer.append(cleaned_data)

        # ── Like/Dislike prediction (every 4-s window, non-blocking) ──────
        if ld_predictor and len(ld_buffer) >= LD_BUFFER_SIZE and not ld_is_processing:
            _run_ld_prediction(list(ld_buffer[:LD_BUFFER_SIZE]))
            # Slide window by half to get more frequent predictions
            del ld_buffer[:LD_BUFFER_SIZE // 2]

        # Log progress every 256 samples (1 second)
        if len(eeg_buffer) % 256 == 0:
            print(f"📊 Received {len(eeg_buffer)}/{BUFFER_SIZE} samples ({len(eeg_buffer)/SAMPLE_RATE:.1f}s)")
        
        # Once we have enough samples, make a prediction
        if len(eeg_buffer) >= BUFFER_SIZE and not is_processing:
            is_processing = True  # Set flag to prevent re-entry
            print(f"\n🔄 Buffer full with {len(eeg_buffer)} samples, processing...")

            try:
                # Convert buffer to channel arrays (as numpy arrays)
                channels_data = {
                    'tp9':  np.array([s['tp9']  for s in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                    'af7':  np.array([s['af7']  for s in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                    'af8':  np.array([s['af8']  for s in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                    'tp10': np.array([s['tp10'] for s in eeg_buffer[:BUFFER_SIZE]], dtype=np.float64),
                }

                # Snapshot PPG buffer for this prediction window
                ppg_snapshot = np.array(ppg_buffer, dtype=np.float64) if ppg_buffer else None

                # Calculate channel averages for display
                channel_means = {k.upper(): float(np.mean(v)) for k, v in channels_data.items()}

                print(f"📈 Computing features from {channels_data['tp9'].shape[0]} samples per channel "
                      f"({'with' if ppg_snapshot is not None else 'no'} PPG, {len(ppg_buffer)} samples)...")

                # ── Run prediction ──────────────────────────────────────────
                raw_vad     = None
                clamped_vad = None
                prediction  = None
                scores      = None
                ppg_info    = None

                if args.model == 'cnn':
                    emotion, raw_vad, clamped_vad = predictor.predict_emotion(channels_data)

                elif args.model == 'lstm':
                    emotion, prediction = predictor.predict_emotion(channels_data)

                elif args.model == 'kan':
                    eeg_channels_list = [
                        channels_data['tp9'],
                        channels_data['af7'],
                        channels_data['af8'],
                        channels_data['tp10'],
                    ]
                    advanced_features = predictor.compute_all_advanced_features(eeg_channels_list, debug=False)
                    emotion = predictor.predict(advanced_features)

                else:  # rule (default)
                    emotion, scores = predictor.predict_emotion(channels_data, ppg_data=ppg_snapshot)
                    # Also extract PPG features for display / response
                    from emotion import extract_ppg_features
                    ppg_feat = extract_ppg_features(ppg_snapshot)
                    if ppg_feat.available:
                        ppg_info = {'bpm': ppg_feat.bpm, 'rmssd': ppg_feat.rmssd}

                # ── Save metadata before clearing ───────────────────────────
                last_timestamp = eeg_buffer[-1]['timestamp'] if eeg_buffer else 0
                buffer_size    = len(eeg_buffer)

                # ── Console summary ─────────────────────────────────────────
                print("\n" + "="*60)
                print(f"🧠 EMOTION: {emotion.upper()}  [{MODEL_TYPE}]")
                print("-"*60)

                if args.model == 'cnn':
                    print(f"   VAD (raw): {raw_vad.valence:6.2f}, {raw_vad.arousal:6.2f}, {raw_vad.dominance:6.2f}")
                    print(f"   VAD (1-9): {clamped_vad.valence:6.2f}, {clamped_vad.arousal:6.2f}, {clamped_vad.dominance:6.2f}")

                elif args.model == 'lstm':
                    print(f"   Negative:  {prediction.negative_prob:6.2%}")
                    print(f"   Neutral:   {prediction.neutral_prob:6.2%}")
                    print(f"   Positive:  {prediction.positive_prob:6.2%}")

                elif args.model == 'rule' and scores is not None:
                    sd = scores.as_dict()
                    for em, sc_val in sorted(sd.items(), key=lambda x: -x[1]):
                        bar_len = max(1, int(sc_val * 20))
                        print(f"   {em:<8} {'█' * bar_len:<20} {sc_val:.3f}")
                    if ppg_info:
                        print(f"   HR: {ppg_info['bpm']} bpm   RMSSD: {ppg_info['rmssd']} ms")

                for ch, mean in channel_means.items():
                    print(f"   {ch:<4}: {mean:8.2f} µV")
                print("="*60 + "\n")

                # ── Build and emit response ──────────────────────────────────
                response_data: dict = {
                    'emotion':           emotion,
                    'timestamp':         last_timestamp,
                    'samples_processed': buffer_size,
                }

                if args.model == 'cnn':
                    response_data['vad'] = {
                        'valence':   clamped_vad.valence,
                        'arousal':   clamped_vad.arousal,
                        'dominance': clamped_vad.dominance,
                    }
                    response_data['raw_vad'] = {
                        'valence':   raw_vad.valence,
                        'arousal':   raw_vad.arousal,
                        'dominance': raw_vad.dominance,
                    }
                elif args.model == 'lstm':
                    response_data['probabilities'] = {
                        'negative': prediction.negative_prob,
                        'neutral':  prediction.neutral_prob,
                        'positive': prediction.positive_prob,
                    }
                elif args.model == 'rule':
                    if scores is not None:
                        response_data['scores'] = scores.as_dict()
                    if ppg_info:
                        response_data['ppg'] = ppg_info

                emit('emotion_prediction', response_data)

                # Record for periodic reporter
                with emotion_log_lock:
                    emotion_log.append((time.time(), emotion))

            except Exception as processing_error:
                print(f"❌ Processing error: {processing_error}\n")
                import traceback
                traceback.print_exc()
                emit('error', {'message': f'Processing failed: {str(processing_error)}'})
            finally:
                eeg_buffer    = []
                is_processing = False
                print(f"🔄 Buffer cleared, ready for next prediction\n")
                
    except Exception as e:
        is_processing = False  # Reset flag on error
        print(f"❌ Error: {e}\n")
        import traceback
        traceback.print_exc()
        emit('error', {'message': str(e)})
        eeg_buffer = []

def _run_ld_prediction(window_samples: list) -> None:
    """Run like/dislike prediction in a background thread (fire-and-forget)."""
    global ld_is_processing
    if ld_is_processing or ld_predictor is None:
        return
    ld_is_processing = True

    def _predict():
        global ld_is_processing
        try:
            win = np.array(
                [
                    [s["tp9"]  for s in window_samples],
                    [s["af7"]  for s in window_samples],
                    [s["af8"]  for s in window_samples],
                    [s["tp10"] for s in window_samples],
                ],
                dtype=np.float32,
            )
            result = ld_predictor.predict(win)
            socketio.emit("likedislike_prediction", result)
        except Exception as ex:
            print(f"⚠️  Like/dislike prediction error: {ex}")
        finally:
            ld_is_processing = False

    threading.Thread(target=_predict, daemon=True).start()


@socketio.on('reset_buffer')
def handle_reset_buffer():
    """Reset the EEG and PPG buffers."""
    global eeg_buffer, ppg_buffer, ld_buffer
    eeg_buffer = []
    ppg_buffer = []
    ld_buffer  = []
    if args.model == 'rule':
        predictor.reset()
    print('Buffer reset')
    emit('status', {'message': 'Buffer reset'})

@app.route('/health')
def health_check():
    """Simple health check endpoint."""
    return jsonify({
        'status':            'ok',
        'model':             MODEL_TYPE,
        'predictor_loaded':  predictor is not None,
        'ld_predictor':      ld_predictor is not None,
        'ld_user_profile':   bool(ld_predictor and ld_predictor.has_user_profile()),
        'eeg_buffer_size':   len(eeg_buffer),
        'ppg_buffer_size':   len(ppg_buffer),
        'buffer_needed':     BUFFER_SIZE,
    })


@app.route('/user/exists', methods=['GET'])
def user_exists():
    """Check whether a user calibration profile (user.pkl) exists."""
    exists = os.path.exists(USER_PKL)
    return jsonify({'exists': exists})


@app.route('/user/delete', methods=['DELETE'])
def user_delete():
    """Delete the current user profile so the calibration flow re-runs."""
    if ld_predictor:
        ld_predictor.delete_user_profile()
    elif os.path.exists(USER_PKL):
        os.remove(USER_PKL)
    return jsonify({'deleted': True})


@app.route('/calibration/build', methods=['POST'])
def calibration_build():
    """
    Receive baseline + calibration EEG data from the frontend setup flow,
    then build and persist the user profile.

    Expected JSON body:
    {
        "baseline_samples":     [ [{tp9,af7,af8,tp10}, ...], ... ],  // list of windows
        "calibration_samples":  [ [{tp9,af7,af8,tp10}, ...], ... ],  // list of windows
        "labels":               [0, 1, 0, ...]                       // per calibration window
    }
    Each window is a flat list of dicts with keys tp9/af7/af8/tp10.
    Window size must be 1024 samples (4 s @ 256 Hz).
    """
    if ld_predictor is None:
        return jsonify({'error': 'LikeDislike predictor failed to initialise — check server logs'}), 503

    try:
        body = request.get_json(force=True)
        if not body:
            return jsonify({'error': 'Empty request body'}), 400

        def _to_array(window_list):
            """Convert a list of dicts to (4, N) np.ndarray."""
            return np.array([
                [s['tp9']  for s in window_list],
                [s['af7']  for s in window_list],
                [s['af8']  for s in window_list],
                [s['tp10'] for s in window_list],
            ], dtype=np.float32)

        baseline_windows    = [_to_array(w) for w in body['baseline_samples']]
        calibration_windows = [_to_array(w) for w in body['calibration_samples']]
        labels              = [int(l) for l in body['labels']]

        if len(calibration_windows) != len(labels):
            return jsonify({'error': 'calibration_samples and labels length mismatch'}), 400
        if len(calibration_windows) == 0:
            return jsonify({'error': 'No calibration windows provided'}), 400

        print(f"🧠 Building user profile: "
              f"{len(baseline_windows)} baseline windows, "
              f"{len(calibration_windows)} cal windows, "
              f"labels={labels}")

        user_data = ld_predictor.build_user_profile(
            baseline_windows, calibration_windows, labels
        )
        print("✓ User profile built and saved.")
        return jsonify({
            'success':         True,
            'n_cal_windows':   user_data['n_cal_windows'],
            'has_user_profile': True,
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("\n" + "="*60)
    print(f"🧠 EEG Emotion Prediction WebSocket Server ({MODEL_TYPE})")
    print("="*60)
    print(f"Model: {MODEL_TYPE}")
    print(f"Server starting on http://localhost:5000")
    print(f"Buffer size: {BUFFER_SIZE} samples ({BUFFER_SIZE/SAMPLE_RATE:.1f}s of EEG)")
    if MODEL_TYPE == 'RULE':
        print("PPG: accepted via 'ppg_sample' events (Muse 2, ~64 Hz)")
        print("Emotions: focus | stress | relaxed | tired")
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
