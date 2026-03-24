"""
WebSocket server for real-time EEG emotion prediction.
Receives EEG samples from frontend and returns emotion predictions.
"""

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import db as _db
from CNN_prediction import CNNEmotionPredictor
from LSTM_prediction import LSTMEmotionPredictor
from KAN_prediction import EmotionPredictor as KANEmotionPredictor
from emotion import RuleBasedEmotionPredictor
from neurosense import NeuroSensePredictor
import numpy as np
import os
import sys
import pickle
import argparse
import threading
import time
from collections import Counter
from typing import Optional

# Path where the baseline for the rule-based emotion predictor is persisted
BASELINE_PKL = os.path.join(os.path.dirname(__file__), "baseline.pkl")

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
_db.init_db()
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
        # Load baseline from baseline.pkl if it exists so the emotion
        # classifier starts with personalised thresholds immediately.
        _rule_baseline = None
        if os.path.exists(BASELINE_PKL):
            try:
                with open(BASELINE_PKL, "rb") as _fh:
                    _bdata = pickle.load(_fh)
                if isinstance(_bdata, dict) and "baseline_for_emotion" in _bdata:
                    _b = np.asarray(_bdata["baseline_for_emotion"])  # (4, N)
                    _rule_baseline = {
                        "tp9":  _b[0], "af7": _b[1],
                        "af8":  _b[2], "tp10": _b[3],
                    }
                    print(f"[OK] Loaded baseline_for_emotion from baseline.pkl "
                          f"(shape={_b.shape}) for personalised emotion thresholds")
                else:
                    print("[INFO] baseline.pkl exists but has no baseline_for_emotion "
                          "-- emotion classifier will use generic thresholds")
            except Exception as _e:
                print(f"[WARN] Could not load baseline.pkl for emotion baseline: {_e}")
        else:
            print("[INFO] No baseline.pkl found -- emotion classifier using generic thresholds")
        predictor = RuleBasedEmotionPredictor(baseline_channels=_rule_baseline)
    print(f"✓ {MODEL_TYPE} Predictor ready!")
except Exception as e:
    print(f"❌ Failed to initialize predictor: {e}")
    sys.exit(1)

# Global baseline channels (populated during calibration) for personalising rule-based emotion predictor
baseline_channels_global: Optional[dict] = None

# Initialize NeuroSense valence predictor (non-fatal if models are missing)
print("Initializing NeuroSense Valence Predictor...")
try:
    ns_predictor = NeuroSensePredictor()
    print("✓ NeuroSense Predictor ready!")
except Exception as e:
    print(f"⚠️  NeuroSense predictor unavailable: {e}")
    ns_predictor = None

# Global buffers for EEG and PPG samples
eeg_buffer = []
ppg_buffer: list = []   # raw PPG float values (~64 Hz, Muse 2)
ns_buffer:  list = []   # separate 4-s window buffer for valence (1024 samples @ 256 Hz)
BUFFER_SIZE    = predictor.required_samples
NS_BUFFER_SIZE = 1024   # 4 s @ 256 Hz — matches NeuroSense window
SAMPLE_RATE    = 256
is_processing    = False  # Flag to prevent multiple simultaneous predictions
ns_is_processing = False
ns_last_emit_time: float = 0.0  # epoch time of last valence_prediction emit
NS_EMIT_INTERVAL  = 4.0         # seconds between badge updates (~every 4 s)

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
    global eeg_buffer, ppg_buffer, ns_buffer
    eeg_buffer = []
    ppg_buffer = []
    ns_buffer  = []
    if args.model == 'rule':
        predictor.reset()  # clear prediction history
    if ns_predictor:
        ns_predictor.reset()  # clear valence smoothing buffer

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

        # Add sample to both EEG and NeuroSense valence buffers
        eeg_buffer.append(cleaned_data)
        ns_buffer.append(cleaned_data)

        # ── NeuroSense valence prediction (every 4-s window, non-blocking) ──
        if ns_predictor and len(ns_buffer) >= NS_BUFFER_SIZE and not ns_is_processing:
            _run_ns_prediction(list(ns_buffer[:NS_BUFFER_SIZE]))
            # Slide window by half (50% overlap) for more frequent predictions
            del ns_buffer[:NS_BUFFER_SIZE // 2]

        # Log progress every 256 samples (1 second)
        if len(eeg_buffer) % 256 == 0:
            # print(f"📊 Received {len(eeg_buffer)}/{BUFFER_SIZE} samples ({len(eeg_buffer)/SAMPLE_RATE:.1f}s)")
            print()
        
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
                # Use the most recent ~10 s of PPG for stable HR/HRV
                if ppg_buffer:
                    ppg_snapshot = np.array(ppg_buffer[-640:], dtype=np.float64)  # 64 Hz * 10 s
                else:
                    ppg_snapshot = None

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
                    raw_dominant = scores.dominant
                    try:
                        hist = predictor.get_history()
                    except Exception:
                        hist = []
                    for em, sc_val in sorted(sd.items(), key=lambda x: -x[1]):
                        bar_len = max(1, int(sc_val * 20))
                        print(f"   {em:<8} {'█' * bar_len:<20} {sc_val:.3f}")
                    if hist:
                        print(f"   raw: {raw_dominant.upper()}   smooth: {emotion.upper()}   history: {hist}")
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

def _run_ns_prediction(window_samples: list) -> None:
    """Run NeuroSense valence prediction in a background thread (fire-and-forget)."""
    global ns_is_processing
    if ns_is_processing or ns_predictor is None:
        return
    ns_is_processing = True

    def _predict():
        global ns_is_processing, ns_last_emit_time
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
            result   = ns_predictor.predict(win)
            valence  = result["valence"]
            smoothed = result["smoothed_score"]
            raw      = result["raw_score"]
            n_win    = result["n_windows"]

            icon = "🟢 POS" if valence == "POSITIVE" else ("🔴 NEG" if valence == "NEGATIVE" else "⚪ UNC")
            bar  = "█" * max(1, int((1 - abs(smoothed - 0.5) * 2) * 10))
            print(f"  {icon}  raw={raw:.3f}  smooth={smoothed:.3f}  n={n_win}  {bar}")

            # Emit to frontend (throttled by NS_EMIT_INTERVAL)
            now = time.time()
            if now - ns_last_emit_time >= NS_EMIT_INTERVAL:
                socketio.emit("valence_prediction", result)
                ns_last_emit_time = now
        except Exception as ex:
            print(f"⚠️  NeuroSense prediction error: {ex}")
            import traceback; traceback.print_exc()
        finally:
            ns_is_processing = False

    threading.Thread(target=_predict, daemon=True).start()


@socketio.on('reset_buffer')
def handle_reset_buffer():
    """Reset the EEG, PPG and NeuroSense buffers."""
    global eeg_buffer, ppg_buffer, ns_buffer
    eeg_buffer = []
    ppg_buffer = []
    ns_buffer  = []
    if args.model == 'rule':
        predictor.reset()
    if ns_predictor:
        ns_predictor.reset()
    print('Buffer reset')
    emit('status', {'message': 'Buffer reset'})

@app.route('/health')
def health_check():
    """Simple health check endpoint."""
    return jsonify({
        'status':            'ok',
        'model':             MODEL_TYPE,
        'predictor_loaded':  predictor is not None,
        'ns_predictor':      ns_predictor is not None,
        'has_baseline':      os.path.exists(BASELINE_PKL),
        'eeg_buffer_size':   len(eeg_buffer),
        'ppg_buffer_size':   len(ppg_buffer),
        'buffer_needed':     BUFFER_SIZE,
    })


@app.route('/user/exists', methods=['GET'])
def user_exists():
    """Check whether a baseline profile exists.
    If ?user_id=N is given, checks the DB for that user; otherwise checks baseline.pkl."""
    user_id = request.args.get('user_id', type=int)
    if user_id is not None:
        exists = _db.has_baseline(user_id)
    else:
        exists = os.path.exists(BASELINE_PKL)
    return jsonify({'exists': exists})


@app.route('/user/delete', methods=['DELETE'])
def user_delete():
    """Delete the baseline profile so the calibration flow re-runs."""
    if os.path.exists(BASELINE_PKL):
        os.remove(BASELINE_PKL)
    return jsonify({'deleted': True})


@app.route('/calibration/build', methods=['POST'])
def calibration_build():
    """
    Receive baseline EEG data from the frontend setup flow and persist it
    for the rule-based emotion predictor.

    Expected JSON body:
    {
        "baseline_samples": [ [{tp9,af7,af8,tp10}, ...], ... ]  // list of windows
    }
    Each window is a flat list of dicts with keys tp9/af7/af8/tp10.
    Window size must be 1024 samples (4 s @ 256 Hz).
    """
    try:
        body = request.get_json(force=True)
        if not body:
            return jsonify({'error': 'Empty request body'}), 400

        def _to_array(window_list):
            """Convert a list of sample dicts to (4, N) np.ndarray. None/NaN/Inf → 0.0"""
            def _f(v):
                if v is None:
                    return 0.0
                try:
                    fv = float(v)
                    return fv if np.isfinite(fv) else 0.0
                except (TypeError, ValueError):
                    return 0.0
            return np.array([
                [_f(s.get('tp9'))  for s in window_list],
                [_f(s.get('af7'))  for s in window_list],
                [_f(s.get('af8'))  for s in window_list],
                [_f(s.get('tp10')) for s in window_list],
            ], dtype=np.float32)

        baseline_windows = [_to_array(w) for w in body.get('baseline_samples', [])]

        if len(baseline_windows) == 0:
            return jsonify({'error': 'No baseline windows provided'}), 400

        print(f"🧠 Processing baseline: {len(baseline_windows)} windows")

        # Personalise rule-based emotion predictor with baseline data
        global predictor, baseline_channels_global
        if isinstance(predictor, RuleBasedEmotionPredictor) and len(baseline_windows) > 0:
            try:
                # Concatenate all baseline windows: each is (4, 1024) → (4, N)
                baseline_eeg_concat = np.concatenate(baseline_windows, axis=1)
                baseline_channels = {
                    'tp9':  baseline_eeg_concat[0],
                    'af7':  baseline_eeg_concat[1],
                    'af8':  baseline_eeg_concat[2],
                    'tp10': baseline_eeg_concat[3],
                }
                baseline_channels_global = baseline_channels
                predictor = RuleBasedEmotionPredictor(baseline_channels=baseline_channels)
                print(f"[OK] Rule-based emotion predictor personalised with "
                      f"{len(baseline_windows)} baseline windows")
            except Exception as e:
                print(f"⚠️  Failed to personalise emotion predictor with baseline: {e}")

        # Persist baseline so the emotion predictor is personalised on server restart
        try:
            baseline_payload = {
                "baseline_for_emotion": np.concatenate(baseline_windows, axis=1),
                "n_baseline_windows":   len(baseline_windows),
            }
            with open(BASELINE_PKL, "wb") as fh:
                pickle.dump(baseline_payload, fh)
            print(f"[OK] Baseline saved to {BASELINE_PKL}")

            # Also store in DB keyed by user_id (if provided)
            user_id = body.get('user_id')
            if user_id is not None:
                try:
                    import io
                    buf = io.BytesIO()
                    pickle.dump(baseline_payload, buf)
                    _db.save_baseline(int(user_id), buf.getvalue())
                    print(f"[OK] Baseline saved to DB for user_id={user_id}")
                except Exception as _e:
                    print(f"⚠️  Could not save baseline to DB: {_e}")
        except Exception as e:
            print(f"⚠️  Could not save baseline.pkl: {e}")

        return jsonify({
            'success':            True,
            'n_baseline_windows': len(baseline_windows),
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/song_switch', methods=['POST'])
def song_switch_report():
    """
    Receive per-song-switch metrics from the frontend player and print a
    formatted summary to the terminal.
    """
    try:
        d = request.get_json(force=True) or {}

        song_num     = d.get('song_number', '?')
        mode         = d.get('mode', 'focus')
        dom_emotion  = str(d.get('dominant_emotion', 'unknown')).upper()
        breakdown    = d.get('emotion_breakdown', {})
        total        = d.get('emotion_total', 0)
        prev_e       = d.get('prev_energy')
        new_e        = d.get('new_energy')
        reason       = d.get('energy_change_reason', 'drift toward baseline')
        val_label    = d.get('valence_label', 'N/A')
        val_score    = d.get('valence_score')
        val_windows  = d.get('valence_windows', 0)
        block_scores = d.get('block_scores', [])
        block_size   = d.get('block_size', 5)
        block_done   = d.get('block_complete', False)
        block_avg    = d.get('block_avg_score')
        genre_rot    = d.get('genre_rotated', False)
        prev_genre   = d.get('prev_genre', '?')
        cur_genre    = d.get('current_genre', '?')

        def energy_label(e):
            if e is None:
                return '—'
            if e >= 0.66:
                return 'upbeat energetic fast'
            if e >= 0.51:
                return 'moderate steady focused'
            if e >= 0.31:
                return 'calm relaxing slow'
            return 'ambient meditative very slow'

        def energy_arrow(p, n):
            if p is None or n is None:
                return ''
            diff = n - p
            if diff > 0.005:
                return f'↑ +{diff:.3f}'
            if diff < -0.005:
                return f'↓ {diff:.3f}'
            return f'→ {diff:+.3f}'

        sep = '=' * 62

        lines = [
            '',
            sep,
            f'🎵  SONG SWITCH  (song #{song_num} complete | mode: {mode})',
            '-' * 62,
        ]

        # Emotion breakdown
        if total > 0 and breakdown:
            lines.append('Emotion during track:')
            for emotion, count in sorted(breakdown.items(), key=lambda x: -x[1]):
                pct  = count / total * 100
                bar  = '█' * max(1, int(pct / 5))
                flag = '  ◀ dominant' if emotion.lower() == dom_emotion.lower() else ''
                lines.append(f'   {emotion:<12} {bar:<20} {pct:5.1f}%{flag}')
        else:
            lines.append(f'Emotion during track:  {dom_emotion}  (no breakdown available)')

        # Energy
        lines.append('')
        lines.append('Adaptive Energy:')
        if prev_e is not None and new_e is not None:
            arrow = energy_arrow(prev_e, new_e)
            lines.append(f'   {prev_e:.3f}  →  {new_e:.3f}  ({arrow})  [{reason}]')
        lines.append(f'   Target for next song: {new_e:.3f}  →  "{energy_label(new_e)}"')

        # NeuroSense valence
        lines.append('')
        val_icon = '🟢' if val_label == 'POSITIVE' else ('🔴' if val_label == 'NEGATIVE' else '⚪')
        score_str = f'  smoothed={val_score:.3f}' if val_score is not None else ''
        lines.append(f'NeuroSense Valence:  {val_icon} {val_label}{score_str}  (n={val_windows} windows)')

        # Genre block
        lines.append('')
        scored   = len(block_scores)
        scores_s = '  '.join(
            ('✅' if s == 0.0 else '❌') for s in block_scores
        ) if block_scores else '—'

        if block_done:
            avg_pct = (block_avg or 0) * 100
            lines.append(f'Genre block:  {scored}/{block_size} songs scored  |  avg dislike {avg_pct:.0f}%')
            lines.append(f'   Scores:  {scores_s}')
            if genre_rot:
                lines.append(f'   ⚠  GENRE ROTATION:  "{prev_genre}"  →  "{cur_genre}"')
            else:
                lines.append(f'   ✓  Keeping genre:  "{cur_genre}"  (positive affect)')
        else:
            lines.append(f'Genre block:  {scored}/{block_size} songs scored so far  (no rotation yet)')
            lines.append(f'   Scores:  {scores_s}')
            lines.append(f'   Current genre:  "{cur_genre}"')

        lines.append(sep)
        lines.append('')

        print('\n'.join(lines))
        return jsonify({'ok': True})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── User management ──────────────────────────────────────────────────────────

@app.route('/users', methods=['GET'])
def list_users():
    """Return all registered user profiles."""
    return jsonify({'users': _db.get_users()})


@app.route('/users/find', methods=['GET'])
def find_user():
    """Look up a user by username (case-insensitive). Returns {user} or {user: null}."""
    username = request.args.get('username', '').strip()
    if not username:
        return jsonify({'user': None})
    users = _db.get_users()
    match = next((u for u in users if u['username'].lower() == username.lower()), None)
    if match:
        match['has_baseline'] = _db.has_baseline(match['id'])
    return jsonify({'user': match})


@app.route('/users', methods=['POST'])
def create_user():
    """Create a new user. Body: { "username": "Alice" }"""
    body = request.get_json(force=True) or {}
    username = str(body.get('username', '')).strip()
    if not username:
        return jsonify({'error': 'username is required'}), 400
    user = _db.create_user(username)
    if user is None:
        return jsonify({'error': 'Username already taken'}), 409
    return jsonify(user), 201


@app.route('/users/<int:user_id>/load-baseline', methods=['POST'])
def load_user_baseline(user_id):
    """Load the stored baseline for a user and make it the active baseline.pkl."""
    blob = _db.load_baseline(user_id)
    if blob is None:
        return jsonify({'loaded': False, 'message': 'No baseline stored for this user'})
    try:
        with open(BASELINE_PKL, 'wb') as fh:
            fh.write(blob)
        # Reload the active predictor with the newly written baseline
        with open(BASELINE_PKL, 'rb') as fh:
            bdata = pickle.load(fh)
        if isinstance(bdata, dict) and 'baseline_for_emotion' in bdata:
            b = np.asarray(bdata['baseline_for_emotion'])
            bc = {'tp9': b[0], 'af7': b[1], 'af8': b[2], 'tp10': b[3]}
            global predictor
            if isinstance(predictor, RuleBasedEmotionPredictor):
                predictor = RuleBasedEmotionPredictor(baseline_channels=bc)
        print(f"[OK] Active baseline switched to user_id={user_id}")
        return jsonify({'loaded': True})
    except Exception as e:
        return jsonify({'loaded': False, 'message': str(e)})


# ── Session & feedback storage ───────────────────────────────────────────────

@app.route('/sessions', methods=['POST'])
def save_session_route():
    """Save a completed session. Body: { user_id, mode, started_at, ended_at, duration_seconds, data }"""
    try:
        body = request.get_json(force=True) or {}
        import json as _json
        sid = _db.save_session(
            user_id=body.get('user_id'),
            mode=body.get('mode', 'focus'),
            started_at=body.get('started_at', ''),
            ended_at=body.get('ended_at', ''),
            duration_seconds=int(body.get('duration_seconds', 0)),
            data_json=_json.dumps(body.get('data', {})),
        )
        return jsonify({'session_id': sid}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/feedback', methods=['POST'])
def save_feedback_route():
    """Save evaluation feedback. Body: { user_id, session_id, sus_score, responses }"""
    try:
        body = request.get_json(force=True) or {}
        import json as _json
        fid = _db.save_feedback(
            user_id=body.get('user_id'),
            session_id=body.get('session_id'),
            sus_score=float(body.get('sus_score', 0)),
            responses_json=_json.dumps(body.get('responses', {})),
        )
        return jsonify({'feedback_id': fid}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("\n" + "="*60)
    print(f"🧠 EEG Emotion Prediction WebSocket Server ({MODEL_TYPE})")
    print("="*60)
    print(f"Model: {MODEL_TYPE}")
    print(f"Server starting on http://localhost:5000")
    print(f"Buffer size: {BUFFER_SIZE} samples ({BUFFER_SIZE/SAMPLE_RATE:.1f}s of EEG)")
    print(f"NeuroSense: {'loaded' if ns_predictor else 'UNAVAILABLE'}")
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
