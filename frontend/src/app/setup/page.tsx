"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import SetupGuide from "@/components/SetupGuide";

export default function SetupPage() {
  const router = useRouter();
  const [spotifyAuthenticated, setSpotifyAuthenticated] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Mark when client-side is ready
  useEffect(() => {
    setIsClient(true);
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
      
      // Clear flags
      localStorage.removeItem('neurovibe_awaiting_spotify');
      
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [isClient, router]);

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

  const handleBackToHome = () => {
    // Clear localStorage
    localStorage.removeItem('neurovibe_awaiting_spotify');
    
    // Navigate to landing page
    router.push('/');
  };

  return (
    <SetupGuide 
      onSpotifyAuth={handleSpotifyAuth}
      onComplete={handleSetupComplete}
      spotifyAuthenticated={spotifyAuthenticated}
      onBackToHome={handleBackToHome}
    />
  );
}
