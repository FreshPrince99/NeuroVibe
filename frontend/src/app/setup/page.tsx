"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { MuseClient, zipSamples } from 'muse-js';
import { io, Socket } from 'socket.io-client';
import SetupGuide from "@/components/SetupGuide";

export default function SetupPage() {
  const router = useRouter();
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('');
  const [spotifyAuthenticated, setSpotifyAuthenticated] = useState(false);
  const [isClient, setIsClient] = useState(false);
  
  const clientRef = useRef<MuseClient | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Mark when client-side is ready
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Initialize WebSocket connection
  useEffect(() => {
    socketRef.current = io('http://localhost:5000', {
      transports: ['websocket'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    socketRef.current.on('emotion_prediction', (data: { emotion: string }) => {
      console.log('✓ Received emotion prediction:', data.emotion);
    });

    socketRef.current.on('connect', () => {
      console.log('✓ WebSocket connected to backend');
      setConnectionStatus('Backend connected');
    });

    socketRef.current.on('disconnect', () => {
      console.log('✗ WebSocket disconnected from backend');
    });

    socketRef.current.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Check if user returned from Spotify auth
  useEffect(() => {
    if (!isClient) return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const awaitingSpotify = localStorage.getItem('neurovibe_awaiting_spotify');
    
    if (urlParams.get('spotify') === 'success' && awaitingSpotify === 'true') {
      // Store Spotify tokens FIRST before doing anything else
      const accessToken = urlParams.get('access_token');
      const refreshToken = urlParams.get('refresh_token');
      const expiresIn = urlParams.get('expires_in');
      
      if (accessToken) {
        console.log("✓ Storing Spotify tokens from OAuth callback");
        localStorage.setItem("spotify_access_token", accessToken);
        if (refreshToken) {
          localStorage.setItem("spotify_refresh_token", refreshToken);
        }
        if (expiresIn) {
          const expiryTime = Date.now() + parseInt(expiresIn) * 1000;
          localStorage.setItem("spotify_token_expiry", expiryTime.toString());
        }
      }
      
      setSpotifyAuthenticated(true);
      setConnectionStatus('Spotify connected successfully!');
      
      // Clear flags
      localStorage.removeItem('neurovibe_awaiting_spotify');
      
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Auto-transition to main after a brief moment
      setTimeout(() => {
        router.push('/emotion');
      }, 1500);
    }
  }, [isClient, router]);

  const handleConnect = async () => {
    setIsConnecting(true);
    setConnectionStatus('Connecting to Muse...');
    
    try {
      // Initialize Muse client
      clientRef.current = new MuseClient();
      await clientRef.current.connect();
      await clientRef.current.start();
      
      setIsConnected(true);
      setConnectionStatus('Muse connected successfully!');
      setIsConnecting(false);
      
      // Save connection state
      localStorage.setItem('neurovibe_muse_connected', 'true');
      
      // Connect to backend WebSocket only after Muse is streaming
      setTimeout(() => {
        socketRef.current?.connect();
      }, 500);
      
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
          
          // Update status every 256 samples (1 second at 256 Hz)
          if (localSampleCount % 256 === 0) {
            console.log(`✓ Sent ${localSampleCount} samples to backend`);
          }
        }
      });
      
      // Ready for next step
      setTimeout(() => {
        setConnectionStatus('Ready for Spotify authentication');
      }, 1000);
      
    } catch (error: any) {
      console.error('Connection failed:', error);
      
      // Handle user cancellation
      if (error.name === 'NotFoundError' || error.message?.includes('cancel') || error.message?.includes('User cancel')) {
        setConnectionStatus('Connection cancelled. Please try again.');
      } else if (error.name === 'NotAllowedError') {
        setConnectionStatus('Permission denied. Please allow Bluetooth access.');
      } else {
        setConnectionStatus('Connection failed: ' + error.message);
      }
      
      setIsConnecting(false);
      setIsConnected(false);
    }
  };

  const handleSpotifyAuth = () => {
    // Save current state before redirecting
    localStorage.setItem('neurovibe_awaiting_spotify', 'true');
    
    // Redirect to Spotify auth
    window.location.href = '/api/auth/spotify';
  };

  const handleSetupComplete = () => {
    // Navigate to main emotion view
    router.push('/emotion');
  };

  return (
    <SetupGuide 
      onConnect={handleConnect}
      onSpotifyAuth={handleSpotifyAuth}
      onComplete={handleSetupComplete}
      isConnecting={isConnecting}
      isConnected={isConnected}
      spotifyAuthenticated={spotifyAuthenticated}
      connectionStatus={connectionStatus}
    />
  );
}
