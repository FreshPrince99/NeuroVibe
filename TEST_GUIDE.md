# Testing Guide for NeuroVibe

## Quick Test Checklist

### 1. Start Backend Server

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python websocket_server.py
```

**Expected Output:**
```
Using device: cpu
✓ EmotionPredictor ready!

============================================================
🧠 EEG Emotion Prediction WebSocket Server
============================================================
Server starting on http://localhost:5000
Buffer size: 1280 samples (5.0s)
Waiting for connections...
============================================================
```

### 2. Start Frontend

```powershell
cd frontend
npm run dev
```

**Expected Output:**
```
▲ Next.js 14.x.x
- Local:        http://localhost:3000
```

### 3. Open Browser

- Navigate to: `http://localhost:3000`
- **Must use Chrome or Edge** (Web Bluetooth required)
- Open Developer Console (F12) to see logs

### 4. Connect Muse Headset

1. **Turn on Muse headset** - LED should be blinking blue
2. Click **"Connect Muse"** button in the app
3. Select your Muse device from the Bluetooth pairing dialog
4. Wait for connection...

### 5. Monitor Console Logs

**Frontend Console (F12):**
```
✓ WebSocket connected to backend
✓ Sent 256 samples to backend
✓ Sent 512 samples to backend
✓ Sent 768 samples to backend
✓ Sent 1024 samples to backend
✓ Sent 1280 samples to backend
✓ Received emotion prediction: Happy
```

**Backend Terminal:**
```
✓ Client connected
📊 Buffer: 256/1280 samples (1.0s)
📊 Buffer: 512/1280 samples (2.0s)
📊 Buffer: 768/1280 samples (3.0s)
📊 Buffer: 1024/1280 samples (4.0s)
📊 Buffer: 1280/1280 samples (5.0s)

==================================================
🧠 Processing 1280 samples for prediction...
✓ Channel data shapes: [(1280,), (1280,), (1280,), (1280,)]
✓ Sample values - TP9: [123.45 234.56 345.67], AF7: [456.78 567.89 678.90]
⚙️  Computing advanced EEG features...
🎯 Making emotion prediction...
✓ Predicted emotion: Happy
==================================================

🔄 Buffer reset, keeping 640 samples for overlap
```

### 6. Verify UI Updates

- **Emotion Circle** should change color (e.g., Yellow for Happy)
- **Text** should show "Happy" with "🧠 Live from Muse" badge
- **Status** should show "Predicted: Happy"
- **Sample Count** should be incrementing
- **Spotify Player** should update with Happy-themed music

## Troubleshooting

### Issue: "WebSocket not connected"

**Check:**
1. Backend server is running on port 5000
2. No firewall blocking port 5000
3. Check backend terminal for errors

**Fix:**
```powershell
# Restart backend
cd backend
python websocket_server.py
```

### Issue: "No predictions after 5+ seconds"

**Check Browser Console:**
- Look for "✓ Sent X samples" messages
- Should reach 1280+ samples

**Check Backend Terminal:**
- Look for "📊 Buffer" progress messages
- Should reach 1280/1280

**Debug:**
Add this to browser console:
```javascript
// Check WebSocket connection
socketRef.current?.connected  // should be true
```

### Issue: "Feature extraction failed"

**Possible Causes:**
1. Invalid EEG data (all zeros or NaN)
2. Model files missing
3. Numpy array conversion issue

**Check:**
- Model files exist: `mood_model.pth`, `scaler.pkl`, `label_encoder.pkl`
- Backend logs show actual sample values (not zeros)
- Muse headset is properly fitted (good contact)

### Issue: "Muse won't connect"

**Solutions:**
1. Use Chrome or Edge (not Firefox/Safari)
2. Ensure Bluetooth is enabled
3. Muse headset is on and charged
4. Unpair/re-pair Muse from system Bluetooth
5. Refresh the page and try again
6. Make sure headset isn't connected to another device

### Issue: "Module 'kan' not found"

**Fix:**
```powershell
cd backend
.\.venv\Scripts\Activate.ps1
pip install pykan
```

### Issue: Port 5000 already in use

**Find what's using port 5000:**
```powershell
netstat -ano | findstr :5000
```

**Kill the process:**
```powershell
taskkill /PID <PID> /F
```

## Performance Expectations

- **Sample Rate**: 256 Hz (256 samples/second)
- **Buffer Time**: 5 seconds (1280 samples)
- **Prediction Frequency**: Every 2.5 seconds (with 50% overlap)
- **First Prediction**: ~5-6 seconds after connection
- **Subsequent Predictions**: Every ~2.5 seconds

## Data Flow Verification

### Step-by-step data flow check:

1. **Muse → Browser**: Check browser console for EEG readings
   ```javascript
   // Should see samples coming in at ~256Hz
   ```

2. **Browser → Backend**: Check backend terminal
   ```
   📊 Buffer: 256/1280 samples (1.0s)  ← Should increment
   ```

3. **Backend Processing**: Look for
   ```
   🧠 Processing 1280 samples for prediction...
   ✓ Channel data shapes: [(1280,), (1280,), (1280,), (1280,)]
   ```

4. **Prediction**: Look for
   ```
   ✓ Predicted emotion: [Emotion]
   ```

5. **Backend → Frontend**: Browser console should show
   ```
   ✓ Received emotion prediction: [Emotion]
   ```

6. **UI Update**: Emotion circle changes color immediately

## Common Mistakes

❌ **Forgetting to activate venv**
```powershell
# Always activate before running Python
.\.venv\Scripts\Activate.ps1
```

❌ **Wrong browser**
- Must use Chrome or Edge (Web Bluetooth API)

❌ **Backend not running**
- Start backend BEFORE connecting Muse

❌ **Poor electrode contact**
- Moisten Muse sensors slightly
- Adjust headband for snug fit

❌ **Model files missing**
- Ensure all 3 files exist in `backend/models/`

## Success Indicators

✅ Backend shows: "✓ Client connected"
✅ Browser shows: "✓ WebSocket connected to backend"
✅ Sample count increments in UI
✅ Backend shows buffer filling: "📊 Buffer: X/1280"
✅ Backend processes after 1280 samples
✅ Frontend receives prediction
✅ UI updates automatically
✅ Spotify player changes based on emotion

## Still Not Working?

1. **Restart everything:**
   - Close frontend and backend
   - Turn off Muse headset
   - Clear browser cache
   - Start fresh

2. **Check logs carefully:**
   - Frontend console (F12)
   - Backend terminal
   - Look for specific error messages

3. **Test backend independently:**
   ```powershell
   cd backend
   python KAN_prediction.py
   # Should work with BlueMuse
   ```

4. **Verify installations:**
   ```powershell
   # Backend
   pip list | grep -E "flask|socketio|torch|numpy"
   
   # Frontend
   npm list muse-js socket.io-client
   ```
