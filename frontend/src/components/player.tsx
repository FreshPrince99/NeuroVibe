"use client";

import { useEffect, useState, forwardRef, useImperativeHandle, useRef, useCallback } from "react";

interface Track {
  name: string;
  artist: string;
  album: string;
  albumArt: string;
  uri: string;
  durationMs: number;
}

interface PlayerProps {
  emotion: string;
}

export interface PlayerRef {
  pause: () => void;
}

type SessionMode = "focus" | "relaxation" | "cognitive";

type SpotifyArtist = { name: string };
type SpotifyImage = { url: string };
type SpotifyTrack = {
  name: string;
  uri: string;
  duration_ms: number;
  is_local?: boolean;
  artists: SpotifyArtist[];
  album: { name: string; images: SpotifyImage[] };
};

type SpotifyPlayerState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: SpotifyTrack };
};

type SpotifyPlayer = {
  pause: () => Promise<void>;
  togglePlay: () => Promise<void>;
  disconnect: () => void;
  connect: () => Promise<boolean>;
  addListener: (event: string, callback: (state: unknown) => void) => boolean;
};

const stressEmotions = new Set(["stressed", "sad", "anxious", "angry", "tired"]);
const positiveEmotions = new Set(["relaxed", "calm", "content", "happy", "neutral"]);

const Player = forwardRef<PlayerRef, PlayerProps>(({ emotion }, ref) => {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [player, setPlayer] = useState<SpotifyPlayer | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [accessToken] = useState<string>(() => (typeof window !== "undefined" ? localStorage.getItem("spotify_access_token") || "" : ""));
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(typeof window !== "undefined" ? localStorage.getItem("spotify_access_token") : ""));
  const [mode] = useState<SessionMode>(() => {
    if (typeof window === "undefined") return "focus";
    const storedMode = localStorage.getItem("neurovibe_mode");
    return storedMode === "relaxation" ? "relaxation" : "focus";
  });
  const [focusEnergy] = useState<"energetic" | "calm">(() => {
    if (typeof window === "undefined") return "calm";
    const stored = localStorage.getItem("neurovibe_focus_energy");
    return stored === "energetic" ? "energetic" : "calm";
  });
  const [preferredGenres] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const stored = localStorage.getItem("neurovibe_music_genres");
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  // Always points to the freshest access token; updated by the refresh timer.
  // Using a ref (instead of state) avoids re-initialising the SDK on every refresh.
  const accessTokenRef = useRef<string>(accessToken);
  // Refs for emotion and deviceId so callbacks stay stable and never trigger
  // the SDK useEffect to re-run (which would call disconnect).
  const emotionRef = useRef<string>(emotion);
  const deviceIdRef = useRef<string>("");

  // Keep refs in sync on every render without causing re-renders.
  emotionRef.current = emotion;

  const emotionCountsRef = useRef<Record<string, number>>({});
  const endHandledForTrackRef = useRef<string>("");
  const activeTrackUriRef = useRef<string>("");
  const trackEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasStartedPlaybackRef = useRef(false);

  const [positionMs, setPositionMs] = useState(0);
  const positionMsRef = useRef(0);


  useImperativeHandle(ref, () => ({
    pause: () => {
      if (player && isPlaying) {
        void player.pause();
      }
    }
  }));


  // Stable — reads emotion from ref, never needs to change.
  const getDominantEmotion = useCallback(() => {
    const counts = emotionCountsRef.current;
    const entries = Object.entries(counts);
    if (entries.length === 0) return emotionRef.current.toLowerCase();
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }, []); // no deps — uses refs only

  const buildTrackQuery = useCallback((dominantEmotion: string) => {
    const genresText = preferredGenres.length > 0 ? preferredGenres.join(" ") : "instrumental";
    const normalizedEmotion = dominantEmotion.toLowerCase();

    if (mode === "relaxation") {
      if (stressEmotions.has(normalizedEmotion)) {
        return `calming uplifting relaxation ${genresText}`;
      }
      if (positiveEmotions.has(normalizedEmotion)) {
        return `gentle relaxing ${genresText}`;
      }
      return `peaceful anti stress ${genresText}`;
    }

    // Focus mode logic
    if (stressEmotions.has(normalizedEmotion)) {
      return `calm focus ${genresText}`;
    }

    if (focusEnergy === "energetic") {
      return `energetic deep focus ${genresText}`;
    }

    return `calm deep focus ${genresText}`;
  }, [focusEnergy, mode, preferredGenres]);

  const playTrackForEmotionSummary = useCallback(async (dominantEmotion: string): Promise<boolean> => {
    const token = accessTokenRef.current;
    const device = deviceIdRef.current;
    if (!device || !token) return false;

    const query = buildTrackQuery(dominantEmotion);
    console.log(`🎵 Searching Spotify | mode=${mode} energy=${focusEnergy} genres=[${preferredGenres.join(", ")}] query="${query}"`);
    const searchQuery = encodeURIComponent(query);

    const searchResponse = await fetch(
      `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=20&market=US`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!searchResponse.ok) {
      console.warn("Spotify search failed:", searchResponse.status);
      return false;
    }

    const searchData = await searchResponse.json();
    const tracks: SpotifyTrack[] = (searchData.tracks?.items || []).filter(
      (track: SpotifyTrack) => track?.uri && !track?.is_local
    );

    if (tracks.length === 0) return false;

    const chosenTrack = tracks[Math.floor(Math.random() * tracks.length)];

    const playResponse = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${device}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: [chosenTrack.uri] }),
    });

    if (!playResponse.ok) {
      console.warn("Spotify play failed:", playResponse.status);
      return false;
    }

    emotionCountsRef.current = {};
    return true;
  // deviceId and accessToken are read from refs \u2014 intentionally excluded from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildTrackQuery, focusEnergy, mode, preferredGenres]);

  const queueNextTrackFromSummary = useCallback(async (trackUri: string) => {
    if (!trackUri || endHandledForTrackRef.current === trackUri) return;

    const dominantEmotion = getDominantEmotion();
    const started = await playTrackForEmotionSummary(dominantEmotion);
    if (started) {
      endHandledForTrackRef.current = trackUri;
    }
  }, [getDominantEmotion, playTrackForEmotionSummary]);

  // Proactively refresh the Spotify token ~5 min before it expires.
  useEffect(() => {
    const doRefresh = async () => {
      const refreshToken = localStorage.getItem("spotify_refresh_token");
      if (!refreshToken) return;
      try {
        const res = await fetch("/api/auth/spotify/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        const data = await res.json();
        if (data.access_token) {
          accessTokenRef.current = data.access_token;
          localStorage.setItem("spotify_access_token", data.access_token);
          const expiry = Date.now() + (data.expires_in ?? 3600) * 1000;
          localStorage.setItem("spotify_token_expiry", expiry.toString());
          console.log("✓ Spotify token refreshed");
        }
      } catch (e) {
        console.warn("Spotify token refresh failed:", e);
      }
    };

    // Schedule first refresh 5 min before the stored expiry, then every 55 min.
    const expiry = parseInt(localStorage.getItem("spotify_token_expiry") || "0");
    const refreshIn = Math.max(expiry - Date.now() - 5 * 60 * 1000, 30_000);
    const t = setTimeout(() => {
      void doRefresh();
    }, refreshIn);
    const interval = setInterval(() => void doRefresh(), 55 * 60 * 1000);

    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, []);

  // Initialize Spotify Web Playback SDK
  useEffect(() => {
    if (!accessToken) return;

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    let spotifyPlayer: SpotifyPlayer | null = null;

    window.onSpotifyWebPlaybackSDKReady = () => {
      const sp: SpotifyPlayer = new window.Spotify.Player({
        name: "NeuroVibe Player",
        // Always read from the ref so the SDK gets a fresh token after refresh.
        getOAuthToken: (cb: (token: string) => void) => cb(accessTokenRef.current),
        volume: 0.5,
      });
      spotifyPlayer = sp;

      sp.addListener("ready", (state: unknown) => {
        const typedState = state as { device_id: string };
        deviceIdRef.current = typedState.device_id;
        setDeviceId(typedState.device_id);
      });

      sp.addListener("player_state_changed", (state: unknown) => {
        const typedState = state as SpotifyPlayerState | null;
        if (!typedState) return;

        const track = typedState.track_window.current_track;
        const trackUri = track.uri;

        if (activeTrackUriRef.current !== trackUri) {
          activeTrackUriRef.current = trackUri;
          endHandledForTrackRef.current = "";
          if (trackEndTimerRef.current) {
            clearTimeout(trackEndTimerRef.current);
            trackEndTimerRef.current = null;
          }
        }

        setCurrentTrack({
          name: track.name,
          artist: track.artists.map((a: SpotifyArtist) => a.name).join(", "),
          album: track.album.name,
          albumArt: track.album.images[0]?.url || "",
          uri: track.uri,
          durationMs: typedState.duration,
        });

        positionMsRef.current = typedState.position;
        setPositionMs(typedState.position);
        setIsPlaying(!typedState.paused);

        const remainingMs = Math.max(typedState.duration - typedState.position, 0);

        if (!typedState.paused && typedState.duration > 0) {
          // Track is playing — (re)schedule the end-of-track callback.
          if (trackEndTimerRef.current) clearTimeout(trackEndTimerRef.current);
          trackEndTimerRef.current = setTimeout(() => {
            if (activeTrackUriRef.current !== trackUri) return;
            void queueNextTrackFromSummary(trackUri);
          }, remainingMs + 750);
        } else if (typedState.paused) {
          // Track is paused — cancel the timer so it doesn't auto-skip.
          if (trackEndTimerRef.current) {
            clearTimeout(trackEndTimerRef.current);
            trackEndTimerRef.current = null;
          }
        }

        // Only treat as ended when position genuinely reaches the end while playing.
        const hasEnded = !typedState.paused && typedState.duration > 0 &&
          typedState.position >= typedState.duration - 300;
        if (hasEnded) {
          void queueNextTrackFromSummary(trackUri);
        }
      });

      sp.connect().then((success: boolean) => {
        if (!success) {
          setIsAuthenticated(false);
        }
      });

      setPlayer(sp);
    };

    return () => {
      if (trackEndTimerRef.current) {
        clearTimeout(trackEndTimerRef.current);
        trackEndTimerRef.current = null;
      }
      if (spotifyPlayer) {
        spotifyPlayer.disconnect();
      }
    };
  // Only re-run if the access token itself changes (e.g. a full re-auth).
  // queueNextTrackFromSummary is stable and safe to include.
  // callbacks, so they must NOT be listed here or emotion changes will disconnect SDK.
  }, [accessToken, queueNextTrackFromSummary]);

  // Trigger the very first track once the device is ready. Guarded by ref so
  // changing emotion later never re-fires this.
  useEffect(() => {
    if (!deviceId || !accessToken || hasStartedPlaybackRef.current) return;
    hasStartedPlaybackRef.current = true;
    void playTrackForEmotionSummary(emotionRef.current.toLowerCase());
  // emotion intentionally omitted — emotionRef.current is read at call time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, deviceId, playTrackForEmotionSummary]);

  // Tick position forward every second while playing (SDK events are not 1-per-second).
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      positionMsRef.current += 1000;
      setPositionMs(positionMsRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [isPlaying]);

  // Collect emotion samples while a track is playing; evaluated at song end.
  useEffect(() => {
    if (!currentTrack?.uri || !isPlaying) return;
    const normalizedEmotion = emotion.toLowerCase();
    emotionCountsRef.current[normalizedEmotion] = (emotionCountsRef.current[normalizedEmotion] || 0) + 1;
  }, [emotion, currentTrack?.uri, isPlaying]);

  const formatTime = (ms: number) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  };

  const togglePlayPause = () => {
    if (player) {
      void player.togglePlay();
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
          Loading {mode === "relaxation" ? "relaxation" : "focus"} music...
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      {currentTrack.albumArt && (
        <img
          src={currentTrack.albumArt}
          alt={currentTrack.album}
          className="h-64 w-64 rounded-lg shadow-lg"
        />
      )}

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

      {/* Progress bar */}
      {currentTrack.durationMs > 0 && (
        <div className="w-full max-w-xs space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div
              className="h-full rounded-full bg-green-500"
              style={{
                width: `${Math.min((positionMs / currentTrack.durationMs) * 100, 100)}%`,
                transition: "width 1s linear",
              }}
            />
          </div>
          <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span>{formatTime(positionMs)}</span>
            <span>{formatTime(currentTrack.durationMs)}</span>
          </div>
        </div>
      )}

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
});

Player.displayName = "Player";

export default Player;
