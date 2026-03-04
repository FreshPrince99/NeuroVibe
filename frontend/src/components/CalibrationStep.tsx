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
  | 'genre_select'   // pick disliked genres before calibration begins
  | 'instructions'
  | 'connecting'
  | 'baseline'
  | 'song_intro'
  | 'song_playing'
  | 'song_vote'
  | 'saving'
  | 'done'
  | 'error';

const BASELINE_SECONDS = 150;  // 2.5 minutes
const CLIP_SECONDS     = 20;   // 20-second recording per clip
const N_CLIPS          = 10;   // total calibration clips (6 liked + 4 disliked)
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

// ─────────────────────────────────────────────────────────────────────────────
// Disliked genre song pool — ensures mixed (like/dislike) calibration labels
// ─────────────────────────────────────────────────────────────────────────────

const DISLIKE_SONG_POOL: Record<string, Song[]> = {
  'Heavy metal': [
    { title: 'Enter Sandman',       artist: 'Metallica',          trackId: '5sICkBXVmaCQk5aISGR3x1', emoji: '🤘', mood: 'Aggressive & Heavy',    energy: 'energetic' },
    { title: 'Paranoid',            artist: 'Black Sabbath',       trackId: '2Bz3vZWWr0dkmqPGxO9Fze', emoji: '💀', mood: 'Dark & Distorted',       energy: 'energetic' },
    { title: 'Chop Suey!',          artist: 'System of a Down',    trackId: '0nJW01T7XtvILxQgC5J7Wh', emoji: '🎸', mood: 'Frantic & Intense',      energy: 'energetic' },
  ],
  'Opera': [
    { title: 'Nessun Dorma',        artist: 'Pavarotti',           trackId: '0fNVKHpxQoVGCGBQJeYLMl', emoji: '🎭', mood: 'Grand & Operatic',       energy: 'energetic' },
    { title: 'O Mio Babbino Caro',  artist: 'Maria Callas',        trackId: '7pMNPGFVXUAVJYliNQSKCz', emoji: '🎤', mood: 'Classical & Dramatic',   energy: 'calm'      },
  ],
  'Country': [
    { title: 'Friends in Low Places', artist: 'Garth Brooks',      trackId: '3vB7Lp1xkEOZBMjFnSK3qG', emoji: '🤠', mood: 'Twangy & Country',       energy: 'energetic' },
    { title: 'Jolene',               artist: 'Dolly Parton',        trackId: '4uFZsG1vXrPcPnMhKcf7nN', emoji: '🌻', mood: 'Country & Heartfelt',    energy: 'calm'      },
    { title: 'Take Me Home, Country Roads', artist: 'John Denver',  trackId: '7sOR7gk6XhpGfJoCPHxf1V', emoji: '🛣️', mood: 'Nostalgic & Country',   energy: 'calm'      },
  ],
  'EDM': [
    { title: 'Levels',              artist: 'Avicii',               trackId: '0nk0RDXsP5MZgaFaFcM4K6', emoji: '⚡', mood: 'Festival & Uplifting',   energy: 'energetic' },
    { title: 'Animals',             artist: 'Martin Garrix',        trackId: '4kFRCxZD8jNqPz51LKhASk', emoji: '🎉', mood: 'Drop & Intense',         energy: 'energetic' },
    { title: 'Titanium',            artist: 'David Guetta',         trackId: '0d28khcov6AiegSCpG5TuT', emoji: '🔊', mood: 'Loud & Big Room',        energy: 'energetic' },
  ],
  'Hip-hop': [
    { title: 'HUMBLE.',             artist: 'Kendrick Lamar',       trackId: '7KXjTSCq5nL1LoYtL7XAwS', emoji: '🎤', mood: 'Bold & Trap',            energy: 'energetic' },
    { title: "God's Plan",          artist: 'Drake',                trackId: '6DCZcSspjsKoFjzjrWoCdn', emoji: '🙏', mood: 'Mellow & Urban',         energy: 'calm'      },
    { title: 'SICKO MODE',          artist: 'Travis Scott',         trackId: '2xLMifQCjDGFmkHkpNLD9h', emoji: '🌙', mood: 'Dark & Trap',            energy: 'energetic' },
  ],
  'K-Pop': [
    { title: 'Dynamite',            artist: 'BTS',                  trackId: '0t1kP63rueHleOhQkYSXFY', emoji: '💜', mood: 'Bubbly & Upbeat',        energy: 'energetic' },
    { title: 'Kill This Love',      artist: 'BLACKPINK',            trackId: '6nJ0sKV5m1DWQbXCT44aSo', emoji: '🌸', mood: 'Fierce & Pop',           energy: 'energetic' },
  ],
};

/** All keys in DISLIKE_SONG_POOL, shown to user in genre_select phase. */
const DISLIKE_GENRES = Object.keys(DISLIKE_SONG_POOL);

/**
 * Pick N_CLIPS calibration clips:
 *  - 6 from the user's liked genres (from localStorage)
 *  - 4 from the genres the user says they dislike
 * Shuffled so disliked songs aren't all at the end (avoids order bias).
 */
function pickClips(dislikedGenres: string[]): Song[] {
  try {
    const stored  = localStorage.getItem('neurovibe_music_genres');
    const energy  = (localStorage.getItem('neurovibe_focus_energy') ?? 'calm') as 'calm' | 'energetic';
    const likedGenres: string[] = stored ? JSON.parse(stored) : [];

    // ── Liked clips (target: 6) ──────────────────────────────────────────
    const likedCandidates: Song[] = [];
    for (const genre of likedGenres) {
      const pool = SONG_POOL[genre] ?? [];
      likedCandidates.push(...pool);
    }
    const likedPreferred  = likedCandidates.filter(s => s.energy === energy).sort(() => Math.random() - 0.5);
    const likedOther      = likedCandidates.filter(s => s.energy !== energy).sort(() => Math.random() - 0.5);
    const likedSorted = [...likedPreferred, ...likedOther];

    const seenLiked = new Set<string>();
    const likedPicked: Song[] = [];
    for (const s of likedSorted) {
      if (!seenLiked.has(s.trackId) && likedPicked.length < 6) {
        seenLiked.add(s.trackId);
        likedPicked.push(s);
      }
    }
    // Pad with defaults if needed
    for (const s of DEFAULT_SONGS) {
      if (likedPicked.length >= 6) break;
      if (!seenLiked.has(s.trackId)) { seenLiked.add(s.trackId); likedPicked.push(s); }
    }

    // ── Disliked clips (target: 4) ─────────────────────────────────────
    const dislikedCandidates: Song[] = [];
    for (const genre of dislikedGenres) {
      const pool = DISLIKE_SONG_POOL[genre] ?? [];
      dislikedCandidates.push(...pool);
    }
    // Fallback: pick from the first dislike pool entry if none selected
    if (dislikedCandidates.length === 0) {
      const fallbackPool = Object.values(DISLIKE_SONG_POOL)[0] ?? [];
      dislikedCandidates.push(...fallbackPool);
    }
    dislikedCandidates.sort(() => Math.random() - 0.5);

    const seenDisliked = new Set<string>(seenLiked); // avoid duplicates with liked
    const dislikedPicked: Song[] = [];
    for (const s of dislikedCandidates) {
      if (!seenDisliked.has(s.trackId) && dislikedPicked.length < 4) {
        seenDisliked.add(s.trackId);
        dislikedPicked.push(s);
      }
    }

    // ── Merge + shuffle (Fisher-Yates) ──────────────────────────────────
    const all = [...likedPicked, ...dislikedPicked];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    const result = all.slice(0, N_CLIPS);

    console.log('[CalibrationStep] pickClips:', result.map(s => `${s.title} (${s.artist})`));
    return result;
  } catch {
    return DEFAULT_SONGS.slice(0, N_CLIPS);
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
  const [phase, setPhase]               = useState<Phase>('genre_select');
  const [songIndex, setSongIndex]       = useState(0);
  const [timer, setTimer]               = useState(0);
  const [isMuseConnected, setIsMuse]    = useState(false);
  const [statusMsg, setStatusMsg]       = useState('');
  const [errorMsg, setErrorMsg]         = useState('');
  const [isSaving, setIsSaving]         = useState(false);
  const [recCount, setRecCount]         = useState(0);      // live sample count during song_playing
  const [dropoutWarning, setDropoutWarning] = useState(false); // BLE silent-stop warning
  // Songs are picked when the user completes genre_select phase
  const [songs, setSongsState]          = useState<Song[]>([]);
  const [resolvedIds, setResolvedIds]   = useState<string[]>([]);
  // Genres the user explicitly dislikes — used to ensure mixed labels in calibration
  const [dislikedGenres, setDislikedGenres] = useState<string[]>([]);
  // Always-current ref so callbacks (doSave, handleVote) never capture a stale songs array
  const songsRef = useRef<Song[]>([]);

  // EEG data collected during this step
  const baselineBuf  = useRef<EEGSample[]>([]);
  const songBufs     = useRef<EEGSample[][]>([[], [], []]);  // one per song (reset after songs load)
  const songLabels   = useRef<number[]>([]);                 // 0=like, 1=dislike

  // Songs are initialised in the genre_select Continue handler (not at mount)
  // so we have the user's disliked genre selections before calling pickClips().

  const museRef       = useRef<MuseClient | null>(null);
  // Saved after first BLE connect — lets every auto-reconnect bypass the browser device picker
  const museDeviceRef = useRef<BluetoothDevice | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // Reconnect when the tab comes back to the foreground (Chrome suspends BLE in background)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const p = phaseRef.current;
      if (p !== 'baseline' && p !== 'song_playing') return;
      const elapsed = Date.now() - lastCalSampleRef.current;
      if (elapsed > 5_000 && lastCalSampleRef.current > 0 && museDeviceRef.current) {
        console.log(`[CalibrationStep][Visibility] EEG silent ${Math.round(elapsed/1000)}s — reconnecting`);
        const savedDev = museDeviceRef.current;
        void (async () => {
          try {
            if (museRef.current) { try { museRef.current.disconnect(); } catch {} }
            const nc = new MuseClient();
            nc.enablePpg = true;
            museRef.current = nc;
            const fg = await savedDev.gatt!.connect();
            await nc.connect(fg);
            const nd = ((nc as any).gatt)?.device as BluetoothDevice | undefined;
            if (nd) museDeviceRef.current = nd;
            await nc.start();
            lastCalSampleRef.current = Date.now();
            setIsMuse(true);
            setStatusMsg('✓ Muse reconnected (tab focus)');
            zipSamples(nc.eegReadings).subscribe({
              next: (reading) => {
                lastCalSampleRef.current = Date.now();
                const s = {
                  tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
                  af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
                  af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
                  tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
                };
                const p2 = phaseRef.current;
                if (p2 === 'baseline') baselineBuf.current.push(s);
                else if (p2 === 'song_playing') songBufs.current[songIndexRef.current].push(s);
              },
              error: () => {},
              complete: () => {},
            });
          } catch (e) {
            console.error('[CalibrationStep][Visibility] Reconnect failed:', e);
          }
        })();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []); // refs-only inside — no stale closure risk

  // ── Muse connection ─────────────────────────────────────────────────────
  const connectMuse = useCallback(async () => {
    setPhase('connecting');
    setStatusMsg('Connecting to Muse headset…');
    try {
      museRef.current = new MuseClient();
      // Enable PPG on Muse 2 / Muse S BEFORE connect
      museRef.current.enablePpg = true;
      await museRef.current.connect();
      // Save device reference so reconnects can skip the browser picker
      const _dev = ((museRef.current as any).gatt)?.device as BluetoothDevice | undefined;
      if (_dev) museDeviceRef.current = _dev;
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
          tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
          af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
          af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
          tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
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
        const curPhase = phaseRef.current;
        if (curPhase === 'done' || curPhase === 'saving' || curPhase === 'error') return;

        // Auto-reconnect: preserve all buffers, timers and phase — just re-establish BLE.
        setStatusMsg('📡 EEG disconnected — reconnecting…');
        void (async () => {
          try {
            if (museRef.current) { try { museRef.current.disconnect(); } catch { /* ignore */ } }
            const newClient = new MuseClient();
            newClient.enablePpg = true;
            museRef.current = newClient;
            // Reuse saved device to skip the Bluetooth picker (no user gesture needed)
            const _savedDev = museDeviceRef.current;
            if (_savedDev) {
              const _freshGatt = await _savedDev.gatt!.connect();
              await newClient.connect(_freshGatt);
            } else {
              await newClient.connect();
            }
            const _newDev = ((newClient as any).gatt)?.device as BluetoothDevice | undefined;
            if (_newDev) museDeviceRef.current = _newDev;
            await newClient.start();
            lastCalSampleRef.current = Date.now();
            setIsMuse(true);
            setStatusMsg('✓ Muse reconnected');

            // Re-subscribe with identical logic — buffers + phase are unchanged.
            zipSamples(newClient.eegReadings).subscribe({
              next: (reading) => {
                lastCalSampleRef.current = Date.now();
                const s = {
                  tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
                  af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
                  af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
                  tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
                };
                const p = phaseRef.current;
                if (p === 'baseline') baselineBuf.current.push(s);
                else if (p === 'song_playing') songBufs.current[songIndexRef.current].push(s);
              },
              error: (err2) => {
                console.error('[CalibrationStep] EEG error after reconnect:', err2);
                if (phaseRef.current !== 'done' && phaseRef.current !== 'saving') {
                  setErrorMsg('EEG disconnected twice. Please restart calibration.');
                  setPhase('error');
                }
              },
              complete: () => console.log('[CalibrationStep] EEG reconnect stream complete.'),
            });
          } catch (reconnErr: unknown) {
            console.error('[CalibrationStep] Auto-reconnect failed:', reconnErr);
            if (phaseRef.current !== 'done' && phaseRef.current !== 'saving') {
              setErrorMsg(
                'Could not reconnect headset. Please restart calibration and try again.'
              );
              setPhase('error');
            }
          }
        })();
      },
      complete: () => {
        // BLE disconnected gracefully — treat as a silent drop so calibration continues.
        console.warn('[CalibrationStep] EEG stream completed (BLE dropped) — reconnecting…');
        const _p = phaseRef.current;
        if (_p === 'done' || _p === 'saving' || _p === 'error') return;
        setStatusMsg('📡 EEG stream ended — reconnecting…');
        void (async () => {
          try {
            if (museRef.current) { try { museRef.current.disconnect(); } catch { /* ignore */ } }
            const _nc = new MuseClient();
            _nc.enablePpg = true;
            museRef.current = _nc;
            const _sd = museDeviceRef.current;
            if (_sd) {
              const _fg = await _sd.gatt!.connect();
              await _nc.connect(_fg);
            } else {
              await _nc.connect();
            }
            const _nd = ((_nc as any).gatt)?.device as BluetoothDevice | undefined;
            if (_nd) museDeviceRef.current = _nd;
            await _nc.start();
            lastCalSampleRef.current = Date.now();
            setIsMuse(true);
            setStatusMsg('✓ Muse reconnected');
            zipSamples(_nc.eegReadings).subscribe({
              next: (reading) => {
                lastCalSampleRef.current = Date.now();
                const s = {
                  tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
                  af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
                  af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
                  tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
                };
                const p2 = phaseRef.current;
                if (p2 === 'baseline') baselineBuf.current.push(s);
                else if (p2 === 'song_playing') songBufs.current[songIndexRef.current].push(s);
              },
              error: () => { /* give up — user will see dropout warning */ },
              complete: () => {},
            });
          } catch {
            if (phaseRef.current !== 'done' && phaseRef.current !== 'saving') {
              setErrorMsg('EEG stream ended and reconnect failed. Please restart calibration.');
              setPhase('error');
            }
          }
        })();
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
    setTimer(CLIP_SECONDS);
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

  // ── song intro: auto-advance to recording after 5 s ─────────────────────
  // Gives the user time to press play on the Spotify embed before EEG recording begins.
  // The manual "Start Recording" button still works as an early trigger.
  useEffect(() => {
    if (phase !== 'song_intro') return;
    const t = setTimeout(() => { startSong(); }, 5_000);
    return () => clearTimeout(t);
  }, [phase, songIndex, startSong]); // songIndex ensures it re-arms for every new clip

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

      {/* ── Phase: Genre Select ────────────────────────────────────────── */}
      {phase === 'genre_select' && (
        <div className="max-w-lg mx-auto space-y-6">
          <div className="text-center space-y-2">
            <h3 className="text-2xl font-light text-white">Quick Preference Check</h3>
            <p className="text-gray-400 font-light text-sm">
              Select any genres you <strong className="text-red-400">dislike</strong>.
              We&apos;ll include a few clips from these so the model can learn
              what your brain looks like when you&apos;re <em>not</em> enjoying music.
              Pick at least one.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {DISLIKE_GENRES.map(g => (
              <button
                key={g}
                onClick={() =>
                  setDislikedGenres(prev =>
                    prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]
                  )
                }
                className={`p-3 rounded-xl border-2 text-sm font-light capitalize transition-all ${
                  dislikedGenres.includes(g)
                    ? 'border-red-500 bg-red-500/10 text-red-300'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
          {dislikedGenres.length === 0 && (
            <p className="text-xs text-yellow-400/70 text-center">
              ⚠️ Please select at least one genre you dislike to enable accurate calibration.
            </p>
          )}
          <button
            disabled={dislikedGenres.length === 0}
            onClick={() => {
              // Pick clips now that we have the disliked genres
              const picked = pickClips(dislikedGenres);
              songsRef.current = picked;
              setSongsState(picked);
              setResolvedIds(picked.map(s => s.trackId));
              songBufs.current = picked.map(() => []);
              setPhase('instructions');
            }}
            className="group flex items-center gap-2 px-8 py-3 mx-auto rounded-full
                       bg-gradient-to-r from-purple-500 to-blue-600 text-white font-light
                       tracking-wide hover:shadow-xl hover:shadow-purple-500/30 transition-all
                       duration-300 transform hover:scale-105 disabled:opacity-40
                       disabled:pointer-events-none"
          >
            <span>Continue →</span>
          </button>
        </div>
      )}

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
                  <strong className="text-white">{N_CLIPS} short clips</strong> (20 s each)
                  that play back to back. Each clip starts recording automatically.
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
              <p className="text-xs text-gray-500 animate-pulse">
                ⏳ Recording starts automatically in 5 s — press play in the player above.
              </p>
              <button
                onClick={startSong}
                className="group flex items-center gap-2 px-8 py-3 mx-auto rounded-full bg-white text-black font-light tracking-wide hover:shadow-xl hover:shadow-white/20 transform hover:scale-105 transition-all duration-300"
              >
                <span>Start Recording Now</span>
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
                setPhase('genre_select');
                baselineBuf.current = [];
                songBufs.current    = songsRef.current.map(() => []);
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
