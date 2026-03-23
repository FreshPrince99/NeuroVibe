"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { MuseClient, zipSamples } from 'muse-js';
import { io, Socket } from 'socket.io-client';
import EmotionView from "@/components/EmotionView";
import CognitiveTrainingView from "@/components/CognitiveTrainingView";
import { PlayerRef } from "@/components/player";
import { initSession, finaliseSession, addEEGSnapshot } from "@/lib/sessionStore";

interface EEGData {
  tp9: number;
  af7: number;
  af8: number;
  tp10: number;
  timestamp: number;
}

interface VADData {
  valence: number;
  arousal: number;
  dominance: number;
}

export default function EmotionPage() {
  const router = useRouter();
  const [predictedEmotion, setPredictedEmotion] = useState<string>("");
  const [predictedVAD, setPredictedVAD] = useState<VADData | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [eegDataBuffer, setEegDataBuffer] = useState<EEGData[]>([]);
  const [ppgDataBuffer, setPpgDataBuffer] = useState<number[]>([]);  // for local PPG waveform
  const [valenceData, setValenceData] = useState<{ valence: "POSITIVE" | "NEGATIVE" | "UNCERTAIN"; smoothed_score: number; n_windows: number } | null>(null);
  const [ppgAvailable, setPpgAvailable] = useState<boolean | null>(null);
  const [sessionMode, setSessionMode] = useState<string>('focus');
  const ppgAvailableRef = useRef<boolean | null>(null);

  const clientRef = useRef<MuseClient | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<PlayerRef>(null);
  const testModeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSampleTimeRef = useRef<number>(0);   // epoch ms of last received EEG sample
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stored after first BLE connect — lets auto-reconnect bypass the browser device picker
  const deviceRef = useRef<BluetoothDevice | null>(null);


  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mode = (localStorage.getItem('neurovibe_mode') || 'focus') as 'focus' | 'relaxation' | 'cognitive';
    setSessionMode(mode);
    initSession(mode);
  }, []);

  // Rule-based emotion scores (focus/stress/relaxed/tired as 0-1 values)
  const [emotionScores, setEmotionScores] = useState<{ focus: number; stress: number; relaxed: number; tired: number } | null>(null);

  // Record EEG snapshots for the results page
  const vadRef = useRef(predictedVAD);
  const scoresRef = useRef(emotionScores);
  useEffect(() => { vadRef.current = predictedVAD; }, [predictedVAD]);
  useEffect(() => { scoresRef.current = emotionScores; }, [emotionScores]);
  useEffect(() => {
    if (sessionMode === 'cognitive') return; // CognitiveTrainingView handles its own snapshots
    const id = setInterval(() => {
      const vad = vadRef.current;
      const sc  = scoresRef.current;
      let focus: number, calm: number, control: number;
      if (sc) {
        // Derive metrics from rule-based scores
        focus   = Math.min(1, Math.max(0, sc.focus));
        calm    = Math.min(1, Math.max(0, sc.relaxed - sc.stress * 0.5));
        control = Math.min(1, Math.max(0, 1 - sc.tired));
      } else if (vad) {
        focus   = Math.min(1, Math.max(0, vad.arousal));
        calm    = Math.min(1, Math.max(0, 1 - vad.arousal * 0.6 + vad.valence * 0.4));
        control = Math.min(1, Math.max(0, vad.dominance));
      } else {
        return; // no data yet — skip snapshot so graph doesn't start flat
      }
      addEEGSnapshot({ focus, calm, control, symmetry: control, ppg: focus });
    }, 5000);
    return () => clearInterval(id);
  }, [sessionMode]);

  const handleStopSession = () => {
    finaliseSession();
    router.push('/results');
  };

  // Initialize WebSocket connection (skip in test mode — backend is not needed)
  useEffect(() => {
    if (sessionStorage.getItem('neurovibe_test_mode') === 'true') return;

    socketRef.current = io('http://localhost:5000', {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    // Listen for NeuroSense valence predictions
    socketRef.current.on('valence_prediction', (data: { valence: "POSITIVE" | "NEGATIVE" | "UNCERTAIN"; smoothed_score: number; n_windows: number }) => {
      setValenceData(data);
    });

    // Listen for emotion predictions
    socketRef.current.on('emotion_prediction', (data: { emotion: string; vad?: VADData; scores?: { focus: number; stress: number; relaxed: number; tired: number } }) => {
      console.log('✓ Received emotion prediction:', data.emotion);
      setPredictedEmotion(data.emotion);
      if (data.vad) setPredictedVAD(data.vad);
      if (data.scores) setEmotionScores(data.scores);
      setConnectionStatus('Live prediction active');
    });

    socketRef.current.on('connect', () => {
      console.log('✓ WebSocket connected to backend');
      setConnectionStatus('Backend connected');
      setIsConnected(true);
    });

    socketRef.current.on('disconnect', () => {
      console.log('✗ WebSocket disconnected from backend');
      setConnectionStatus('Backend disconnected');
      setIsConnected(false);
    });

    socketRef.current.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      if (sampleCount > 0) {
        setConnectionStatus('Backend connection error');
      }
    });

    // Cleanup on unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [router]);

  // Global unmount cleanup — clears watchdog and test-mode interval so they
  // don't leak into a new session started from the results page.
  useEffect(() => {
    return () => {
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
      if (testModeIntervalRef.current) {
        clearInterval(testModeIntervalRef.current);
        testModeIntervalRef.current = null;
      }
      if (clientRef.current) {
        try { clientRef.current.disconnect(); } catch { /* ignore */ }
        clientRef.current = null;
      }
    };
  }, []);

  // Reconnect when the tab comes back to the foreground.
  // Chrome suspends BLE in backgrounded tabs — without this the headset appears
  // disconnected every time the user switches away and returns.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (sessionStorage.getItem('neurovibe_test_mode') === 'true') return;
      // If EEG has been silent for >5 s and we have a saved device, reconnect silently.
      const elapsed = Date.now() - lastSampleTimeRef.current;
      if (elapsed > 5_000 && lastSampleTimeRef.current > 0 && deviceRef.current) {
        console.log(`[Visibility] tab visible, EEG silent ${Math.round(elapsed/1000)}s — auto-reconnecting`);
        void handleConnectMuse(deviceRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []); // refs-only inside — no stale closure risk

  // Prompt user to connect Muse (always show on page load)
  useEffect(() => {
    // If test mode is active, don't show the connect prompt — handled below
    if (sessionStorage.getItem('neurovibe_test_mode') === 'true') return;

    const justCompletedSetup = sessionStorage.getItem('neurovibe_just_setup');
    
    if (justCompletedSetup === 'true') {
      // Just came from setup - show connect prompt
      console.log('Setup completed, waiting for user to connect Muse...');
      sessionStorage.removeItem('neurovibe_just_setup');
      setNeedsConnect(true);
      setConnectionStatus('Click "Connect Muse Headset" to start');
    } else {
      // Always prompt for connection on page load
      setNeedsConnect(true);
      setConnectionStatus('Click "Connect Muse Headset" to start');
    }
  }, []);

  // Test mode: skip headset connection and cycle through demo emotions
  useEffect(() => {
    const isTestMode = sessionStorage.getItem('neurovibe_test_mode') === 'true';
    if (!isTestMode) return;

    console.log('🧪 Test mode active — simulating EEG emotions');
    sessionStorage.removeItem('neurovibe_just_setup');
    setNeedsConnect(false);
    setIsConnected(true);
    setConnectionStatus('🧪 Test Mode — simulated EEG data');

    const testEmotions = ['focused', 'calm', 'stressed', 'relaxed', 'neutral', 'happy'];
    let index = 0;
    setPredictedEmotion(testEmotions[0]);

    testModeIntervalRef.current = setInterval(() => {
      index = (index + 1) % testEmotions.length;
      setPredictedEmotion(testEmotions[index]);
      console.log(`🧪 Simulated emotion: ${testEmotions[index]}`);
    }, 30000); // 30 s per emotion — mirrors a realistic EEG reading window

    return () => {
      if (testModeIntervalRef.current) {
        clearInterval(testModeIntervalRef.current);
        testModeIntervalRef.current = null;
      }
    };
  }, []);

  const handleConnectMuse = async (reconnectDevice?: BluetoothDevice) => {
    // Guard: if called from a React button onClick it receives a MouseEvent — ignore it.
    // Only treat the argument as a BluetoothDevice if it genuinely has a .gatt property.
    const device: BluetoothDevice | undefined =
      reconnectDevice && (reconnectDevice as any).gatt !== undefined
        ? reconnectDevice
        : undefined;

    setIsConnecting(true);
    setConnectionStatus(device ? 'Auto-reconnecting to Muse…' : 'Connecting to Muse...');
    
    try {
      // Clear any existing connection
      if (clientRef.current) {
        try {
          clientRef.current.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      
      const client = new MuseClient();
      // Enable PPG on Muse 2 / Muse S BEFORE connect
      client.enablePpg = true;
      clientRef.current = client;

      if (device) {
        // Reuse the already-paired device — device.gatt.connect() does NOT need a
        // user gesture, so this works silently from watchdog/error callbacks.
        const freshGatt = await device.gatt!.connect();
        await client.connect(freshGatt);
      } else {
        await client.connect(); // opens browser Bluetooth picker (needs user gesture)
      }

      // Save device reference so all future auto-reconnects bypass the picker.
      const dev = ((client as any).gatt)?.device as BluetoothDevice | undefined;
      if (dev) deviceRef.current = dev;

      await client.start();
      
      setIsConnected(true);
      setNeedsConnect(false);
      setIsPaused(false);
      setIsConnecting(false);
      setConnectionStatus('Muse connected - streaming data');
      
      // Ensure WebSocket is connected
      if (!socketRef.current?.connected) {
        socketRef.current?.connect();
      }
      
      // Subscribe to EEG data
      let localSampleCount = 0;
      lastSampleTimeRef.current = Date.now(); // reset watchdog on fresh connect
      zipSamples(clientRef.current.eegReadings).subscribe({
        next: (reading) => {
          const eegData: EEGData = {
            tp9: reading.data[0],
            af7: reading.data[1],
            af8: reading.data[2],
            tp10: reading.data[3],
            timestamp: reading.timestamp
          };

          lastSampleTimeRef.current = Date.now(); // stamp every received sample

          // Update visualization buffer (keep last 512 samples for display)
          setEegDataBuffer(prev => {
            const updated = [...prev, eegData];
            return updated.slice(-512);
          });

          // Send to backend via WebSocket
          if (socketRef.current?.connected) {
            socketRef.current.emit('eeg_sample', eegData);
            localSampleCount++;
            setSampleCount(localSampleCount);

            if (localSampleCount % 256 === 0) {
              console.log(`✓ Sent ${localSampleCount} samples to backend`);
            }
          }
        },
        error: (err) => {
          console.error('EEG subscription error:', err);
          setConnectionStatus('⚠️ EEG disconnected — auto-reconnecting in 3s…');
          setIsConnected(false);
          // Pass the saved device so reconnect skips the Bluetooth picker entirely.
          setTimeout(() => { void handleConnectMuse(deviceRef.current ?? undefined); }, 3000);
        },
        complete: () => {
          // BLE disconnected gracefully — treat as a silent drop and auto-reconnect.
          console.warn('[EEG] stream completed (BLE dropped) — auto-reconnecting in 3s…');
          setConnectionStatus('⚠️ EEG stream ended — auto-reconnecting in 3s…');
          setIsConnected(false);
          setTimeout(() => { void handleConnectMuse(deviceRef.current ?? undefined); }, 3000);
        },
      });

      // Watchdog: if no EEG sample arrives for >15 s while supposedly connected,
      // flag to the user that the signal may have been lost.
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      watchdogRef.current = setInterval(() => {
        const elapsed = Date.now() - lastSampleTimeRef.current;
        if (elapsed > 10_000 && lastSampleTimeRef.current > 0) {
          console.warn(`⚠️  No EEG samples for ${Math.round(elapsed / 1000)}s — auto-reconnecting`);
          clearInterval(watchdogRef.current!);
          watchdogRef.current = null;
          setConnectionStatus('⚠️ EEG signal lost — auto-reconnecting…');
          setIsConnected(false);
          setTimeout(() => { void handleConnectMuse(deviceRef.current ?? undefined); }, 1500);
        }
      }, 5_000);

      // Subscribe to PPG data (Muse 2 only — photoplethysmography for heart rate)
      // ppgReadings emits packets of ~6 samples at ~64 Hz per channel
      if (clientRef.current.ppgReadings) {
        setPpgAvailable(null);
        ppgAvailableRef.current = null;
        const pushPpgValue = (value: number, timestamp: number) => {
          if (value === null || isNaN(value)) return;
          if (ppgAvailableRef.current !== true) {
            ppgAvailableRef.current = true;
            setPpgAvailable(true);
          }
          if (socketRef.current?.connected) {
            socketRef.current!.emit('ppg_sample', { value, timestamp });
          }
          setPpgDataBuffer(prev => {
            const updated = [...prev, value];
            return updated.length > 512 ? updated.slice(-512) : updated;
          });
        };

        // If no PPG arrives within 12 s, mark unavailable
        const ppgTimeout = setTimeout(() => {
          if (ppgAvailableRef.current === null) {
            ppgAvailableRef.current = false;
            setPpgAvailable(false);
          }
        }, 12_000);

        let logged = false;
        clientRef.current.ppgReadings.subscribe(reading => {
          const samples = (reading as any).samples ?? (reading as any).data ?? [];
          const channel = (reading as any).ppgChannel;
          // Prefer a single channel for consistency (Muse 2: 2=red, 1=infrared, 0=ambient)
          if (typeof channel === 'number' && channel !== 2) return;
          if (Array.isArray(samples) && samples.length > 0) {
            if (Array.isArray(samples[0])) {
              // samples = [channel][values] — use first channel for stability
              (samples[0] as number[]).forEach(v => pushPpgValue(v, reading.timestamp));
            } else {
              (samples as number[]).forEach(v => pushPpgValue(v, reading.timestamp));
            }
            if (!logged) {
              console.log('✓ PPG data received');
              logged = true;
            }
            if (ppgTimeout) clearTimeout(ppgTimeout);
          }
        });
        console.log('✓ PPG subscription active (Muse 2 heart rate)');
      } else {
        setPpgAvailable(false);
        ppgAvailableRef.current = false;
        console.log('⚠️  PPG not available on this device');
      }
    } catch (error: any) {
      console.error('Failed to reconnect Muse:', error);
      
      if (error.name === 'NotFoundError' || error.message?.includes('cancel')) {
        setConnectionStatus('Connection cancelled - click to retry');
      } else if (error.name === 'NotAllowedError') {
        setConnectionStatus('Permission denied - please allow Bluetooth access');
      } else {
        setConnectionStatus('Connection failed: ' + (error.message || 'Unknown error'));
      }
      
      setIsConnecting(false);
      setIsConnected(false);
      setNeedsConnect(true);
    }
  };

  const handlePauseToggle = () => {
    const isTestMode = sessionStorage.getItem('neurovibe_test_mode') === 'true';

    if (isPaused) {
      if (isTestMode) {
        // Resume test mode — restart the emotion cycle
        setIsPaused(false);
        setIsConnected(true);
        setConnectionStatus('🧪 Test Mode — simulated EEG data');
        const testEmotions = ['focused', 'calm', 'stressed', 'relaxed', 'neutral', 'happy'];
        let index = testEmotions.indexOf(predictedEmotion) ?? 0;
        testModeIntervalRef.current = setInterval(() => {
          index = (index + 1) % testEmotions.length;
          setPredictedEmotion(testEmotions[index]);
        }, 30000);
      } else {
        // Resume real headset — reconnect
        handleConnectMuse();
      }
    } else {
      // Pause — stop cycle / disconnect headset
      if (testModeIntervalRef.current) {
        clearInterval(testModeIntervalRef.current);
        testModeIntervalRef.current = null;
      }
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
      if (clientRef.current) {
        clientRef.current.disconnect();
      }
      setIsPaused(true);
      setIsConnected(false);
      setConnectionStatus(isTestMode ? '🧪 Test Mode paused' : 'Paused - Click "Resume" to continue');
    }
  };

  const handleExitToHome = () => {
    // Stop test mode interval if running
    if (testModeIntervalRef.current) {
      clearInterval(testModeIntervalRef.current);
      testModeIntervalRef.current = null;
    }
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    localStorage.removeItem('neurovibe_test_mode');
    sessionStorage.removeItem('neurovibe_test_mode');

    // Pause music
    if (playerRef.current) {
      playerRef.current.pause();
    }
    
    // Disconnect everything
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    
    // Clear all localStorage
    localStorage.removeItem('neurovibe_muse_connected');
    localStorage.removeItem('neurovibe_awaiting_spotify');
    
    // Navigate to landing page
    router.push('/');
  };

  const handleBackToHome = () => {
    // Pause music
    if (playerRef.current) {
      playerRef.current.pause();
    }
    
    // Navigate to landing page without clearing everything
    router.push('/');
  };

  return (
    <div className="relative">
      {valenceData && valenceData.valence !== "UNCERTAIN" && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl border backdrop-blur-md text-sm font-light shadow-xl"
          style={{
            background:   valenceData.valence === 'POSITIVE' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
            borderColor:  valenceData.valence === 'POSITIVE' ? 'rgba(34,197,94,0.4)'  : 'rgba(239,68,68,0.4)',
            color:        valenceData.valence === 'POSITIVE' ? '#86efac'               : '#fca5a5',
          }}
        >
          <span className="text-lg">{valenceData.valence === 'POSITIVE' ? '😊' : '😔'}</span>
          <div>
            <p className="font-medium">{valenceData.valence === 'POSITIVE' ? 'Positive response' : 'Negative response'}</p>
            <p className="text-xs opacity-70">score {valenceData.smoothed_score.toFixed(2)} · {valenceData.n_windows} windows</p>
          </div>
        </div>
      )}
      {sessionMode === 'cognitive' ? (
        <CognitiveTrainingView
          eegData={eegDataBuffer}
          ppgData={ppgDataBuffer}
          predictedVAD={predictedVAD}
          sampleCount={sampleCount}
          connectionStatus={connectionStatus}
          onPauseToggle={handlePauseToggle}
          isPaused={isPaused}
          needsConnect={needsConnect}
          isConnecting={isConnecting}
          onConnect={() => { void handleConnectMuse(); }}
          onBackToHome={handleBackToHome}
          onStopSession={handleStopSession}
        />
      ) : (
        <EmotionView
          predictedEmotion={predictedEmotion}
          predictedVAD={predictedVAD}
          isUsingMusePrediction={true}
          sampleCount={sampleCount}
          connectionStatus={connectionStatus}
          onPauseToggle={handlePauseToggle}
          isPaused={isPaused}
          needsConnect={needsConnect}
          isConnecting={isConnecting}
          onConnect={() => { void handleConnectMuse(); }}
          eegData={eegDataBuffer}
          ppgData={ppgDataBuffer}
          ppgAvailable={ppgAvailable}
          onExitToHome={handleExitToHome}
          onBackToHome={handleBackToHome}
          onStopSession={handleStopSession}
          playerRef={playerRef}
          valence={valenceData}
        />
      )}
    </div>
  );
}
