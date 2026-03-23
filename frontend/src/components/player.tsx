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
  valence?: { valence: "POSITIVE" | "NEGATIVE" | "UNCERTAIN"; smoothed_score: number; n_windows: number } | null;
  onTrackChange?: (track: { name: string; artist: string; uri: string; genre: string; albumArt?: string } | null) => void;
}

export interface PlayerRef {
  pause: () => void;
  getCurrentTrack: () => { name: string; artist: string; uri: string; genre: string; albumArt?: string } | null;
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
type SpotifyAudioFeatures = {
  id: string;
  energy?: number;
  valence?: number;
  danceability?: number;
};
type SpotifyTrackMeta = {
  id: string;
  popularity?: number;
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
const tiredRelaxedEmotions = new Set(["relaxed", "calm", "content", "tired", "bored"]);

// ── Adaptive music constants ──────────────────────────────────────────────
// Layer 1: per-song energy adaptation
const ENERGY_STEP             = 0.08;   // shift per song
const ENERGY_MIN              = 0.15;
const ENERGY_MAX              = 0.90;
const STRESS_THRESHOLD        = 0.35;   // stressed% above this → lower energy
const TIRED_RELAXED_THRESHOLD = 0.35;   // tired/relaxed% above this → raise energy
// Layer 2: per-block genre rotation
const GENRE_BLOCK_SIZE = 5;             // evaluate affect every N songs
const GENRE_EXPLORATION_POOL = [
  "ambient", "lo-fi", "classical", "nature sounds",
  "post-rock", "acoustic", "piano", "jazz", "electronic", "cinematic",
];

const Player = forwardRef<PlayerRef, PlayerProps>(({ emotion, valence, onTrackChange }, ref) => {
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
  const emotionRef     = useRef<string>(emotion);
  const deviceIdRef    = useRef<string>("");
  const valenceRef = useRef(valence);

  // Keep refs in sync on every render without causing re-renders.
  emotionRef.current  = emotion;
  valenceRef.current  = valence;

  const emotionCountsRef = useRef<Record<string, number>>({});
  const endHandledForTrackRef = useRef<string>("");
  const activeTrackUriRef = useRef<string>("");
  const trackEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasStartedPlaybackRef = useRef(false);
  const sessionStartedRef = useRef(false);   // true after our first track plays

  // Keep a rolling history of recently played URIs so the same song is never
  // immediately re-selected. Capped at 15 entries.
  const playedUrisRef = useRef<string[]>([]);

  const [positionMs, setPositionMs] = useState(0);
  const positionMsRef = useRef(0);

  // Genre shift notification — shown briefly in the UI when genre rotates.
  const [genreShift, setGenreShift] = useState<{ from: string; to: string } | null>(null);
  const genreShiftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Layer 1: adaptive energy (updated per song) ───────────────────────
  const _baselineEnergy   = focusEnergy === "energetic" ? 0.70 : 0.40;
  const adaptiveEnergyRef = useRef<number>(_baselineEnergy);
  const baselineEnergyRef = useRef<number>(_baselineEnergy);

  // ── Layer 2: genre rotation (evaluated every GENRE_BLOCK_SIZE songs) ──
  const _firstGenre     = preferredGenres.length > 0
    ? preferredGenres[0]
    : GENRE_EXPLORATION_POOL[0];
  const currentGenreRef = useRef<string>(_firstGenre);
  const genreQueueRef   = useRef<string[]>(
    [...preferredGenres.slice(1), ...GENRE_EXPLORATION_POOL]
      .filter((g, i, arr) => g !== _firstGenre && arr.indexOf(g) === i)
  );
  const songsPlayedRef  = useRef<number>(0);
  const blockAffectRef  = useRef<number[]>([]);  // P(dislike) per song in block


  useImperativeHandle(ref, () => ({
    getCurrentTrack: () => {
      if (!currentTrack) return null;
      return { name: currentTrack.name, artist: currentTrack.artist, uri: currentTrack.uri, genre: currentGenreRef.current, albumArt: currentTrack.albumArt };
    },
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

  const buildTrackQuery = useCallback((dominantEmotion: string, energy: number, genre: string) => {
    const normalizedEmotion = dominantEmotion.toLowerCase();
    // Map continuous energy float [0,1] to search keywords
    const energyWord = energy >= 0.66 ? "upbeat energetic fast"
                     : energy >= 0.51 ? "moderate steady focused"
                     : energy >= 0.31 ? "calm relaxing slow"
                     : "ambient meditative very slow";

    if (mode === "relaxation") {
      if (stressEmotions.has(normalizedEmotion)) {
        return `calming uplifting relaxation ${energyWord} ${genre}`;
      }
      return `gentle peaceful relaxing ${energyWord} ${genre}`;
    }

    // Focus mode: when stressed always go calming regardless of adaptive energy
    if (stressEmotions.has(normalizedEmotion)) {
      return `calming soothing focus ${genre}`;
    }

    return `deep focus ${energyWord} ${genre}`;
  }, [mode]);

  const fetchAudioFeatures = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return { features: {}, meta: {} };

    // Prefer server-side client-credentials (avoids 403 from Web API on some accounts)
    try {
      const res = await fetch("/api/spotify/audio-features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        const data = await res.json();
        const feats: SpotifyAudioFeatures[] = data?.audio_features ?? [];
        const tracks: SpotifyTrackMeta[] = data?.tracks ?? [];
        const fMap: Record<string, SpotifyAudioFeatures> = {};
        const tMap: Record<string, SpotifyTrackMeta> = {};
        feats.forEach(f => { if (f?.id) fMap[f.id] = f; });
        tracks.forEach(t => { if (t?.id) tMap[t.id] = t; });
        return { features: fMap, meta: tMap };
      }
    } catch {
      // fall through to client token
    }

    const token = accessTokenRef.current;
    if (!token) return { features: {}, meta: {} };
    const res = await fetch(
      `https://api.spotify.com/v1/audio-features?ids=${ids.join(",")}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { features: {}, meta: {} };
    const data = await res.json();
    const feats: SpotifyAudioFeatures[] = data?.audio_features ?? [];
    const fMap: Record<string, SpotifyAudioFeatures> = {};
    feats.forEach(f => { if (f?.id) fMap[f.id] = f; });
    return { features: fMap, meta: {} };
  }, []);

  const scoreTrack = useCallback(
    (dominantEmotion: string, feature?: SpotifyAudioFeatures, meta?: SpotifyTrackMeta) => {
    if (!feature) return 0;
    const energy = feature.energy ?? 0.5;
    const valence = feature.valence ?? 0.5;
    const danceability = feature.danceability ?? 0.5;
    const popularity = meta?.popularity ?? 50;
    const normalizedEmotion = dominantEmotion.toLowerCase();

    let targetEnergy = adaptiveEnergyRef.current;
    if (mode === "relaxation") targetEnergy = 0.25;
    if (stressEmotions.has(normalizedEmotion)) targetEnergy = 0.20;

    const energyScore = 1 - Math.abs(energy - targetEnergy);
    const valenceScore = stressEmotions.has(normalizedEmotion) || mode === "relaxation"
      ? valence
      : valence * 0.3;
    const danceScore = mode === "relaxation" ? (1 - danceability) : danceability;
    const popScore = Math.min(Math.max(popularity / 100, 0), 1);
    return energyScore + 0.3 * valenceScore + 0.15 * danceScore + 0.05 * popScore;
  }, [mode]);

  // Disable Spotify's repeat mode on the active device so tracks don't loop.
  const disableRepeat = useCallback(async (device: string) => {
    const token = accessTokenRef.current;
    if (!token || !device) return;
    try {
      await fetch(
        `https://api.spotify.com/v1/me/player/repeat?state=off&device_id=${device}`,
        { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
      );
    } catch { /* non-fatal */ }
  }, []);

  const playTrackForEmotionSummary = useCallback(async (dominantEmotion: string): Promise<boolean> => {
    const token = accessTokenRef.current;
    const device = deviceIdRef.current;
    if (!device || !token) return false;

    const query = buildTrackQuery(
      dominantEmotion,
      adaptiveEnergyRef.current,
      currentGenreRef.current,
    );
    // Randomise the search offset so we don't always get the same 20 results.
    const offset = Math.floor(Math.random() * 3) * 20; // 0, 20, or 40
    console.log(`Searching Spotify | mode=${mode} energy=${adaptiveEnergyRef.current.toFixed(2)} genre="${currentGenreRef.current}" offset=${offset} query="${query}"`);
    const searchQuery = encodeURIComponent(query);

    const searchResponse = await fetch(
      `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=50&offset=${offset}&market=US`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!searchResponse.ok) {
      console.warn("Spotify search failed:", searchResponse.status);
      return false;
    }

    const searchData = await searchResponse.json();
    // Filter out: local tracks AND recently played URIs so we never repeat.
    const recentlyPlayed = new Set(playedUrisRef.current);
    const tracks: SpotifyTrack[] = (searchData.tracks?.items || []).filter(
      (track: SpotifyTrack) =>
        track?.uri && !track?.is_local && !recentlyPlayed.has(track.uri)
    );

    // If everything is filtered out (e.g. tiny genre pool), relax the history filter
    // and just exclude the single currently playing track.
    const fallbackTracks: SpotifyTrack[] = tracks.length === 0
      ? (searchData.tracks?.items || []).filter(
          (track: SpotifyTrack) =>
            track?.uri && !track?.is_local && track.uri !== activeTrackUriRef.current
        )
      : tracks;

    if (fallbackTracks.length === 0) {
      console.warn("[Player] No new tracks found — clearing history and retrying.");
      playedUrisRef.current = [];
      return false;
    }

    const ids = fallbackTracks
      .map(t => t.uri?.split(":").pop())
      .filter((id): id is string => Boolean(id))
      .slice(0, 50);

    const { features: featuresMap, meta: metaMap } = await fetchAudioFeatures(ids);
    const scored = fallbackTracks.map(t => {
      const id = t.uri?.split(":").pop() ?? "";
      const score = scoreTrack(dominantEmotion, featuresMap[id], metaMap[id]);
      return { track: t, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Pick randomly from the top-5 candidates to avoid always playing the same song.
    const topN = scored.slice(0, Math.min(5, scored.length));
    const chosenTrack = topN[Math.floor(Math.random() * topN.length)]?.track
      ?? fallbackTracks[Math.floor(Math.random() * fallbackTracks.length)];

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

    // Record this URI in the history (cap at 15) so it won't be chosen next time.
    playedUrisRef.current.push(chosenTrack.uri);
    if (playedUrisRef.current.length > 15) playedUrisRef.current.shift();
    sessionStartedRef.current = true;
    emotionCountsRef.current = {};
    return true;
  // deviceId, accessToken, adaptive refs read via refs — intentionally excluded from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildTrackQuery, mode, scoreTrack, fetchAudioFeatures]);

  const queueNextTrackFromSummary = useCallback(async (trackUri: string) => {
    if (!trackUri || endHandledForTrackRef.current === trackUri) return;
    endHandledForTrackRef.current = trackUri;

    // ── Layer 1: adjust adaptive energy from this song's emotion proportions ──
    const counts   = emotionCountsRef.current;
    const total    = Object.values(counts).reduce((s, n) => s + n, 0);
    const prevEnergy = adaptiveEnergyRef.current;
    let energyChangeReason = "drift toward baseline";

    if (total > 0) {
      const tiredRelaxedCount = Object.entries(counts)
        .filter(([k]) => tiredRelaxedEmotions.has(k))
        .reduce((s, [, n]) => s + n, 0);
      const stressedCount = Object.entries(counts)
        .filter(([k]) => k === "stressed" || k === "anxious" || k === "angry")
        .reduce((s, [, n]) => s + n, 0);

      const tiredRelaxedRatio = tiredRelaxedCount / total;
      const stressedRatio     = stressedCount     / total;

      let energy = adaptiveEnergyRef.current;
      if (stressedRatio > STRESS_THRESHOLD) {
        energy -= ENERGY_STEP;
        energyChangeReason = `stress detected (${(stressedRatio * 100).toFixed(0)}%)`;
        console.log(`⚡ Layer 1: stressed=${(stressedRatio * 100).toFixed(0)}% → lower energy`);
      } else if (tiredRelaxedRatio > TIRED_RELAXED_THRESHOLD) {
        energy += ENERGY_STEP;
        energyChangeReason = `tired/relaxed detected (${(tiredRelaxedRatio * 100).toFixed(0)}%)`;
        console.log(`⚡ Layer 1: tired/relaxed=${(tiredRelaxedRatio * 100).toFixed(0)}% → raise energy`);
      } else {
        // Gently nudge back toward the user's baseline preference
        energy += (baselineEnergyRef.current - energy) * 0.25;
      }
      adaptiveEnergyRef.current = Math.min(ENERGY_MAX, Math.max(ENERGY_MIN, energy));
      console.log(`⚡ Layer 1: adaptive energy → ${adaptiveEnergyRef.current.toFixed(2)}`);
    }

    // ── Layer 2: track genre affect, rotate every GENRE_BLOCK_SIZE songs ──
    // Use NeuroSense valence: POSITIVE → 0.0 (like), NEGATIVE → 1.0 (dislike),
    // UNCERTAIN → skip (don't contribute to block score).
    // A full-UNCERTAIN block leaves blockAffectRef empty → avgScore stays 0 → keep genre.
    const prevGenre = currentGenreRef.current;
    const latestV   = valenceRef.current;
    if (latestV != null && latestV.valence !== "UNCERTAIN") {
      const dislikeScore = latestV.valence === "NEGATIVE" ? 1.0 : 0.0;
      blockAffectRef.current.push(dislikeScore);
      console.log(
        `[Layer 2] song ${songsPlayedRef.current + 1}: valence=${latestV.valence}` +
        ` smooth=${latestV.smoothed_score.toFixed(3)} → score=${dislikeScore}` +
        ` (block ${blockAffectRef.current.length}/${GENRE_BLOCK_SIZE})`
      );
    } else {
      console.log(
        `[Layer 2] song ${songsPlayedRef.current + 1}: ` +
        `${latestV == null ? "no valence signal" : "UNCERTAIN"} — skipping`
      );
    }
    songsPlayedRef.current += 1;

    // Snapshot block state before evaluation may clear it
    const blockScoresSnapshot = [...blockAffectRef.current];
    let blockComplete    = false;
    let blockAvgScore    = 0;
    let genreRotated     = false;

    if (
      songsPlayedRef.current % GENRE_BLOCK_SIZE === 0 &&
      blockAffectRef.current.length > 0
    ) {
      blockAvgScore =
        blockAffectRef.current.reduce((s, p) => s + p, 0) /
        blockAffectRef.current.length;
      blockAffectRef.current = [];
      blockComplete = true;

      console.log(
        `[Layer 2] block complete (${songsPlayedRef.current} songs):` +
        ` avgDislikeScore=${blockAvgScore.toFixed(2)} genre="${currentGenreRef.current}"`
      );

      if (blockAvgScore >= 0.5) {
        // Majority of block was disliked → rotate genre
        const next = genreQueueRef.current.shift();
        if (next) {
          const prev = currentGenreRef.current;
          genreQueueRef.current.push(prev); // cycle old genre to back of queue
          currentGenreRef.current = next;
          genreRotated = true;
          console.log(
            `[Layer 2] GENRE SHIFT: "${prev}" → "${next}"` +
            ` (avgDislikeScore=${blockAvgScore.toFixed(2)}, ${Math.round(blockAvgScore * GENRE_BLOCK_SIZE)}/${GENRE_BLOCK_SIZE} dislikes)`
          );
          // Show notification in the UI for 5 seconds
          if (genreShiftTimerRef.current) clearTimeout(genreShiftTimerRef.current);
          setGenreShift({ from: prev, to: next });
          genreShiftTimerRef.current = setTimeout(() => setGenreShift(null), 5000);
        } else {
          console.log(`[Layer 2] genre queue exhausted — staying on "${currentGenreRef.current}"`);
        }
      } else {
        console.log(
          `[Layer 2] keeping genre "${currentGenreRef.current}"` +
          ` (avgDislikeScore=${blockAvgScore.toFixed(2)}, positive affect)`
        );
      }
    }

    const dominantEmotion = getDominantEmotion();

    // ── Fire song-switch report to backend terminal (fire-and-forget) ────────
    fetch("http://localhost:5000/song_switch", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song_number:          songsPlayedRef.current,
        mode,
        dominant_emotion:     dominantEmotion,
        emotion_breakdown:    { ...counts },
        emotion_total:        total,
        prev_energy:          parseFloat(prevEnergy.toFixed(3)),
        new_energy:           parseFloat(adaptiveEnergyRef.current.toFixed(3)),
        energy_change_reason: energyChangeReason,
        valence_label:        latestV?.valence ?? "N/A",
        valence_score:        latestV?.smoothed_score ?? null,
        valence_windows:      latestV?.n_windows ?? 0,
        block_scores:         blockScoresSnapshot,
        block_size:           GENRE_BLOCK_SIZE,
        block_complete:       blockComplete,
        block_avg_score:      blockComplete ? parseFloat(blockAvgScore.toFixed(3)) : null,
        genre_rotated:        genreRotated,
        prev_genre:           prevGenre,
        current_genre:        currentGenreRef.current,
      }),
    }).catch(() => { /* non-fatal — backend may not be ready */ });

    const started = await playTrackForEmotionSummary(dominantEmotion);
    if (!started) {
      console.warn("[Player] Failed to start next track — will retry on next emotion update.");
      setTimeout(() => {
        if (endHandledForTrackRef.current === trackUri) {
          endHandledForTrackRef.current = "";
        }
      }, 15_000);
    }
  }, [getDominantEmotion, playTrackForEmotionSummary, mode]);

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

    let spotifyPlayer: SpotifyPlayer | null = null;

    const initializeSpotifyPlayer = () => {
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
        // Ensure Spotify never loops a track on its own.
        void disableRepeat(typedState.device_id);
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
          if (sessionStartedRef.current) {
            onTrackChange?.({ name: track.name, artist: track.artists.map((a: SpotifyArtist) => a.name).join(", "), uri: track.uri, genre: currentGenreRef.current, albumArt: track.album.images[0]?.url });
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
        }
        // IMPORTANT: Do NOT cancel the timer when paused.
        // The Spotify SDK fires player_state_changed with paused=true, position=0
        // when a track ends naturally (it loops back to start). Cancelling the timer
        // here would prevent the next song from ever being queued.
        // The timer is self-guarded: if (activeTrackUriRef.current !== trackUri) return.

        // Detect end via position proximity — catches end slightly earlier than the timer.
        // Also catches the Spotify SDK's "loop back to 0" behaviour: when a track ends
        // naturally the SDK fires paused=true, position=0 — that is NOT a real pause,
        // the track is over.
        const atEnd = typedState.duration > 0 &&
          typedState.position >= typedState.duration - 1500;
        const loopedToStart = typedState.paused &&
          typedState.position === 0 &&
          typedState.duration > 0;
        if (atEnd || loopedToStart) {
          void queueNextTrackFromSummary(trackUri);
        }
      });

      sp.connect().then((success: boolean) => {
        if (!success) {
          setIsAuthenticated(false);
        }
      });

      setPlayer(sp);
    }; // end initializeSpotifyPlayer

    // If the SDK script is already loaded from a previous session, call directly.
    // Otherwise register the callback and inject the script (first load only).
    if ((window as any).Spotify?.Player) {
      initializeSpotifyPlayer();
    } else {
      window.onSpotifyWebPlaybackSDKReady = initializeSpotifyPlayer;
      if (!document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]')) {
        const script = document.createElement("script");
        script.src = "https://sdk.scdn.co/spotify-player.js";
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      // Reset playback guards so the next SDK setup (StrictMode re-mount or new
      // session) can kick off the first track fresh.
      hasStartedPlaybackRef.current = false;
      sessionStartedRef.current     = false;
      activeTrackUriRef.current     = "";
      endHandledForTrackRef.current = "";
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
  // changing emotion later never re-fires this. If the initial play fails (e.g.
  // Spotify not ready yet) the flag is reset so the next deviceId change retries.
  useEffect(() => {
    if (!deviceId || !accessToken || hasStartedPlaybackRef.current) return;
    hasStartedPlaybackRef.current = true;
    void playTrackForEmotionSummary(emotionRef.current.toLowerCase()).then(success => {
      if (!success) {
        // Allow retry when the SDK fires deviceId again after reconnect.
        hasStartedPlaybackRef.current = false;
      }
    });
  // emotion intentionally omitted — emotionRef.current is read at call time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, deviceId, playTrackForEmotionSummary]);

  // Tick position forward every second while playing (SDK events are not 1-per-second).
  // Also acts as a safety net: if the Spotify SDK state event never fires at track end,
  // the ticker catches it and queues the next track.
  useEffect(() => {
    if (!isPlaying) return;
    const durMs = currentTrack?.durationMs ?? 0;
    const id = setInterval(() => {
      positionMsRef.current += 1000;
      setPositionMs(positionMsRef.current);
      // Safety fallback: detect end of track from local clock if SDK event is late.
      if (durMs > 0 && positionMsRef.current >= durMs - 800 && activeTrackUriRef.current) {
        void queueNextTrackFromSummary(activeTrackUriRef.current);
      }
    }, 1000);
    return () => clearInterval(id);
  // currentTrack?.durationMs ensures the interval restarts with the correct duration
  // when the track changes. queueNextTrackFromSummary is stable (useCallback).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentTrack?.durationMs, queueNextTrackFromSummary]);

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
      {/* Genre shift toast notification */}
      {genreShift && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl bg-zinc-800/90 px-4 py-2.5 text-sm text-white shadow-lg backdrop-blur-sm border border-zinc-600 animate-fade-in">
          <span className="text-zinc-400">Genre shift:</span>
          <span className="font-medium text-zinc-300 line-through">{genreShift.from}</span>
          <span className="text-zinc-500">→</span>
          <span className="font-semibold text-green-400">{genreShift.to}</span>
        </div>
      )}

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
