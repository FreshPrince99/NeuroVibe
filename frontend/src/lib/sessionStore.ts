/**
 * NeuroVibe Session Store — module-level in-memory cache.
 * Data is lost on page reload. No server or localStorage needed.
 */

export type SessionMode = 'focus' | 'relaxation' | 'cognitive';

export interface SongRecord {
  name: string;
  artist: string;
  genre: string;
  uri: string;
  emotions: string[];           // all emotion labels captured during this song
  dominantEmotion: string;      // most frequent emotion
  avgValence: number;           // 0-1 (from VAD)
  likeDislikeLabel?: string;    // 'like' | 'dislike'
  listeningSeconds: number;     // how long it played
  /** 0-1: how well it served the session goal */
  score: number;
}

export interface EEGSnapshot {
  t: number;          // seconds from session start
  focus: number;
  calm: number;
  control: number;
  symmetry: number;
  ppg: number;
}

export interface CognitiveStats {
  focus: number;
  calm: number;
  control: number;
  ppg: number;
  symmetry: number;
}

export interface SessionData {
  mode: SessionMode;
  startTime: number;
  endTime: number;
  // Music-mode data
  songs: SongRecord[];
  // Cognitive-mode data
  activityId?: string;
  cognitiveStats: CognitiveStats[];
  peakValue: number;
  lapTimeSeconds?: number | null;
  // Common
  eegSnapshots: EEGSnapshot[];
}

const EMPTY: SessionData = {
  mode: 'focus',
  startTime: 0,
  endTime: 0,
  songs: [],
  cognitiveStats: [],
  peakValue: 0,
  lapTimeSeconds: null,
  eegSnapshots: [],
};

let _session: SessionData = { ...EMPTY };

/** Start (or restart) a session for the given mode. */
export function initSession(mode: SessionMode): void {
  _session = {
    ...EMPTY,
    mode,
    startTime: Date.now(),
  };
}

/** Finalize a completed song and push it into the session. Called by EmotionView when the track changes. */
export function pushSongRecord(record: Omit<SongRecord, 'dominantEmotion' | 'score'>): void {
  const freq: Record<string, number> = {};
  for (const e of record.emotions) freq[e] = (freq[e] ?? 0) + 1;
  const dominantEmotion = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral';

  // Score = how well the song matched the session goal
  const score = computeSongScore(record.emotions, record.avgValence, _session.mode, record.likeDislikeLabel);

  _session.songs.push({ ...record, dominantEmotion, score });
}

/** Add a rolling EEG/metric snapshot (called every second while session is running). */
export function addEEGSnapshot(snap: Omit<EEGSnapshot, 't'>): void {
  const t = _session.startTime > 0 ? (Date.now() - _session.startTime) / 1000 : 0;
  _session.eegSnapshots.push({ t, ...snap });
  // Keep at most 3000 snapshots (~50 min at 1Hz)
  if (_session.eegSnapshots.length > 3000) _session.eegSnapshots.splice(0, 100);
}

/** Write cognitive-mode stats (called when the CognitiveTrainingView session ends). */
export function setCognitiveData(
  stats: CognitiveStats[],
  activityId: string,
  peakValue: number,
  lapTimeSeconds?: number | null,
): void {
  _session.activityId = activityId;
  _session.cognitiveStats = stats;
  _session.peakValue = peakValue;
  _session.lapTimeSeconds = lapTimeSeconds ?? null;
}

/** Mark the session as finished and return the final snapshot. */
export function finaliseSession(): SessionData {
  _session.endTime = Date.now();
  return { ..._session };
}

/** Read the current session data (mutable reference — copy if you need a snapshot). */
export function getSession(): SessionData {
  return _session;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const FOCUS_POSITIVE  = new Set(['focused', 'alert', 'energized', 'happy', 'content', 'excited']);
const RELAX_POSITIVE  = new Set(['relaxed', 'calm', 'content', 'peaceful', 'neutral']);
const NEGATIVE        = new Set(['stressed', 'anxious', 'angry', 'sad', 'tired', 'bored']);

function computeSongScore(
  emotions: string[],
  avgValence: number,
  mode: SessionMode,
  likeLabel?: string,
): number {
  if (!emotions.length) return 0.5;

  const positiveSet = mode === 'focus' ? FOCUS_POSITIVE : RELAX_POSITIVE;
  const positiveCount = emotions.filter(e => positiveSet.has(e)).length;
  const negativeCount = emotions.filter(e => NEGATIVE.has(e)).length;
  const ratio = (positiveCount - negativeCount * 0.5) / emotions.length;

  const valenceBonus = mode === 'relaxation' ? (1 - avgValence) * 0.2 : avgValence * 0.2;
  const likeBonus = likeLabel === 'like' ? 0.15 : likeLabel === 'dislike' ? -0.15 : 0;

  return Math.max(0, Math.min(1, 0.5 + ratio * 0.5 + valenceBonus + likeBonus));
}
