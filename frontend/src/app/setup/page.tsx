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
  const [showLoadingScreen, setShowLoadingScreen] = useState(false);
  
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
      setShowLoadingScreen(true);
      
      // Clear flags
      localStorage.removeItem('neurovibe_awaiting_spotify');
      
      // Set flag to indicate user just completed setup
      sessionStorage.setItem('neurovibe_just_setup', 'true');
      
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Redirect to emotion page after brief delay
      setTimeout(() => {
        router.push('/emotion');
      }, 2000);
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
    // Set flag to indicate user just completed setup
    sessionStorage.setItem('neurovibe_just_setup', 'true');
    
    // Navigate to main emotion view
    router.push('/emotion');
  };

  // Show loading screen after Spotify auth
  if (showLoadingScreen) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white">
        <div className="max-w-2xl mx-auto text-center space-y-8 px-4">
          {/* Animated checkmark */}
          <div className="relative">
            <div className="w-32 h-32 mx-auto rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center animate-pulse">
              <svg className="w-16 h-16 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>

          {/* Success messages */}
          <div className="space-y-4">
            <h2 className="text-4xl font-bold bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent">
              All Set! 🎉
            </h2>
            <div className="space-y-2 text-lg text-gray-300">
              <p className="flex items-center justify-center gap-2">
                <span className="text-green-400">✓</span> Muse headset configured
              </p>
              <p className="flex items-center justify-center gap-2">
                <span className="text-green-400">✓</span> Spotify connected
              </p>
            </div>
          </div>

          {/* Loading animation */}
          <div className="flex flex-col items-center gap-4 pt-8">
            <svg className="animate-spin h-8 w-8 text-purple-500" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="text-gray-400">Preparing your experience...</p>
          </div>
        </div>
      </div>
    );
  }

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
