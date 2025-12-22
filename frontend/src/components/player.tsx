"use client";

import { useEffect, useState } from "react";

interface Track {
  name: string;
  artist: string;
  album: string;
  albumArt: string;
  uri: string;
}

interface PlayerProps {
  emotion: string;
}

export default function Player({ emotion }: PlayerProps) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [player, setPlayer] = useState<any>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [accessToken, setAccessToken] = useState<string>("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Fetch access token from localStorage
  useEffect(() => {
    const token = localStorage.getItem("spotify_access_token");
    console.log("Token from localStorage:", !!token);
    
    if (token) {
      setAccessToken(token);
      setIsAuthenticated(true);
    } else {
      setIsAuthenticated(false);
    }
  }, []);

  // Store token after redirect from Spotify
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('auth') === 'success') {
      const accessToken = urlParams.get('access_token');
      const refreshToken = urlParams.get('refresh_token');
      const expiresIn = urlParams.get('expires_in');
      
      if (accessToken) {
        console.log("Storing token in localStorage");
        localStorage.setItem("spotify_access_token", accessToken);
        if (refreshToken) {
          localStorage.setItem("spotify_refresh_token", refreshToken);
        }
        if (expiresIn) {
          const expiryTime = Date.now() + parseInt(expiresIn) * 1000;
          localStorage.setItem("spotify_token_expiry", expiryTime.toString());
        }
        
        setAccessToken(accessToken);
        setIsAuthenticated(true);
        
        // Clean up URL
        window.history.replaceState({}, '', '/');
      }
    }
  }, []);

  // Initialize Spotify Web Playback SDK
  useEffect(() => {
    if (!accessToken) return;

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      const spotifyPlayer = new window.Spotify.Player({
        name: "NeuroVibe Player",
        getOAuthToken: (cb: (token: string) => void) => {
          cb(accessToken);
        },
        volume: 0.5,
      });

      spotifyPlayer.addListener("ready", ({ device_id }: { device_id: string }) => {
        console.log("Ready with Device ID", device_id);
        setDeviceId(device_id);
      });

      spotifyPlayer.addListener("not_ready", ({ device_id }: { device_id: string }) => {
        console.log("Device ID has gone offline", device_id);
      });

      spotifyPlayer.addListener("player_state_changed", (state: any) => {
        if (!state) return;
        
        const track = state.track_window.current_track;
        setCurrentTrack({
          name: track.name,
          artist: track.artists.map((a: any) => a.name).join(", "),
          album: track.album.name,
          albumArt: track.album.images[0]?.url || "",
          uri: track.uri,
        });
        setIsPlaying(!state.paused);
      });

      spotifyPlayer.addListener("initialization_error", ({ message }: { message: string }) => {
        console.error("Initialization error:", message);
      });

      spotifyPlayer.addListener("authentication_error", ({ message }: { message: string }) => {
        console.error("Authentication error:", message);
      });

      spotifyPlayer.addListener("account_error", ({ message }: { message: string }) => {
        console.error("Account error:", message);
      });

      spotifyPlayer.addListener("playback_error", ({ message }: { message: string }) => {
        console.error("Playback error:", message);
      });

      spotifyPlayer.connect().then((success: boolean) => {
        if (success) {
          console.log("The Web Playback SDK successfully connected to Spotify!");
        } else {
          console.error("The Web Playback SDK could not connect to Spotify");
        }
      });

      setPlayer(spotifyPlayer);
    };

    return () => {
      if (player) {
        player.disconnect();
      }
    };
  }, [accessToken]);

  // Search and play music based on emotion
  useEffect(() => {
    if (!deviceId || !accessToken) {
      console.log("Waiting for device or token. Device:", !!deviceId, "Token:", !!accessToken);
      return;
    }

    const searchAndPlay = async () => {
      try {
        console.log("Searching for", emotion, "mood playlists");
        
        // Search for playlists based on emotion
        const searchQuery = encodeURIComponent(`${emotion} mood`);
        const searchResponse = await fetch(
          `https://api.spotify.com/v1/search?q=${searchQuery}&type=playlist&limit=10&market=US`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );
        
        if (!searchResponse.ok) {
          console.error("Search API error:", searchResponse.status);
          const errorText = await searchResponse.text();
          console.error("Search error details:", errorText);
          return;
        }
        
        const searchData = await searchResponse.json();
        console.log("Full search response:", JSON.stringify(searchData, null, 2));
        
        // Check the actual structure
        if (!searchData.playlists || !searchData.playlists.items) {
          console.error("Unexpected response structure:", searchData);
          return;
        }
        
        const playlists = searchData.playlists.items.filter((p: any) => p !== null && p.id);
        console.log("Number of valid playlists found:", playlists.length);
        
        if (playlists.length > 0) {
          const firstPlaylist = playlists[0];
          console.log("First playlist:", {
            id: firstPlaylist.id,
            name: firstPlaylist.name,
            owner: firstPlaylist.owner?.display_name
          });
          
          // Get tracks from the first playlist
          const playlistId = firstPlaylist.id;
          
          const tracksResponse = await fetch(
            `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&market=US`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            }
          );
          
          if (!tracksResponse.ok) {
            console.error("Tracks API error:", tracksResponse.status);
            const errorText = await tracksResponse.text();
            console.error("Tracks API error details:", errorText);
            return;
          }
          
          const tracksData = await tracksResponse.json();
          const tracks = tracksData.items?.filter((item: any) => item?.track?.uri && !item.track.is_local) || [];
          
          console.log("Found", tracks.length, "playable tracks in playlist");
          
          if (tracks.length > 0) {
            // Pick a random track
            const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
            const trackUri = randomTrack.track.uri;
            const trackName = randomTrack.track.name;
            const artistName = randomTrack.track.artists[0]?.name;
            
            console.log("Attempting to play:", trackName, "by", artistName);
            console.log("Track URI:", trackUri);
            console.log("Device ID:", deviceId);
            
            // Play the track
            const playResponse = await fetch(
              `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  uris: [trackUri],
                }),
              }
            );
            
            console.log("Play response status:", playResponse.status);
            
            if (!playResponse.ok) {
              const errorText = await playResponse.text();
              console.error("Error playing track. Status:", playResponse.status);
              console.error("Error details:", errorText);
            } else {
              console.log("Successfully initiated playback");
            }
          } else {
            console.error("No playable tracks found in playlist");
          }
        } else {
          console.error("No valid playlists found");
        }
      } catch (error) {
        console.error("Error in searchAndPlay:", error);
      }
    };

    searchAndPlay();
  }, [emotion, deviceId, accessToken]);

  const togglePlayPause = () => {
    if (player) {
      player.togglePlay();
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-zinc-500 dark:text-zinc-400">
          Connect Spotify to start playing music
        </p>
        <button
          onClick={() => {
            window.location.href = "/api/auth/spotify";
          }}
          className="rounded-lg bg-green-500 px-6 py-3 font-semibold text-white transition-colors hover:bg-green-600"
        >
          Connect Spotify
        </button>
      </div>
    );
  }

  if (!currentTrack) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-zinc-500 dark:text-zinc-400">
          Loading music based on your mood...
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      {/* Album Art */}
      {currentTrack.albumArt && (
        <img
          src={currentTrack.albumArt}
          alt={currentTrack.album}
          className="h-64 w-64 rounded-lg shadow-lg"
        />
      )}

      {/* Track Info */}
      <div className="text-center">
        <h2 className="text-2xl font-bold text-black dark:text-white">
          {currentTrack.name}
        </h2>
        <p className="mt-2 text-lg text-zinc-600 dark:text-zinc-400">
          {currentTrack.artist}
        </p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-500">
          {currentTrack.album}
        </p>
      </div>

      {/* Playback Controls */}
      <button
        onClick={togglePlayPause}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500 text-white transition-colors hover:bg-green-600"
      >
        {isPlaying ? (
          <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
    </div>
  );
}
