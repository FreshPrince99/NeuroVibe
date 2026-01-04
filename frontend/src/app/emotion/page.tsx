"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { MuseClient, zipSamples } from 'muse-js';
import { io, Socket } from 'socket.io-client';
import EmotionView from "@/components/EmotionView";

export default function EmotionPage() {
  const router = useRouter();
  const [predictedEmotion, setPredictedEmotion] = useState<string>("");
  const [sampleCount, setSampleCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const clientRef = useRef<MuseClient | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Initialize WebSocket connection
  useEffect(() => {
    // Check if user has completed setup
    const museConnected = localStorage.getItem('neurovibe_muse_connected');
    if (museConnected !== 'true') {
      // Redirect to setup if not connected
      router.push('/setup');
      return;
    }

    socketRef.current = io('http://localhost:5000', {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    // Listen for emotion predictions
    socketRef.current.on('emotion_prediction', (data: { emotion: string }) => {
      console.log('✓ Received emotion prediction:', data.emotion);
      setPredictedEmotion(data.emotion);
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

  // Prompt user to reconnect Muse
  useEffect(() => {
    // Check if Muse was connected on setup page
    const museConnected = localStorage.getItem('neurovibe_muse_connected');
    if (museConnected === 'true') {
      // Show reconnect prompt since Web Bluetooth connections don't persist across page navigation
      setNeedsReconnect(true);
      setConnectionStatus('Click "Reconnect Muse" to start streaming');
    }
  }, []);

  const handleReconnectMuse = async () => {
    setIsConnecting(true);
    setConnectionStatus('Connecting to Muse...');
    
    try {
      clientRef.current = new MuseClient();
      await clientRef.current.connect();
      await clientRef.current.start();
      
      setIsConnected(true);
      setNeedsReconnect(false);
      setIsConnecting(false);
      setConnectionStatus('Muse connected - streaming data');
      
      // Subscribe to EEG data
      let localSampleCount = 0;
      zipSamples(clientRef.current.eegReadings).subscribe(reading => {
        const eegData = {
          tp9: reading.data[0],
          af7: reading.data[1],
          af8: reading.data[2],
          tp10: reading.data[3],
          timestamp: reading.timestamp
        };
        
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
      } else {
        setConnectionStatus('Connection failed - click to retry');
      }
      
      setIsConnecting(false);
      setIsConnected(false);
      setNeedsReconnect(true);
    }
  };

  const handleDisconnect = () => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    
    // Clear localStorage
    localStorage.removeItem('neurovibe_muse_connected');
    localStorage.removeItem('neurovibe_awaiting_spotify');
    
    // Navigate back to landing page
    router.push('/');
  };

  return (
    <EmotionView
      predictedEmotion={predictedEmotion}
      isUsingMusePrediction={true}
      sampleCount={sampleCount}
      connectionStatus={connectionStatus}
      onDisconnect={handleDisconnect}
      needsReconnect={needsReconnect}
      isConnecting={isConnecting}
      onReconnect={handleReconnectMuse}
    />
  );
}
