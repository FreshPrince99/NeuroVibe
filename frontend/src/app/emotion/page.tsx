"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { MuseClient, zipSamples } from 'muse-js';
import { io, Socket } from 'socket.io-client';
import EmotionView from "@/components/EmotionView";
import { PlayerRef } from "@/components/player";

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
  
  const clientRef = useRef<MuseClient | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<PlayerRef>(null);

  // Initialize WebSocket connection
  useEffect(() => {
    socketRef.current = io('http://localhost:5000', {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    // Listen for emotion predictions
    socketRef.current.on('emotion_prediction', (data: { emotion: string; vad?: VADData }) => {
      console.log('✓ Received emotion prediction:', data.emotion);
      setPredictedEmotion(data.emotion);
      if (data.vad) {
        setPredictedVAD(data.vad);
      }
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

  // Prompt user to connect Muse (always show on page load)
  useEffect(() => {
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

  const handleConnectMuse = async () => {
    setIsConnecting(true);
    setConnectionStatus('Connecting to Muse...');
    
    try {
      // Clear any existing connection
      if (clientRef.current) {
        try {
          clientRef.current.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      
      clientRef.current = new MuseClient();
      await clientRef.current.connect();
      await clientRef.current.start();
      
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
      zipSamples(clientRef.current.eegReadings).subscribe(reading => {
        const eegData: EEGData = {
          tp9: reading.data[0],
          af7: reading.data[1],
          af8: reading.data[2],
          tp10: reading.data[3],
          timestamp: reading.timestamp
        };
        
        // Update visualization buffer (keep last 512 samples for display)
        setEegDataBuffer(prev => {
          const updated = [...prev, eegData];
          return updated.slice(-512); // Keep only last 512 samples
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
      });
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
    if (isPaused) {
      // Resume - reconnect
      handleConnectMuse();
    } else {
      // Pause - disconnect but don't show popup
      if (clientRef.current) {
        clientRef.current.disconnect();
      }
      setIsPaused(true);
      setIsConnected(false);
      setConnectionStatus('Paused - Click "Resume" to continue');
    }
  };

  const handleExitToHome = () => {
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
      onConnect={handleConnectMuse}
      eegData={eegDataBuffer}
      onExitToHome={handleExitToHome}
      onBackToHome={handleBackToHome}
      playerRef={playerRef}
    />
  );
}
