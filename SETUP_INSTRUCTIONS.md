# NeuroVibe Setup & Usage Instructions

## Overview
NeuroVibe connects your Muse EEG headset directly from the browser to predict emotions in real-time using a trained KAN (Kolmogorov-Arnold Network) model.

## Architecture
```
Muse Headset (Bluetooth) 
    ↓ Web Bluetooth API
Browser (muse-js)
    ↓ WebSocket (socket.io)
Backend (Flask + SocketIO)
    ↓ KAN Model
Emotion Prediction
```

## Prerequisites

### Hardware
- Muse S, Muse 2, or compatible Muse EEG headset
- Computer with Bluetooth support

### Software
- Node.js (v18+)
- Python 3.8+
- Chrome/Edge browser (required for Web Bluetooth API)

## Installation

### 1. Backend Setup

```powershell
# Navigate to backend directory
cd backend

# Activate virtual environment
.\.venv\Scripts\Activate.ps1

# Install dependencies (already done if you see this)
pip install -r requirements.txt
```

### 2. Frontend Setup

```powershell
# Navigate to frontend directory
cd frontend

# Install dependencies (already done if you see this)
npm install
```

## Running the Application

### Step 1: Start the Backend Server

```powershell
# In backend directory with venv activated
cd backend
.\.venv\Scripts\Activate.ps1
python websocket_server.py
```

You should see:
```
🧠 EEG Emotion Prediction WebSocket Server
Server starting on http://localhost:5000
Waiting for connections...
```

### Step 2: Start the Frontend

```powershell
# In a new terminal, navigate to frontend
cd frontend
npm run dev
```

Frontend will be available at: `http://localhost:3000`

### Step 3: Connect Muse Headset

1. **Turn on your Muse headset** (it will enter pairing mode)
2. **Open the app** in Chrome/Edge: `http://localhost:3000`
3. **Navigate to MuseConnector** component
4. **Click "Connect Muse"** button
5. **Select your Muse device** from the Bluetooth pairing dialog
6. **Wait for connection** - Status will update to "Connected to Muse"
7. **Backend will start receiving data** and making predictions every ~5 seconds

## How It Works

1. **Data Collection**: Muse headset streams EEG data from 4 channels (TP9, AF7, AF8, TP10) at 256 Hz
2. **Transmission**: Browser sends samples via WebSocket to backend server
3. **Buffering**: Backend collects 1280 samples (5 seconds of data)
4. **Feature Extraction**: Computes 38 features:
   - 20 frequency band power features (4 channels × 5 bands)
   - 18 coherence features (inter-channel relationships)
5. **Prediction**: KAN model predicts emotion (Angry, Happy, Relaxed, Sad)
6. **Display**: Result sent back to browser and displayed in UI

## Troubleshooting

### Muse Won't Connect
- Ensure Muse is on and charged
- Check Bluetooth is enabled on computer
- Try refreshing the page
- Use Chrome or Edge (Firefox doesn't support Web Bluetooth)

### Backend Connection Failed
- Verify backend server is running on port 5000
- Check firewall isn't blocking port 5000
- Look for errors in backend terminal

### No Predictions
- Wait at least 5 seconds for first prediction
- Check backend terminal for error messages
- Ensure model files exist in `backend/models/`:
  - `mood_model.pth`
  - `scaler.pkl`
  - `label_encoder.pkl`

### Poor Predictions
- Ensure good electrode contact (moisten sensors)
- Minimize movement and muscle tension
- Use in quiet environment
- Model may need retraining with more data

## Model Files Location
```
backend/
├── models/
│   ├── mood_model.pth         # Trained KAN model
│   ├── scaler.pkl             # Feature scaler
│   └── label_encoder.pkl      # Label encoder
```

## Development Notes

### Frontend (Next.js + React)
- Component: `frontend/src/components/MuseConnector.tsx`
- Uses `muse-js` for Web Bluetooth connection
- Uses `socket.io-client` for WebSocket communication

### Backend (Flask + SocketIO)
- Server: `backend/websocket_server.py`
- Model: `backend/KAN_prediction.py`
- Handles real-time EEG processing and predictions

## Next Steps

1. **Integrate MuseConnector into your app** - Import it in your main page
2. **Style the component** - Customize the UI to match your design
3. **Add more features**:
   - Historical emotion tracking
   - Visualization of EEG signals
   - Export/save predictions
   - Integration with Spotify recommendations

## Security Notes

⚠️ **Current setup is for development only**:
- CORS is open to all origins
- No authentication
- WebSocket not encrypted

For production:
- Use HTTPS/WSS
- Implement authentication
- Restrict CORS origins
- Add rate limiting

## Support

If you encounter issues:
1. Check both terminal outputs (frontend & backend)
2. Open browser console (F12) for JavaScript errors
3. Verify all dependencies are installed
4. Ensure model files are present and valid
