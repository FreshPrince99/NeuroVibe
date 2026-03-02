// frontend/src/components/MuseConnector.tsx
'use client';
import { useState, useEffect, useRef } from 'react';
import { MuseClient, zipSamples } from 'muse-js';
import { io, Socket } from 'socket.io-client';

interface MuseConnectorProps {
  onEmotionPredicted?: (emotion: string) => void;
}

export default function MuseConnector({ onEmotionPredicted }: MuseConnectorProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [emotion, setEmotion] = useState('');
  const [status, setStatus] = useState('Disconnected');
  const [sampleCount, setSampleCount] = useState(0);
  
  const clientRef = useRef<MuseClient | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Initialize Socket.IO connection
    socketRef.current = io('http://localhost:5000', {
      transports: ['websocket'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    // Listen for emotion predictions
    socketRef.current.on('emotion_prediction', (data: { emotion: string }) => {
      console.log('✓ Received emotion prediction:', data.emotion);
      setEmotion(data.emotion);
      setStatus('Predicted: ' + data.emotion);
      
      // Call the parent callback if provided
      if (onEmotionPredicted) {
        onEmotionPredicted(data.emotion);
      }
    });

    socketRef.current.on('connect', () => {
      console.log('✓ WebSocket connected to backend');
      setStatus('WebSocket connected');
    });

    socketRef.current.on('disconnect', () => {
      console.log('✗ WebSocket disconnected from backend');
      setStatus('WebSocket disconnected');
    });

    socketRef.current.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      setStatus('Connection error: ' + error.message);
    });

    socketRef.current.on('error', (error) => {
      console.error('WebSocket error:', error);
      setStatus('Error: ' + error);
    });

    socketRef.current.on('status', (data) => {
      console.log('Backend status:', data.message);
    });

    // Cleanup on unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      if (clientRef.current) {
        clientRef.current.disconnect();
      }
    };
  }, []);

  const connectMuse = async () => {
    try {
      setStatus('Connecting to Muse...');
      
      // Initialize Muse client
      clientRef.current = new MuseClient();
      await clientRef.current.connect();
      await clientRef.current.start();
      
      setIsConnected(true);
      setStatus('Connected to Muse');
      
      // Connect to backend WebSocket
      socketRef.current?.connect();
      
      // Subscribe to EEG data (TP9, AF7, AF8, TP10)
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
          
          // Update status every 256 samples (1 second at 256 Hz)
          if (localSampleCount % 256 === 0) {
            const seconds = Math.floor(localSampleCount / 256);
            setStatus(`Streaming... ${seconds}s (${localSampleCount} samples)`);
            console.log(`✓ Sent ${localSampleCount} samples to backend`);
          }
        } else {
          console.warn('⚠️ WebSocket not connected, sample not sent');
        }
      });

      // Subscribe to PPG data (Muse 2 only — photoplethysmography for heart rate)
      if (clientRef.current.ppgReadings) {
        clientRef.current.ppgReadings.subscribe(reading => {
          if (!socketRef.current?.connected) return;
          reading.samples.forEach((value: number) => {
            if (value !== null && !isNaN(value)) {
              socketRef.current!.emit('ppg_sample', {
                value,
                timestamp: reading.timestamp,
              });
            }
          });
        });
        console.log('✓ PPG subscription active (Muse 2 heart rate)');
      }
      
    } catch (error) {
      console.error('Connection failed:', error);
      setStatus('Connection failed: ' + (error as Error).message);
    }
  };

  const disconnectMuse = () => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    setIsConnected(false);
    setStatus('Disconnected');
    setSampleCount(0);
  };

  return (
    <div className="p-6 max-w-md mx-auto bg-white rounded-xl shadow-md space-y-4">
      <h2 className="text-2xl font-bold text-gray-800">Muse EEG Connector</h2>
      
      <div className="space-y-2">
        <p className="text-sm text-gray-600">
          Status: <span className="font-semibold">{status}</span>
        </p>
        <p className="text-sm text-gray-600">
          Samples: <span className="font-semibold">{sampleCount}</span>
        </p>
        {emotion && (
          <p className="text-lg font-bold text-blue-600">
            Current Emotion: {emotion}
          </p>
        )}
      </div>

      <div className="flex space-x-2">
        <button
          onClick={connectMuse}
          disabled={isConnected}
          className={`flex-1 py-2 px-4 rounded font-semibold ${
            isConnected
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-blue-500 text-white hover:bg-blue-600'
          }`}
        >
          {isConnected ? 'Connected' : 'Connect Muse'}
        </button>
        
        <button
          onClick={disconnectMuse}
          disabled={!isConnected}
          className={`flex-1 py-2 px-4 rounded font-semibold ${
            !isConnected
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-red-500 text-white hover:bg-red-600'
          }`}
        >
          Disconnect
        </button>
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        <p>• Make sure your Muse headset is on and nearby</p>
        <p>• Backend server must be running on localhost:5000</p>
        <p>• Prediction updates every ~5 seconds (rule-based) or longer for ML models</p>
      </div>
    </div>
  );
}
