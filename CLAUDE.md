# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NeuroVibe is an emotion-aware music recommendation system that reads real-time EEG signals from a **Muse 2 headset** (via Web Bluetooth), predicts the user's emotional state using ML models, and adapts Spotify music recommendations accordingly. It also includes EEG-driven cognitive training games.

## Development Commands

### Frontend (Next.js)
```bash
cd frontend
npm run dev       # Start dev server on http://localhost:3000
npm run build     # Production build
npm run lint      # ESLint
```

### Backend (Python Flask + SocketIO)
```bash
cd backend
# Windows:
.\.venv\Scripts\Activate.ps1
# macOS/Linux:
source .venv/bin/activate

python websocket_server.py                  # Default (rule-based emotion)
python websocket_server.py --model kan      # KAN neural network
python websocket_server.py --model cnn      # CNN model
python websocket_server.py --model lstm     # LSTM model
python websocket_server.py --model rule     # Rule-based classifier
```

Both must run simultaneously. The frontend requires **Chrome or Edge** for Web Bluetooth API support.

## Architecture

```
Muse 2 EEG headset
    │ Web Bluetooth API (256 Hz, 4 channels: TP9, AF7, AF8, TP10)
    ▼
Frontend (Next.js/React/TypeScript) — localhost:3000
    │ WebSocket (socket.io) — ws://localhost:5000
    ▼
Backend (Flask + Flask-SocketIO) — localhost:5000
    │ Buffers 1280 samples (5s windows, 50% overlap)
    ├── Emotion prediction → emits `emotion_prediction` event back to frontend
    └── Like/dislike prediction → emits `like_dislike_prediction` event
```

### Frontend Structure (`frontend/src/`)

- **`app/`** — Next.js App Router pages: `page.tsx` (landing), `setup/`, `emotion/`, `results/`
- **`app/api/`** — Server-side API routes for Spotify OAuth and audio features
- **`components/`** — React components:
  - `MuseConnector.tsx` — Web Bluetooth Muse connection, emits `eeg_sample` events
  - `player.tsx` — Spotify player; adapts track selection by emotion + like/dislike feedback
  - `CognitiveTrainingView.tsx` — 4 EEG-driven games (Neural Ball, Neuro Drive, Signal Shield, Pulse Pilot)
  - `EmotionView.tsx` — Emotion circle visualization
  - `CalibrationStep.tsx` — Per-user baseline recording
  - `EEGVisualization.tsx` — Real-time EEG signal display
- **`lib/sessionStore.ts`** — In-memory session store (songs played, EEG snapshots, cognitive scores); resets on page reload

### Backend Structure (`backend/`)

- **`websocket_server.py`** — Main server; receives `eeg_sample` events, manages buffers, routes to models, emits predictions
- **`KAN_prediction.py`** — Feature extraction (Butterworth filter → FFT → 5 EEG bands × 4 channels = 20 power features + 18 coherence features = 38 total) and KAN inference
- **`emotion.py`** — Rule-based classifier using band-power ratios (theta/alpha, beta/alpha, FAA); no ML required
- **`likedislike.py`** — Stacked ensemble (Emognition dataset); 105 frequency-domain features; per-user z-score normalization + isotonic recalibration
- **`CNN_prediction.py`** / **`LSTM_prediction.py`** — Alternative Keras models

### Model Artifacts

- `backend/models/` — KAN model (`mood_model.pth`), `scaler.pkl`, `label_encoder.pkl`
- `backend/emognition_models/` — Like/dislike ensemble (`generic_model.pkl`), `global_baseline.npy`, `user.pkl` (per-user profile written after calibration)

### Emotion Labels

KAN/CNN/LSTM predict 4 classes: **Angry, Happy, Relaxed, Sad**
Rule-based predicts: **focus, stress, relaxed, tired**

### Key Data Flow Details

- EEG buffer: 1280 samples = 5 seconds at 256 Hz
- Prediction cadence: every 2.5 seconds (50% overlap sliding window)
- Artifact rejection: peak-to-peak amplitude threshold applied before feature extraction
- Spotify track selection uses emotion → energy/valence thresholds; like/dislike feedback further refines recommendations
- Per-user calibration profile is pickled to `backend/emognition_models/user.pkl`

## Spotify Setup

Spotify integration requires a `.env.local` in `frontend/` with:
```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
NEXTAUTH_URL=http://localhost:3000
```

## Key Documentation

- `SETUP_INSTRUCTIONS.md` — Installation & Bluetooth (BlueMuse) setup
- `TEST_GUIDE.md` — Testing checklist & debugging
- `LIKEDISLIKE_AUDIT.md` — Like/dislike model validation details
