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

  const emotionCountsRef = useRef<Record<string, number>>({});
  const endHandledForTrackRef = useRef<string>("");
  const hasStartedPlaybackRef = useRef(false);


  useImperativeHandle(ref, () => ({
    pause: () => {
      if (player && isPlaying) {
        void player.pause();
      }
    }
  }));


  const getDominantEmotion = useCallback(() => {
    const counts = emotionCountsRef.current;
    const entries = Object.entries(counts);
    if (entries.length === 0) {
      return emotion.toLowerCase();
    }

    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }, [emotion]);

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

  const playTrackForEmotionSummary = useCallback(async (dominantEmotion: string) => {
    if (!deviceId || !accessToken) return;

    const searchQuery = encodeURIComponent(buildTrackQuery(dominantEmotion));

    const searchResponse = await fetch(
      `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=20&market=US`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!searchResponse.ok) {
      return;
    }

    const searchData = await searchResponse.json();
    const tracks: SpotifyTrack[] = (searchData.tracks?.items || []).filter(
      (track: SpotifyTrack) => track?.uri && !track?.is_local
    );

    if (tracks.length === 0) return;

    const chosenTrack = tracks[Math.floor(Math.random() * tracks.length)];

    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: [chosenTrack.uri],
      }),
    });

    emotionCountsRef.current = {};
  }, [accessToken, buildTrackQuery, deviceId]);

  // Initialize Spotify Web Playback SDK
  useEffect(() => {
    if (!accessToken) return;

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    let spotifyPlayer: SpotifyPlayer | null = null;

    window.onSpotifyWebPlaybackSDKReady = () => {
      spotifyPlayer = new window.Spotify.Player({
        name: "NeuroVibe Player",
        getOAuthToken: (cb: (token: string) => void) => cb(accessToken),
        volume: 0.5,
      });

      spotifyPlayer.addListener("ready", ({ device_id }: { device_id: string }) => {
        setDeviceId(device_id);
      });

      spotifyPlayer.addListener("player_state_changed", (state: unknown) => {
        const typedState = state as SpotifyPlayerState | null;
        if (!typedState) return;

        const track = typedState.track_window.current_track;
        const trackUri = track.uri;

        setCurrentTrack({
          name: track.name,
          artist: track.artists.map((a: SpotifyArtist) => a.name).join(", "),
          album: track.album.name,
          albumArt: track.album.images[0]?.url || "",
          uri: track.uri,
          durationMs: typedState.duration,
        });

        setIsPlaying(!typedState.paused);

        const hasEnded = typedState.duration > 0 && typedState.position >= typedState.duration - 300;
        if (hasEnded && endHandledForTrackRef.current !== trackUri) {
          endHandledForTrackRef.current = trackUri;
          const dominantEmotion = getDominantEmotion();
          void playTrackForEmotionSummary(dominantEmotion);
        }
      });

      spotifyPlayer.connect().then((success: boolean) => {
        if (!success) {
          setIsAuthenticated(false);
        }
      });

      setPlayer(spotifyPlayer as SpotifyPlayer);
    };

    return () => {
      if (spotifyPlayer) {
        spotifyPlayer.disconnect();
      }
    };
  }, [accessToken, getDominantEmotion, playTrackForEmotionSummary]);

  useEffect(() => {
    if (!deviceId || !accessToken || hasStartedPlaybackRef.current) return;
    hasStartedPlaybackRef.current = true;
    void playTrackForEmotionSummary(emotion.toLowerCase());
  }, [accessToken, deviceId, emotion, playTrackForEmotionSummary]);

  // Collect emotion samples while a track is playing; evaluated at song end.
  useEffect(() => {
    if (!currentTrack?.uri || !isPlaying) return;
    const normalizedEmotion = emotion.toLowerCase();
    emotionCountsRef.current[normalizedEmotion] = (emotionCountsRef.current[normalizedEmotion] || 0) + 1;
  }, [emotion, currentTrack?.uri, isPlaying]);

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
