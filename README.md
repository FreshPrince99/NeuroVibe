# NeuroVibe

**NeuroVibe** is a real-time, emotion-aware music recommendation and cognitive training system. It reads live EEG signals from a **Muse 2** headset via Web Bluetooth, predicts the user's emotional state using machine learning models, and adapts Spotify playback accordingly. It also includes four EEG-driven cognitive training exercises and a full session analytics dashboard.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [System Architecture](#system-architecture)
3. [Key Features](#key-features)
4. [Prerequisites](#prerequisites)
5. [Installation](#installation)
6. [Spotify Setup](#spotify-setup)
7. [Running the Application](#running-the-application)
8. [User Flow](#user-flow)
9. [Cognitive Training Exercises](#cognitive-training-exercises)
10. [ML Models](#ml-models)
11. [Project Structure](#project-structure)
12. [Evaluation & User Testing](#evaluation--user-testing)
13. [Troubleshooting](#troubleshooting)

---

## What It Does

NeuroVibe has two core modes:

### Music Mode (Focus / Relaxation)
The headset streams raw EEG at 256 Hz from four scalp electrodes (TP9, AF7, AF8, TP10). Every 2.5 seconds the backend classifies the user's emotional state and a like/dislike preference signal. The Spotify player then adapts the energy and valence of the next track to steer the user toward their chosen goal — sustained focus or deep relaxation.

### Cognitive Training Mode
Four goal-oriented neurofeedback exercises use live EEG metrics to give the user real-time visual feedback on their brain state. Exercises are chosen based on what the user wants to achieve (Focus, Relax, Balance, Reset). Performance data is recorded and shown in a detailed post-session report.

### Break System
During music sessions, NeuroVibe suggests a cognitive exercise break after 15 minutes. The user can accept (music pauses, exercises load) or dismiss. Returning resumes Spotify from the exact pause point. Break windows are marked on the results timeline.

### Session Analytics
After every session a full report is shown: EEG signal progression graph, per-song effectiveness scores (music mode), cognitive performance charts with peak highlighting and zone bands (cognitive mode), break markers, and headline effectiveness score.

### User Profiles & Evaluation
Multiple users can each have a saved profile with their personalised EEG baseline. After every session users can fill in a System Usability Scale (SUS) questionnaire plus task-specific ratings. All session data and feedback are stored in a local SQLite database (`backend/neurovibe.db`) viewable with **DB Browser for SQLite**.

---

## System Architecture

```
Muse 2 EEG headset
    │  Web Bluetooth API  (256 Hz, channels: TP9 AF7 AF8 TP10 + PPG)
    ▼
Browser — Chrome / Edge  (localhost:3000)
    │  socket.io WebSocket
    ▼
Python Backend           (localhost:5000)
    ├── Rule-based emotion classifier  (focus / stress / relaxed / tired)
    ├── KAN neural network             (Angry / Happy / Relaxed / Sad)
    ├── CNN / LSTM alternatives
    ├── NeuroSense valence predictor   (POSITIVE / NEGATIVE / UNCERTAIN)
    └── Like/Dislike ensemble model    (Emognition dataset, 105 features)
    │
    ▼
SQLite database          (backend/neurovibe.db)
    └── users · baselines · sessions · feedback
```

---

## Key Features

| Feature | Detail |
|---|---|
| Real-time EEG | 256 Hz, 4 channels, 5-second sliding window (50% overlap) |
| Emotion classifiers | Rule-based, KAN, CNN, LSTM — switchable via CLI flag |
| Valence prediction | NeuroSense ensemble on 4-second windows, emits badge update every ~4 s |
| Like/dislike model | Stacked ensemble trained on Emognition; per-user z-score + isotonic recalibration |
| Spotify integration | OAuth 2.0; adaptive energy/valence targeting; genre rotation after block of dislikes |
| EEG calibration | 2.5-minute personal baseline; persisted per-user in SQLite |
| Cognitive training | 4 exercises: Neural Ball, Ocean Waves, Balance Bar, Pulse Pilot |
| Break system | 15-minute music session timer; pause/resume at exact playback position |
| Session reports | EEG graph, per-song scores, cognitive performance charts, break markers |
| Multi-user | Name-based login; per-user baselines loaded automatically |
| Evaluation | SUS questionnaire + 4 task-specific Likert scales; stored to DB |
| Data export | Open `backend/neurovibe.db` in DB Browser for SQLite |

---

## Prerequisites

### Hardware
- **Muse 2** EEG headset (other Muse models may work but PPG will be unavailable)
- Computer with Bluetooth 4.0+

### Software
- **Python 3.10+**
- **Node.js 18+**
- **Chrome or Edge** — required for the Web Bluetooth API (Firefox is not supported)
- **Spotify Premium** account for music playback

---

## Installation

### 1. Backend

```powershell
cd backend

# Create and activate virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt
```

### 2. Frontend

```powershell
cd frontend
npm install
```

---

## Spotify Setup

Create a `.env.local` file inside the `frontend/` directory:

```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
NEXTAUTH_URL=http://localhost:3000
```

To get credentials:
1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create an app
3. Add `http://localhost:3000/api/auth/callback/spotify` as a Redirect URI
4. Copy the Client ID and Client Secret into `.env.local`

---

## Running the Application

Both servers must run simultaneously in separate terminals.

### Terminal 1 — Backend

```powershell
cd backend
.\.venv\Scripts\Activate.ps1

# Default (rule-based classifier — recommended)
python websocket_server.py

# Alternative: KAN neural network
python websocket_server.py --model kan

# Alternative: CNN
python websocket_server.py --model cnn

# Alternative: LSTM
python websocket_server.py --model lstm
```

You should see:
```
🧠 EEG Emotion Prediction WebSocket Server (RULE)
Server starting on http://localhost:5000
Waiting for connections...
```

### Terminal 2 — Frontend

```powershell
cd frontend
npm run dev
```

Open **http://localhost:3000** in Chrome or Edge.

---

## User Flow

```
Landing page → User picker → Setup → EEG calibration → Session → Results → Feedback
```

1. **Landing page** — Click *Get Started*
2. **User picker** — Enter your name
   - If your name exists in the database and you have a saved baseline → baseline is loaded, calibration is skipped
   - If your name exists but no baseline → calibration step is shown
   - If your name is new → account is created, calibration step is shown
3. **Setup** — Connect to Spotify, choose session goal (Focus / Relax / Cognitive), select music genres
4. **EEG calibration** — 2.5 minutes of resting-state recording; baseline saved to your profile
5. **Session**
   - Music modes: Spotify plays and adapts in real-time based on emotion + like/dislike signals
   - Cognitive mode: choose a goal and start a neurofeedback exercise
   - Any music session offers a brain-break option after 15 minutes
6. **Stop session** — Session data is saved to `neurovibe.db` immediately
7. **Results page** — Full analytics report; your username shown in the header
8. **Feedback (optional)** — 10-question SUS + 4 task-specific questions; Submit or Skip
9. **Logout** — Button in the header on the session and results pages

---

## Cognitive Training Exercises

| Goal | Exercise | Primary EEG signal |
|---|---|---|
| Focus | **Neural Ball** | Frontal theta/alpha ratio (engagement) |
| Relax | **Ocean Waves** | Backend relaxed score via EMA smoothing |
| Balance | **Balance Bar** | AF7/AF8 frontal asymmetry (FAA biofeedback) |
| Reset | **Pulse Pilot** | PPG heart rate + signal quality indicator |

All exercises show a live instruction panel and a 60-second performance graph with zone bands (Excellent / Good / Developing) and peak highlight after the session.

---

## ML Models

### Emotion Classification
| Model | File | Labels | Notes |
|---|---|---|---|
| Rule-based (default) | `emotion.py` | focus / stress / relaxed / tired | Band-power ratios + FAA; personalised with baseline |
| KAN | `models/mood_model.pth` | Angry / Happy / Relaxed / Sad | 38-feature frequency domain |
| CNN | `models/eeg_emotion_prediction_model.keras` | Same as KAN | Keras sequential |
| LSTM | `models/lstm_model.h5` | Same as KAN | Temporal sequence model |

### Valence / Preference
| Model | File | Notes |
|---|---|---|
| NeuroSense | `neurosense_models/` | Ensemble; emits POSITIVE/NEGATIVE/UNCERTAIN every ~4 s |
| Like/Dislike | `emognition_models/generic_model.pkl` | 105 frequency features; per-user z-score + isotonic recalibration |

### EEG Processing Pipeline
1. Butterworth bandpass filter (1–40 Hz)
2. Artifact rejection — peak-to-peak amplitude threshold
3. FFT → power in 5 bands (δ, θ, α, β, γ) × 4 channels = 20 features
4. Inter-channel coherence = 18 features
5. Total: 38 features fed to KAN/CNN/LSTM; rule-based uses band ratios directly

---

## Project Structure

```
NeuroVibe/
├── backend/
│   ├── websocket_server.py     Main Flask + SocketIO server; all REST endpoints
│   ├── db.py                   SQLite module (users, baselines, sessions, feedback)
│   ├── emotion.py              Rule-based emotion classifier
│   ├── KAN_prediction.py       KAN model inference + feature extraction
│   ├── CNN_prediction.py       CNN model inference
│   ├── LSTM_prediction.py      LSTM model inference
│   ├── likedislike.py          Like/dislike stacked ensemble
│   ├── neurosense.py           NeuroSense valence predictor
│   ├── models/                 KAN / CNN / LSTM weights + scalers
│   ├── emognition_models/      Like/dislike model files
│   ├── neurosense_models/      NeuroSense model files
│   ├── neurovibe.db            SQLite database (auto-created on first run)
│   ├── baseline.pkl            Active user's EEG baseline (overwritten on login)
│   └── requirements.txt
│
└── frontend/
    └── src/
        ├── app/
        │   ├── page.tsx            Landing page + user picker modal
        │   ├── setup/page.tsx      Setup wizard (Spotify, mode, genres, calibration)
        │   ├── emotion/page.tsx    Live session page (EEG, music, cognitive)
        │   ├── results/page.tsx    Post-session analytics report
        │   └── api/                Spotify OAuth server-side routes
        ├── components/
        │   ├── MuseConnector.tsx   Web Bluetooth connection to Muse 2
        │   ├── player.tsx          Spotify player with adaptive recommendations
        │   ├── CognitiveTrainingView.tsx  Four EEG neurofeedback exercises
        │   ├── EmotionView.tsx     Real-time emotion circle visualisation
        │   ├── CalibrationStep.tsx EEG baseline recording
        │   ├── EEGVisualization.tsx Real-time EEG waveform display
        │   └── FeedbackForm.tsx    SUS + task-specific evaluation form
        └── lib/
            └── sessionStore.ts     In-memory session state (resets on page reload)
```

---

## Evaluation & User Testing

NeuroVibe collects structured evaluation data designed to be defensible in a software engineering report or viva.

### What is collected per user per session

| Data | Where stored |
|---|---|
| Full session JSON (songs, EEG snapshots, breaks, scores) | `sessions` table |
| SUS score (0–100, industry-standard usability metric) | `feedback` table |
| 4 task-specific Likert ratings (emotion accuracy, music match, EEG responsiveness, goal achieved) | `feedback` table |
| Optional open-text response | `feedback` table |

### Accessing the data

1. Install **[DB Browser for SQLite](https://sqlitebrowser.org/)** (free)
2. Open `backend/neurovibe.db`
3. Browse the `users`, `sessions`, and `feedback` tables
4. Export any table to CSV via *File → Export → Table(s) as CSV*

### SUS scoring

The SUS questionnaire produces a 0–100 score. Scores ≥ 68 are considered above average usability. The score is shown to the user immediately after submitting and stored in the database.

---

## Troubleshooting

### Muse headset won't connect
- Use **Chrome or Edge** — Firefox does not support Web Bluetooth
- Ensure Bluetooth is enabled on your computer
- The headset must be turned on and in range; do not pair it with another device first
- If connection drops, the app will auto-reconnect every 3 seconds

### Backend not connecting
- Confirm the backend server is running on port 5000
- Check the terminal for Python errors
- Ensure `requirements.txt` packages are installed in the active virtual environment

### No emotion predictions
- The first prediction arrives after ~5 seconds (one full buffer)
- Check backend terminal for `🔄 Buffer full` messages
- Ensure the headset electrodes have good contact (moisten sensor tips slightly)

### Spotify not playing
- Confirm Spotify Premium is active
- Complete the OAuth flow in the Setup page
- Spotify must be open and active on at least one device before the player can take control

### Nothing saving to the database
- Make sure you went through the user picker on the landing page — this creates your profile
- The session is saved when you click **Stop Session**, not when you navigate to results
- If the backend was not running at that moment, the save will silently fail; restart the backend and run another session

### Poor EEG signal quality
- Moisten the four sensor contacts slightly with water
- Minimise movement and jaw clenching during sessions
- Ensure the headset is seated firmly with the sensors touching your scalp
- The EEG visualisation on the session page shows raw signal — a flat line means no contact
