'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MuseClient, zipSamples } from 'muse-js';

// ─────────────────────────────────────────────────────────────────────────────
// Types & constants
// ─────────────────────────────────────────────────────────────────────────────

interface EEGSample {
  tp9: number;
  af7: number;
  af8: number;
  tp10: number;
}

type Phase =
  | 'instructions'
  | 'connecting'
  | 'baseline'
  | 'song_intro'
  | 'song_playing'
  | 'song_vote'
  | 'saving'
  | 'done'
  | 'error';

const BASELINE_SECONDS = 150; // 2.5 minutes
const SONG_SECONDS     = 30;  // 30-second recording per song
const WIN_SIZE         = 1024; // samples per window (4 s @ 256 Hz)
const MIN_BASE_WINDOWS = 5;    // minimum usable baseline windows

// ─────────────────────────────────────────────────────────────────────────────
// Song pool — keyed by the genre labels used in the music survey (SetupGuide)
// ─────────────────────────────────────────────────────────────────────────────

interface Song {
  title: string;
  artist: string;
  trackId: string;
  emoji: string;
  mood: string;
  energy: 'calm' | 'energetic';
}

const SONG_POOL: Record<string, Song[]> = {
  'Classical': [
    { title: 'Gymnopédie No. 1',          artist: 'Erik Satie',           trackId: '5NGaHiM1GN0FNxKCpGc64J', emoji: '🎹', mood: 'Calm & Reflective',       energy: 'calm' },
    { title: 'Experience',                artist: 'Ludovico Einaudi',      trackId: '4YJzERHbFBFUbiGWJV7R1g', emoji: '✨', mood: 'Peaceful & Emotional',   energy: 'calm' },
    { title: 'Clair de Lune',             artist: 'Debussy',               trackId: '4xQQyoFqNMSUFodgGYfFoE', emoji: '🌙', mood: 'Dreamy & Introspective',  energy: 'calm' },
    { title: 'Divenire',                  artist: 'Ludovico Einaudi',      trackId: '7MhNCIIIfgHnA8LtHD9K1A', emoji: '🎵', mood: 'Building & Emotive',      energy: 'energetic' },
    { title: 'Time',                      artist: 'Hans Zimmer',           trackId: '6ZFbXIJkuI1dVNWvzJzown', emoji: '⏳', mood: 'Epic & Soaring',           energy: 'energetic' },
    { title: 'Spring (The Four Seasons)', artist: 'Vivaldi',               trackId: '0CDMhI5jAWQ9Kgom3bXolh', emoji: '🌸', mood: 'Bright & Lively',          energy: 'energetic' },
  ],
  'Jazz': [
    { title: 'Blue in Green',             artist: 'Miles Davis',           trackId: '3MVAHqRlYVWVRjBpFVdKm1', emoji: '🌀', mood: 'Melancholic & Deep',      energy: 'calm' },
    { title: 'Fly Me to the Moon',        artist: 'Frank Sinatra',         trackId: '50c89WZAMPYHGoRJJz3tIz', emoji: '🌕', mood: 'Warm & Nostalgic',         energy: 'calm' },
    { title: 'Take Five',                 artist: 'Dave Brubeck Quartet',  trackId: '1YQWosTIljIvxAgHWTp7KP', emoji: '🎷', mood: 'Cool & Swinging',          energy: 'energetic' },
    { title: "So What",                   artist: 'Miles Davis',           trackId: '7Eu1txygG6TaGMCMHwvSAE', emoji: '🎺', mood: 'Laid-back & Modal',        energy: 'energetic' },
    { title: 'Autumn Leaves',             artist: 'Bill Evans',            trackId: '4gLCiQKSr0C2IH2xYSNLpP', emoji: '🍂', mood: 'Tender & Reflective',      energy: 'calm' },
  ],
  'Lo-fi': [
    { title: 'snowfall',                  artist: 'Øneheart & reidenshi',  trackId: '4vkKHBNYJItFYkVYZJAOWy', emoji: '❄️', mood: 'Chill & Atmospheric',     energy: 'calm' },
    { title: 'affection',                 artist: 'wakey',                 trackId: '5wm5JjQHFCNpH1rAuNX4gQ', emoji: '💙', mood: 'Gentle & Dreamy',          energy: 'calm' },
    { title: 'Coffee and Rain',           artist: 'Jinsang',               trackId: '5FJBVfXQGY6zcmEXBpWNbs', emoji: '☕', mood: 'Cozy & Relaxed',           energy: 'calm' },
    { title: 'City of Stars',             artist: 'Ryan Gosling',          trackId: '0TDLuuLlV54CkRRUOahJb4', emoji: '🌃', mood: 'Upbeat & Nostalgic',       energy: 'energetic' },
  ],
  'Ambient': [
    { title: 'Weightless',                artist: 'Marconi Union',         trackId: '3y7Ky0sTsLG3aMbUuqGDHq', emoji: '🌊', mood: 'Deeply Relaxing',          energy: 'calm' },
    { title: 'Intro',                     artist: 'The xx',                trackId: '2usRSRGkSqtTCL9JTDBlgf', emoji: '🌌', mood: 'Atmospheric & Sparse',     energy: 'calm' },
    { title: 'On the Nature of Daylight', artist: 'Max Richter',           trackId: '1Dj5GmdGE5F0HLbNjVCzQb', emoji: '🌅', mood: 'Bittersweet & Cinematic',  energy: 'calm' },
    { title: 'Arrival of the Birds',      artist: 'The Cinematic Orchestra', trackId: '6JGgCVBJrUJoGzLhUYHIK5', emoji: '🌤️', mood: 'Rising & Hopeful',        energy: 'energetic' },
  ],
  'Instrumental': [
    { title: 'River Flows in You',        artist: 'Yiruma',                trackId: '3qnDJNJP4yDXEOsZYH5hyl', emoji: '💧', mood: 'Gentle & Flowing',          energy: 'calm' },
    { title: 'Clair de Lune',             artist: 'Debussy',               trackId: '4xQQyoFqNMSUFodgGYfFoE', emoji: '🌙', mood: 'Dreamy & Introspective',   energy: 'calm' },
    { title: 'Time',                      artist: 'Hans Zimmer',           trackId: '6ZFbXIJkuI1dVNWvzJzown', emoji: '⏳', mood: 'Epic & Hopeful',            energy: 'energetic' },
    { title: 'Divenire',                  artist: 'Ludovico Einaudi',      trackId: '7MhNCIIIfgHnA8LtHD9K1A', emoji: '🎵', mood: 'Building & Emotive',       energy: 'energetic' },
    { title: 'Experience',                artist: 'Ludovico Einaudi',      trackId: '4YJzERHbFBFUbiGWJV7R1g', emoji: '✨', mood: 'Peaceful & Emotional',   energy: 'calm' },
  ],
  'Electronic': [
    { title: 'Porcelain',                 artist: 'Moby',                  trackId: '36RsWFpFiExFg3GmXMr5sU', emoji: '🏙️', mood: 'Melancholic & Electronic', energy: 'calm' },
    { title: 'Sleep',                     artist: 'Bonobo',                trackId: '6hOGDHFd7ILQYhHVzIBcU8', emoji: '🌃', mood: 'Smooth & Nocturnal',        energy: 'calm' },
    { title: 'Teardrop',                  artist: 'Massive Attack',        trackId: '5sGV9TJIPSQiYlvQY5y3cD', emoji: '💎', mood: 'Dark & Hypnotic',           energy: 'energetic' },
    { title: 'Strobe',                    artist: 'deadmau5',              trackId: '5qlRLFGRxOVCFaBaWFYVhM', emoji: '⚡', mood: 'Building & Transcendent',  energy: 'energetic' },
    { title: 'Intro',                     artist: 'The xx',                trackId: '2usRSRGkSqtTCL9JTDBlgf', emoji: '🌌', mood: 'Atmospheric & Sparse',     energy: 'calm' },
  ],
  'Soft pop': [
    { title: 'Come Away with Me',         artist: 'Norah Jones',           trackId: '5RCPsfzmEpTXMauTx0B9Y9', emoji: '🌻', mood: 'Warm & Intimate',           energy: 'calm' },
    { title: 'Skinny Love',               artist: 'Bon Iver',              trackId: '3mANfbSnhezHqMqCVVbX7Y', emoji: '🍂', mood: 'Raw & Tender',              energy: 'calm' },
    { title: 'The Scientist',             artist: 'Coldplay',              trackId: '75JFxkI2RXiU7L9VXzMkle', emoji: '🔬', mood: 'Reflective & Bittersweet',  energy: 'calm' },
    { title: 'Viva la Vida',              artist: 'Coldplay',              trackId: '1mea3bSkSGXuIRvnydlB5b', emoji: '👑', mood: 'Triumphant & Sweeping',    energy: 'energetic' },
    { title: 'Dog Days Are Over',         artist: 'Florence + The Machine', trackId: '1kqYkKMnMZteHMJ3rN3nek', emoji: '🌞', mood: 'Joyful & Soaring',         energy: 'energetic' },
  ],
  'Nature sounds': [
    { title: 'Watermark',                 artist: 'Enya',                  trackId: '0GGVgDOzLBrtnMlVJmf9kJ', emoji: '🌿', mood: 'Flowing & Ethereal',        energy: 'calm' },
    { title: 'Gymnopédie No. 1',          artist: 'Erik Satie',            trackId: '5NGaHiM1GN0FNxKCpGc64J', emoji: '🌍', mood: 'Organic & Serene',          energy: 'calm' },
    { title: 'Into The Wild',             artist: 'LP',                    trackId: '0oPC7kKjhA2giFiOtXlFek', emoji: '🌲', mood: 'Free & Expansive',           energy: 'energetic' },
    { title: 'Only Time',                 artist: 'Enya',                  trackId: '6oGnzgBFmOGYNNnpXgp4Xk', emoji: '🌌', mood: 'Timeless & Soothing',       energy: 'calm' },
  ],
};

// Default fallback songs (varied mood, used when no genre matches)
const DEFAULT_SONGS: Song[] = [
  { title: 'Weightless',       artist: 'Marconi Union',   trackId: '3y7Ky0sTsLG3aMbUuqGDHq', emoji: '🌊', mood: 'Deeply Relaxing',  energy: 'calm' },
  { title: 'Time',             artist: 'Hans Zimmer',     trackId: '6ZFbXIJkuI1dVNWvzJzown', emoji: '⏳', mood: 'Epic & Hopeful',   energy: 'energetic' },
  { title: 'Come Away with Me', artist: 'Norah Jones',    trackId: '5RCPsfzmEpTXMauTx0B9Y9', emoji: '🌻', mood: 'Warm & Intimate',   energy: 'calm' },
];

/** Pick 3 unique songs from the user's preferred genres, sorted by energy preference. */
function pickSongs(): Song[] {
  try {
    const stored  = localStorage.getItem('neurovibe_music_genres');
    const energy  = (localStorage.getItem('neurovibe_focus_energy') ?? 'calm') as 'calm' | 'energetic';
    const genres: string[] = stored ? JSON.parse(stored) : [];

    // Gather candidates from all matching genres
    const candidates: Song[] = [];
    for (const genre of genres) {
      const pool = SONG_POOL[genre] ?? [];
      candidates.push(...pool);
    }

    // Sort so preferred-energy songs come first, shuffle within each energy tier
    const preferred   = candidates.filter(s => s.energy === energy).sort(() => Math.random() - 0.5);
    const fallbackEnergy = candidates.filter(s => s.energy !== energy).sort(() => Math.random() - 0.5);
    const sorted = [...preferred, ...fallbackEnergy];

    // De-duplicate by trackId and take first 3
    const seen = new Set<string>();
    const picked: Song[] = [];
    for (const s of sorted) {
      if (!seen.has(s.trackId) && picked.length < 3) {
        seen.add(s.trackId);
        picked.push(s);
      }
    }

    // Pad with defaults if fewer than 3 candidates
    for (const s of DEFAULT_SONGS) {
      if (picked.length >= 3) break;
      if (!seen.has(s.trackId)) {
        seen.add(s.trackId);
        picked.push(s);
      }
    }

    return picked;
  } catch {
    return DEFAULT_SONGS;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Split a flat EEG sample list into non-overlapping windows of WIN_SIZE. */
function splitIntoWindows(samples: EEGSample[]): EEGSample[][] {
  const windows: EEGSample[][] = [];
  const n = samples.length;
  for (let start = 0; start + WIN_SIZE <= n; start += WIN_SIZE) {
    windows.push(samples.slice(start, start + WIN_SIZE));
  }
  return windows;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spotify search helper — resolves a real track ID from the stored access token
// ─────────────────────────────────────────────────────────────────────────────

async function resolveSpotifyTrackId(title: string, artist: string): Promise<string | null> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('spotify_access_token') : null;
    if (!token) return null;
    const q = encodeURIComponent(`track:${title} artist:${artist}`);
    const res = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1&market=US`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const id = data?.tracks?.items?.[0]?.id ?? null;
    return id;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onComplete: () => void;
}

export default function CalibrationStep({ onComplete }: Props) {
  const [phase, setPhase]               = useState<Phase>('instructions');
  const [songIndex, setSongIndex]       = useState(0);
  const [timer, setTimer]               = useState(0);
  const [isMuseConnected, setIsMuse]    = useState(false);
  const [statusMsg, setStatusMsg]       = useState('');
  const [errorMsg, setErrorMsg]         = useState('');
  const [isSaving, setIsSaving]         = useState(false);
  const [recCount, setRecCount]         = useState(0);      // live sample count during song_playing
  const [dropoutWarning, setDropoutWarning] = useState(false); // BLE silent-stop warning
  // Songs are picked once at mount based on the user's genre preferences
  const [songs, setSongsState]          = useState<Song[]>([]);
  const [resolvedIds, setResolvedIds]   = useState<string[]>([]);
  // Always-current ref so callbacks (doSave, handleVote) never capture a stale songs array
  const songsRef = useRef<Song[]>([]);

  // EEG data collected during this step
  const baselineBuf  = useRef<EEGSample[]>([]);
  const songBufs     = useRef<EEGSample[][]>([[], [], []]);  // one per song (reset after songs load)
  const songLabels   = useRef<number[]>([]);                 // 0=like, 1=dislike

  // Initialize songs + resolvedIds together so they come from the same pickSongs() call
  // Must run AFTER refs are declared so songBufs can be reset here
  useEffect(() => {
    const picked = pickSongs();
    const storedGenres = localStorage.getItem('neurovibe_music_genres');
    console.log('[CalibrationStep] Genres in localStorage:', storedGenres);
    console.log('[CalibrationStep] Picked songs:', picked.map(s => `${s.title} (${s.artist})`));
    songsRef.current = picked;
    setSongsState(picked);
    setResolvedIds(picked.map(s => s.trackId));
    // Reset EEG recording buffers to match exactly how many songs were picked
    songBufs.current = picked.map(() => []);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const museRef      = useRef<MuseClient | null>(null);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef     = useRef<Phase>('instructions');
  // Tracks last EEG sample arrival time (updated on every sample — used by dropout watchdog)
  const lastCalSampleRef  = useRef<number>(0);
  // Interval that refreshes the on-screen sample count + checks for BLE dropout
  const recDisplayRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep phaseRef in sync with phase state (needed inside intervals/subscriptions)
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      timerRef.current    && clearInterval(timerRef.current);
      recDisplayRef.current && clearInterval(recDisplayRef.current);
      museRef.current?.disconnect();
    };
  }, []);

  // ── Muse connection ─────────────────────────────────────────────────────
  const connectMuse = useCallback(async () => {
    setPhase('connecting');
    setStatusMsg('Connecting to Muse headset…');
    try {
      museRef.current = new MuseClient();
      await museRef.current.connect();
      await museRef.current.start();
      setIsMuse(true);
      setStatusMsg('✓ Muse connected');
    } catch (err: any) {
      setErrorMsg(`Failed to connect: ${err.message ?? err}`);
      setPhase('error');
      return;
    }

    // Subscribe to EEG — samples are routed depending on current phase
    zipSamples(museRef.current.eegReadings).subscribe({
      next: (reading) => {
        // Always stamp the last-received time so the watchdog knows the stream is alive
        lastCalSampleRef.current = Date.now();

        const sample: EEGSample = {
          tp9:  reading.data[0] ?? 0,
          af7:  reading.data[1] ?? 0,
          af8:  reading.data[2] ?? 0,
          tp10: reading.data[3] ?? 0,
        };

        const p = phaseRef.current;
        if (p === 'baseline') {
          baselineBuf.current.push(sample);
        } else if (p === 'song_playing') {
          // songIndex is captured via ref below
          songBufs.current[songIndexRef.current].push(sample);
        }
      },
      error: (err) => {
        console.error('[CalibrationStep] EEG stream error:', err);
        // Only surface the error if we haven't already finished or errored
        const curPhase = phaseRef.current;
        if (curPhase !== 'done' && curPhase !== 'saving' && curPhase !== 'error') {
          setErrorMsg(
            'EEG stream disconnected unexpectedly. ' +
            'Please disconnect and reconnect your headset, then try again.'
          );
          setPhase('error');
        }
      },
      complete: () => {
        console.log('[CalibrationStep] EEG stream completed.');
      },
    });

    // Start baseline once connected
    startBaseline();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── song index ref (so the subscription closure can read current song) ──
  const songIndexRef = useRef(0);
  useEffect(() => { songIndexRef.current = songIndex; }, [songIndex]);

  // ── baseline recording ──────────────────────────────────────────────────
  const startBaseline = useCallback(() => {
    setPhase('baseline');
    setTimer(BASELINE_SECONDS);

    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          // Move to first song intro
          setSongIndex(0);
          setPhase('song_intro');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);
  // ── resolve track IDs via Spotify search whenever we enter song_intro ──
  useEffect(() => {
    if (phase !== 'song_intro') return;
    const song = songs[songIndex];
    if (!song) return;
    resolveSpotifyTrackId(song.title, song.artist).then(id => {
      if (id) {
        setResolvedIds(prev => {
          const next = [...prev];
          next[songIndex] = id;
          return next;
        });
      }
    });
  }, [phase, songIndex, songs]);
  // ── song intro → song playing ───────────────────────────────────────────
  const startSong = useCallback(() => {
    setPhase('song_playing');
    setTimer(SONG_SECONDS);
    setRecCount(0);
    setDropoutWarning(false);

    // ── Recording display + dropout watchdog (runs every 600 ms) ────────────
    // Reads the live buffer length so the user can see samples accumulating.
    // If no new sample has arrived for >6 s the headset has silently disconnected.
    if (recDisplayRef.current) clearInterval(recDisplayRef.current);
    recDisplayRef.current = setInterval(() => {
      const n = songBufs.current[songIndexRef.current]?.length ?? 0;
      setRecCount(n);
      const msSinceLast = Date.now() - lastCalSampleRef.current;
      if (lastCalSampleRef.current > 0 && msSinceLast > 6_000) {
        setDropoutWarning(true);
      }
    }, 600);

    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          // Stop the recording display interval when the song ends
          if (recDisplayRef.current) {
            clearInterval(recDisplayRef.current);
            recDisplayRef.current = null;
          }
          setDropoutWarning(false);
          setPhase('song_vote');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── like / dislike vote ─────────────────────────────────────────────────
  const handleVote = useCallback((label: 0 | 1) => {
    songLabels.current.push(label);
    const next = songIndex + 1;

    if (next < songsRef.current.length) {
      setSongIndex(next);
      setPhase('song_intro');
    } else {
      // All songs done → save
      doSave();
    }
  }, [songIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── send data to backend ────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    setPhase('saving');
    setIsSaving(true);

    try {
      // Build baseline windows
      const baselineWindows = splitIntoWindows(baselineBuf.current);
      if (baselineWindows.length < MIN_BASE_WINDOWS) {
        throw new Error(
          `Only ${baselineWindows.length} baseline windows (need ≥ ${MIN_BASE_WINDOWS}). ` +
          'Try a longer baseline recording.'
        );
      }

      // Build per-label calibration windows
      // Use songsRef.current (always current) — NOT the stale 'songs' closure variable
      const calibrationWindows: EEGSample[][] = [];
      const labels: number[] = [];
      const currentSongs = songsRef.current;

      console.log(
        `[CalibrationStep] doSave: ${currentSongs.length} songs, ` +
        `songBuf sizes = [${songBufs.current.map(b => b.length).join(', ')}]`
      );

      currentSongs.forEach((_, i) => {
        const wins = splitIntoWindows(songBufs.current[i] ?? []);
        const lbl  = songLabels.current[i] ?? 0;
        wins.forEach(w => {
          calibrationWindows.push(w);
          labels.push(lbl);
        });
      });

      if (calibrationWindows.length === 0) {
        throw new Error(
          `No calibration windows collected (${currentSongs.length} songs, ` +
          `buf sizes: ${songBufs.current.map(b => b.length).join('/')}).` +
          '\nMake sure you wore the headset while listening (30 s per song).'
        );
      }

      const body = {
        baseline_samples:    baselineWindows,
        calibration_samples: calibrationWindows,
        labels,
      };

      const resp = await fetch('http://localhost:5000/calibration/build', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? `Server returned ${resp.status}`);
      }

      // Disconnect Muse after calibration
      museRef.current?.disconnect();
      setIsMuse(false);
      setPhase('done');
    } catch (err: any) {
      setErrorMsg(err.message ?? String(err));
      setPhase('error');
    } finally {
      setIsSaving(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── baseline progress percentage ────────────────────────────────────────
  const baselinePct =
    phase === 'baseline'
      ? Math.round(((BASELINE_SECONDS - timer) / BASELINE_SECONDS) * 100)
      : 100;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center">
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-purple-400 to-blue-600 flex items-center justify-center">
          <span className="text-4xl">🧬</span>
        </div>
        <h2 className="text-4xl md:text-5xl font-light tracking-tight">EEG Calibration</h2>
        <p className="text-lg text-gray-400 max-w-2xl mx-auto mt-4 font-light leading-relaxed">
          This one-time step personalises the like/dislike model to your unique brain signal.
        </p>
      </div>

      {/* ── Phase: Instructions ─────────────────────────────────────────── */}
      {phase === 'instructions' && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h3 className="text-lg font-light text-gray-200">What will happen</h3>
            <ol className="space-y-3 text-gray-400 font-light">
              <li className="flex gap-3">
                <span className="text-purple-400 font-medium mt-0.5">1.</span>
                <span>
                  Connect your Muse headset — it will record your brain signals for{' '}
                  <strong className="text-white">2.5 minutes</strong> while you sit
                  quietly. This establishes your resting baseline.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-purple-400 font-medium mt-0.5">2.</span>
                <span>
                  You will listen to{' '}
                  <strong className="text-white">3 short song clips</strong> (30 s each)
                  directly in this page using an embedded player.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-purple-400 font-medium mt-0.5">3.</span>
                <span>
                  After each clip, press <strong className="text-green-400">Like</strong>{' '}
                  or <strong className="text-red-400">Dislike</strong>. That teaches
                  the model your musical preferences.
                </span>
              </li>
            </ol>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-sm text-yellow-300 font-light">
            ⚠️ Make sure your Muse headset is on and within Bluetooth range before clicking Start.
          </div>
          <button
            onClick={connectMuse}
            className="group flex items-center gap-3 px-10 py-4 mx-auto rounded-full bg-gradient-to-r from-purple-500 to-blue-600 text-white font-light tracking-wide hover:shadow-2xl hover:shadow-purple-500/30 transition-all duration-500 transform hover:scale-105"
          >
            <span>Connect Headset &amp; Start</span>
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </button>
        </div>
      )}

      {/* ── Phase: Connecting ──────────────────────────────────────────── */}
      {phase === 'connecting' && (
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-300 font-light">{statusMsg}</p>
        </div>
      )}

      {/* ── Phase: Baseline ────────────────────────────────────────────── */}
      {phase === 'baseline' && (
        <div className="max-w-xl mx-auto text-center space-y-8">
          <div className="w-20 h-20 mx-auto rounded-full bg-blue-500/20 border-2 border-blue-400 flex items-center justify-center animate-pulse">
            <span className="text-3xl">🧘</span>
          </div>
          <div>
            <p className="text-2xl font-light text-white mb-1">Recording Baseline</p>
            <p className="text-gray-400 font-light">
              Sit comfortably, relax, and avoid moving. Do not listen to music.
            </p>
          </div>
          {/* Countdown */}
          <div className="text-5xl font-light text-blue-300 tabular-nums">{fmt(timer)}</div>
          {/* Progress bar */}
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div
              className="bg-gradient-to-r from-blue-500 to-purple-500 h-2 rounded-full transition-all duration-1000"
              style={{ width: `${baselinePct}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {baselinePct}% complete · {Math.floor(baselineBuf.current.length / 256)}s of EEG collected
          </p>
        </div>
      )}

      {/* ── Phases: Song Intro / Playing / Vote ─── shared song card + iframe */}
      {(phase === 'song_intro' || phase === 'song_playing' || phase === 'song_vote') && songs.length > 0 && songs[songIndex] && (
        <div className="max-w-lg mx-auto text-center space-y-6">
          {/* Progress indicator */}
          <div className="text-xs text-gray-500 uppercase tracking-widest">
            Song {songIndex + 1} of {songs.length}
            {phase === 'song_playing' && ' · Recording'}
          </div>

          {/* Song info card */}
          <div className="bg-gray-900/60 border border-gray-700 rounded-2xl p-6 space-y-2">
            <div className="text-5xl mb-2">{songs[songIndex].emoji}</div>
            <h3 className="text-xl font-light text-white">{songs[songIndex].title}</h3>
            <p className="text-gray-400 text-sm">{songs[songIndex].artist}</p>
            <span className="inline-block text-xs px-3 py-1 rounded-full bg-gray-800 text-gray-300 border border-gray-700">
              {songs[songIndex].mood}
            </span>
          </div>

          {/* Embedded Spotify player — rendered for ALL song phases so it never unmounts */}
          <div className="rounded-xl overflow-hidden border border-gray-700">
            <iframe
              key={resolvedIds[songIndex]}
              src={`https://open.spotify.com/embed/track/${resolvedIds[songIndex]}?utm_source=generator&theme=0`}
              width="100%"
              height="152"
              frameBorder="0"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              style={{ borderRadius: '12px' }}
            />
          </div>

          {/* ── Song Intro controls ── */}
          {phase === 'song_intro' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">Press play above, then click Ready when you're listening.</p>
              <button
                onClick={startSong}
                className="group flex items-center gap-2 px-8 py-3 mx-auto rounded-full bg-white text-black font-light tracking-wide hover:shadow-xl hover:shadow-white/20 transform hover:scale-105 transition-all duration-300"
              >
                <span>I'm listening — Start timer</span>
                <span className="text-sm transition-transform group-hover:translate-x-1">→</span>
              </button>
            </div>
          )}

          {/* ── Song Playing controls ── */}
          {phase === 'song_playing' && (
            <div className="space-y-4">
              {/* Countdown ring + live sample counter */}
              <div className="flex items-center justify-center gap-4">
                <div className="relative w-16 h-16 flex-shrink-0">
                  <div className="absolute inset-0 rounded-full border-4 border-gray-800" />
                  <div
                    className="absolute inset-0 rounded-full border-4 border-purple-500 border-t-transparent animate-spin"
                    style={{ animationDuration: '2s' }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-light text-white tabular-nums">{timer}</span>
                  </div>
                </div>
                <div className="text-left">
                  <p className="text-gray-400 text-sm font-light">
                    🧠 Recording your brain response… Keep listening.
                  </p>
                  {/* Live sample counter — turns green once data is flowing */}
                  <p className={`text-xs mt-0.5 tabular-nums font-mono ${
                    recCount > 0 ? 'text-green-400' : 'text-gray-600'
                  }`}>
                    {recCount > 0
                      ? `📡 ${recCount} samples recorded`
                      : '📡 Waiting for EEG data…'}
                  </p>
                </div>
              </div>

              {/* Dropout warning — only shown if stream goes silent */}
              {dropoutWarning && (
                <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 text-xs text-red-300 font-light text-center">
                  ⚠️ No EEG data received for several seconds. Your headset may have disconnected.
                  <br />Try adjusting the headset position or restarting calibration.
                </div>
              )}

              <button
                onClick={() => {
                  timerRef.current && clearInterval(timerRef.current);
                  timerRef.current = null;
                  if (recDisplayRef.current) {
                    clearInterval(recDisplayRef.current);
                    recDisplayRef.current = null;
                  }
                  setDropoutWarning(false);
                  setPhase('song_vote');
                }}
                className="text-xs text-gray-600 hover:text-gray-400 underline transition-colors"
              >
                Song finished early? Continue
              </button>
            </div>
          )}

          {/* ── Song Vote controls ── */}
          {phase === 'song_vote' && (
            <div className="space-y-4">
              <p className="text-lg font-light text-white">
                Did you like{' '}
                <span className="text-purple-300 italic">{songs[songIndex].title}</span>?
              </p>
              <div className="flex gap-4 justify-center">
                <button
                  onClick={() => handleVote(0)}
                  className="group flex flex-col items-center gap-2 px-10 py-5 rounded-2xl border-2 border-green-500/50 bg-green-500/10 hover:bg-green-500/20 hover:border-green-400 text-green-300 transition-all duration-300 transform hover:scale-105"
                >
                  <span className="text-4xl">👍</span>
                  <span className="font-light tracking-wide">Like</span>
                </button>
                <button
                  onClick={() => handleVote(1)}
                  className="group flex flex-col items-center gap-2 px-10 py-5 rounded-2xl border-2 border-red-500/50 bg-red-500/10 hover:bg-red-500/20 hover:border-red-400 text-red-300 transition-all duration-300 transform hover:scale-105"
                >
                  <span className="text-4xl">👎</span>
                  <span className="font-light tracking-wide">Dislike</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Phase: Saving ──────────────────────────────────────────────── */}
      {phase === 'saving' && (
        <div className="text-center space-y-6">
          <div className="w-16 h-16 mx-auto border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-300 font-light">
            Building your personalised model…
          </p>
          <p className="text-xs text-gray-600">This may take a few seconds.</p>
        </div>
      )}

      {/* ── Phase: Done ────────────────────────────────────────────────── */}
      {phase === 'done' && (
        <div className="max-w-lg mx-auto text-center space-y-8">
          <div className="w-20 h-20 mx-auto rounded-full bg-green-500/20 border-2 border-green-400 flex items-center justify-center">
            <span className="text-4xl text-green-400">✓</span>
          </div>
          <div>
            <h3 className="text-3xl font-light text-white mb-2">Calibration Complete!</h3>
            <p className="text-gray-400 font-light">
              Your personalised like/dislike model has been saved. The system will now
              show whether you're enjoying the music in real-time alongside your emotional
              state.
            </p>
          </div>
          <button
            onClick={onComplete}
            className="group flex items-center gap-2 px-8 py-3 mx-auto rounded-full bg-gradient-to-r from-green-500 to-blue-500 text-white font-light tracking-wide hover:shadow-xl transition-all duration-300 transform hover:scale-105"
          >
            <span>Continue to Choose Mode</span>
            <span className="text-sm transition-transform group-hover:translate-x-1">→</span>
          </button>
        </div>
      )}

      {/* ── Phase: Error ───────────────────────────────────────────────── */}
      {phase === 'error' && (
        <div className="max-w-lg mx-auto text-center space-y-6">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-500/20 border-2 border-red-400 flex items-center justify-center">
            <span className="text-2xl text-red-400">✕</span>
          </div>
          <p className="text-red-300 font-light">{errorMsg}</p>
          <div className="flex gap-4 justify-center">
            <button
              onClick={() => {
                // Stop any running intervals
                if (recDisplayRef.current) { clearInterval(recDisplayRef.current); recDisplayRef.current = null; }
                setPhase('instructions');
                baselineBuf.current = [];
                songBufs.current    = [[], [], []];
                songLabels.current  = [];
                setSongIndex(0);
                setErrorMsg('');
                setRecCount(0);
                setDropoutWarning(false);
              }}
              className="px-6 py-2 rounded-full border border-gray-700 text-gray-400 hover:border-gray-500 text-sm font-light transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={onComplete}
              className="px-6 py-2 rounded-full border border-gray-700 text-gray-400 hover:border-gray-500 text-sm font-light transition-colors"
            >
              Skip for Now
            </button>
          </div>
        </div>
      )}

      {/* Muse indicator */}
      {isMuseConnected && phase !== 'done' && phase !== 'error' && (
        <div className="text-center">
          <span className="inline-block text-xs px-3 py-1 rounded-full bg-green-500/10 border border-green-500/30 text-green-400">
            ● Muse connected
          </span>
        </div>
      )}
    </div>
  );
}
