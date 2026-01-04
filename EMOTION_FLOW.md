# Emotion Prediction Flow - NeuroVibe

## Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MUSE EEG HEADSET                             │
│  Streams 4 channels: TP9, AF7, AF8, TP10 @ 256 Hz via Bluetooth    │
└────────────────────────┬────────────────────────────────────────────┘
                         │ Web Bluetooth API
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Next.js/React)                         │
│  Component: MuseConnector.tsx                                       │
│                                                                      │
│  1. MuseClient connects to headset                                  │
│  2. Receives EEG samples (zipSamples)                               │
│  3. Formats: { tp9, af7, af8, tp10, timestamp }                     │
│  4. Emits via Socket.IO: 'eeg_sample' event                         │
└────────────────────────┬────────────────────────────────────────────┘
                         │ WebSocket (socket.io-client)
                         │ ws://localhost:5000
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    BACKEND (Flask + SocketIO)                       │
│  File: websocket_server.py                                          │
│                                                                      │
│  1. Receives 'eeg_sample' event                                     │
│  2. Buffers samples until 1280 collected (5 seconds)                │
│  3. Converts to channel arrays:                                     │
│     - channels_data[0] = all TP9 samples                            │
│     - channels_data[1] = all AF7 samples                            │
│     - channels_data[2] = all AF8 samples                            │
│     - channels_data[3] = all TP10 samples                           │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│              FEATURE EXTRACTION (KAN_prediction.py)                 │
│  Function: compute_all_advanced_features()                          │
│                                                                      │
│  1. Apply low-pass Butterworth filter (30 Hz cutoff)                │
│  2. FFT on each channel                                             │
│  3. Extract 20 power features (4 channels × 5 bands):               │
│     - Delta (0.5-4 Hz)                                              │
│     - Theta (4-7.5 Hz)                                              │
│     - Alpha (7.5-12.5 Hz)                                           │
│     - Beta (12.5-30 Hz)                                             │
│     - Gamma (30-120 Hz)                                             │
│  4. Extract 18 coherence features (6 channel pairs × 3 bands)       │
│  5. Output: 38-feature vector                                       │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   PREPROCESSING (StandardScaler)                    │
│  File: models/scaler.pkl                                            │
│                                                                      │
│  Normalizes features using training statistics                      │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│              KAN MODEL PREDICTION (PyKAN)                           │
│  File: models/mood_model.pth                                        │
│  Architecture: [38, 16, 8, 4]                                       │
│                                                                      │
│  1. Input layer: 38 features                                        │
│  2. Hidden layers: 16 → 8 nodes                                     │
│  3. Output layer: 4 emotion classes                                 │
│  4. Predicts one of: Angry, Happy, Relaxed, Sad                     │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                LABEL DECODING (LabelEncoder)                        │
│  File: models/label_encoder.pkl                                     │
│                                                                      │
│  Converts numeric prediction to emotion string                      │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│              BACKEND RESPONSE (WebSocket Emit)                      │
│  Emits: 'emotion_prediction' event                                  │
│  Payload: { emotion, timestamp, samples_processed }                 │
└────────────────────────┬────────────────────────────────────────────┘
                         │ WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│              FRONTEND RECEIVES PREDICTION                           │
│  Component: MuseConnector.tsx                                       │
│                                                                      │
│  1. Receives 'emotion_prediction' event                             │
│  2. Updates local state: setEmotion(data.emotion)                   │
│  3. Calls parent callback: onEmotionPredicted(emotion)              │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   MAIN PAGE (page.tsx)                              │
│                                                                      │
│  1. handleEmotionPrediction(emotion) called                         │
│  2. Updates: setPredictedEmotion(emotion)                           │
│  3. Enables: setUseMusePrediction(true)                             │
│  4. UI updates:                                                     │
│     - Emotion circle changes color                                  │
│     - Displays emotion name                                         │
│     - Shows "🧠 Live from Muse" badge                               │
│     - Spotify Player updates with new emotion                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Timing

- **Sample Rate**: 256 Hz (256 samples per second)
- **Buffer Size**: 1280 samples (5 seconds of data)
- **Prediction Frequency**: Every 2.5 seconds (with 50% overlap)
- **Total Latency**: ~5-6 seconds from data collection to UI update

## Emotion Classes

The model predicts one of these 4 emotions:

1. **Happy** 😊 - Yellow circle
2. **Sad** 😢 - Blue circle
3. **Angry** 😠 - Red circle
4. **Relaxed** 😌 - Green circle

## User Controls

- **Auto Mode**: Use Muse predictions (checkbox enabled)
- **Manual Mode**: Select emotion from dropdown (disables Muse)
- **Toggle**: User can switch between auto/manual at any time

## Files Involved

### Frontend
- `frontend/src/app/page.tsx` - Main page with emotion display
- `frontend/src/components/MuseConnector.tsx` - Muse connection component
- `frontend/src/components/player.tsx` - Spotify player component

### Backend
- `backend/websocket_server.py` - WebSocket server
- `backend/KAN_prediction.py` - Feature extraction & prediction
- `backend/models/mood_model.pth` - Trained KAN model
- `backend/models/scaler.pkl` - Feature scaler
- `backend/models/label_encoder.pkl` - Label encoder

## Testing the Flow

1. **Start Backend**: `python websocket_server.py`
2. **Start Frontend**: `npm run dev`
3. **Open Browser**: Navigate to `http://localhost:3000`
4. **Connect Muse**: Click "Connect Muse" button
5. **Wait**: First prediction arrives after ~5 seconds
6. **Watch**: Emotion circle updates automatically
7. **Music Updates**: Spotify player gets new recommendations
