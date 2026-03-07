'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import Player, { PlayerRef } from './player';
import EEGVisualization from './EEGVisualization';
import { pushSongRecord } from '@/lib/sessionStore';

interface EEGData {
  tp9: number;
  af7: number;
  af8: number;
  tp10: number;
  timestamp: number;
}

interface EmotionViewProps {
  predictedEmotion: string;
  predictedVAD?: {
    valence: number;
    arousal: number;
    dominance: number;
  } | null;
  isUsingMusePrediction: boolean;
  sampleCount: number;
  connectionStatus: string;
  onPauseToggle: () => void;
  isPaused: boolean;
  needsConnect?: boolean;
  isConnecting?: boolean;
  onConnect?: () => void;
  eegData?: EEGData[];
  ppgData?: number[];   // raw PPG samples from Muse 2
  ppgAvailable?: boolean | null;
  onExitToHome?: () => void;
  onBackToHome?: () => void;  onStopSession?: () => void;  playerRef?: React.RefObject<PlayerRef | null>;
  likeDislike?: { label: string; probability: number; confidence: number } | null;
}

export default function EmotionView({ 
  predictedEmotion, 
  predictedVAD,
  isUsingMusePrediction,
  sampleCount,
  connectionStatus,
  onPauseToggle,
  isPaused,
  needsConnect = false,
  isConnecting = false,
  onConnect,
  eegData = [],
  ppgData = [],
  ppgAvailable = null,
  onExitToHome,
  onBackToHome,
  onStopSession,
  playerRef,
  likeDislike,
}: EmotionViewProps) {
  const [selectedEmotion, setSelectedEmotion] = useState<string>("happy");
  const [useMusePrediction, setUseMusePrediction] = useState<boolean>(isUsingMusePrediction);
  const hasAutoEnabledRef = useRef(false);

  // ── Per-song tracking for session results ────────────────────────────
  const songEmotionsRef = useRef<string[]>([]);
  const songValencesRef = useRef<number[]>([]);
  const songStartTimeRef = useRef<number>(Date.now());
  const currentSongRef = useRef<{ name: string; artist: string; uri: string; genre: string } | null>(null);
  const lastLikeDislikeRef = useRef<string | undefined>(undefined);

  // Collect emotions while a song is playing
  useEffect(() => {
    if (!predictedEmotion) return;
    songEmotionsRef.current.push(predictedEmotion.toLowerCase());
  }, [predictedEmotion]);

  // Collect valence
  useEffect(() => {
    if (predictedVAD?.valence != null) {
      songValencesRef.current.push(predictedVAD.valence);
    }
  }, [predictedVAD]);

  // Track latest like/dislike for current song
  useEffect(() => {
    if (likeDislike) lastLikeDislikeRef.current = likeDislike.label;
  }, [likeDislike]);

  const flushCurrentSong = useCallback(() => {
    if (!currentSongRef.current) return;
    const listeningSeconds = (Date.now() - songStartTimeRef.current) / 1000;
    const vals = songValencesRef.current;
    const avgValence = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.5;
    pushSongRecord({
      name: currentSongRef.current.name,
      artist: currentSongRef.current.artist,
      genre: currentSongRef.current.genre,
      uri: currentSongRef.current.uri,
      emotions: [...songEmotionsRef.current],
      avgValence,
      listeningSeconds,
      likeDislikeLabel: lastLikeDislikeRef.current,
    });
  }, []);

  const handleTrackChange = useCallback((track: { name: string; artist: string; uri: string; genre: string } | null) => {
    // Flush previous song before switching
    flushCurrentSong();
    // Reset trackers for new song
    currentSongRef.current = track;
    songEmotionsRef.current = [];
    songValencesRef.current = [];
    songStartTimeRef.current = Date.now();
    lastLikeDislikeRef.current = undefined;
  }, [flushCurrentSong]);

  const handleStopSession = useCallback(() => {
    // Save partial current song if it was playing long enough
    const elapsed = (Date.now() - songStartTimeRef.current) / 1000;
    if (elapsed > 10) flushCurrentSong();
    playerRef?.current?.pause();
    onStopSession?.();
  }, [flushCurrentSong, onStopSession, playerRef]);

  useEffect(() => {
    if (predictedEmotion && isUsingMusePrediction && !hasAutoEnabledRef.current) {
      hasAutoEnabledRef.current = true;
      setUseMusePrediction(true);
    }
  }, [predictedEmotion, isUsingMusePrediction]);

  const emotions = [
    { name: "happy", color: "bg-yellow-400" },
    { name: "sad", color: "bg-blue-500" },
    { name: "stressed", color: "bg-red-500" },
    { name: "relaxed", color: "bg-green-400" },
    { name: "excited", color: "bg-pink-500" },
    { name: "energized", color: "bg-orange-500" },
    { name: "content", color: "bg-emerald-400" },
    { name: "anxious", color: "bg-amber-600" },
    { name: "angry", color: "bg-rose-600" },
    { name: "bored", color: "bg-slate-500" },
    { name: "neutral", color: "bg-gray-400" },
    { name: "alert", color: "bg-indigo-500" },
    { name: "calm", color: "bg-teal-400" },
    { name: "tired", color: "bg-zinc-500" },
  ];

  const getCurrentColor = () => {
    const currentEmotion = useMusePrediction && predictedEmotion ? predictedEmotion.toLowerCase() : selectedEmotion;
    return emotions.find((e) => e.name === currentEmotion)?.color || "bg-gray-300";
  };

  const getDisplayEmotion = () => {
    return useMusePrediction && predictedEmotion ? predictedEmotion : selectedEmotion;
  };

  const formatVAD = (value: number) => value.toFixed(2);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      {/* Header */}
      <header className="w-full border-b border-zinc-200 bg-white py-4 dark:border-zinc-800 dark:bg-black">
        <div className="container mx-auto px-8 flex items-center justify-between">
          <button
            onClick={onBackToHome}
            className="text-3xl font-bold text-black dark:text-white hover:text-gray-600 dark:hover:text-gray-300 transition-colors cursor-pointer"
          >
            NeuroVibe
          </button>
          
          {/* Status Badge */}
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-semibold">{sampleCount}</span> samples
            </div>
            <div className="px-4 py-2 rounded-full bg-green-500/20 text-green-400 border border-green-500/50 text-sm">
              {connectionStatus || 'Connected'}
            </div>
            <button
              onClick={onPauseToggle}
              className={`px-4 py-2 rounded-lg transition-colors text-sm font-semibold ${
                isPaused 
                  ? 'bg-green-500 text-white hover:bg-green-600'
                  : 'bg-orange-500 text-white hover:bg-orange-600'
              }`}
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={handleStopSession}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
            >
              Stop Session
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 flex-col">
        {/* Auto-connecting Loading Overlay (no user action needed) */}
        {isConnecting && !needsConnect && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-900 rounded-2xl p-8 max-w-md mx-4 text-center shadow-2xl border border-gray-200 dark:border-gray-800">
              <div className="flex flex-col items-center gap-4">
                <svg className="animate-spin h-12 w-12 text-purple-500" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <h2 className="text-2xl font-bold text-black dark:text-white">
                  Connecting to Muse...
                </h2>
                <p className="text-gray-600 dark:text-gray-400">
                  {connectionStatus}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Connect Overlay */}
        {needsConnect && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-900 rounded-2xl p-8 max-w-md mx-4 text-center shadow-2xl border border-gray-200 dark:border-gray-800">
              <div className="text-6xl mb-4">📡</div>
              <h2 className="text-2xl font-bold mb-4 text-black dark:text-white">
                Connect Your Muse Headset
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Click below to select your Muse device and start streaming EEG data for emotion detection.
              </p>
              <button
                onClick={onConnect}
                disabled={isConnecting}
                className="w-full px-8 py-4 text-lg font-bold text-white bg-gradient-to-r from-blue-500 to-purple-500 rounded-full hover:shadow-2xl hover:shadow-purple-500/50 transition-all duration-300 transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
              >
                {isConnecting ? (
                  <span className="flex items-center justify-center gap-3">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Connecting...
                  </span>
                ) : (
                  'Connect Muse Headset'
                )}
              </button>
              <button
                onClick={onExitToHome}
                className="w-full px-8 py-4 text-lg font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                Exit to Home
              </button>
            </div>
          </div>
        )}

        {/* Top Section - Emotion Circle, Controls & Player */}
        <div className="flex flex-1 flex-col lg:flex-row">
          {/* Left Side - Emotion Circle & Controls */}
          <div className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
          {/* Circle */}
          <div
            className={`flex h-64 w-64 items-center justify-center rounded-full ${getCurrentColor()} transition-colors duration-500 shadow-lg`}
          >
            <div className="text-center">
              <span className="text-3xl font-semibold capitalize text-white">
                {getDisplayEmotion()}
              </span>
              {useMusePrediction && predictedEmotion && (
                <p className="mt-2 text-sm text-white/80">
                  🧠 Live from Muse
                </p>
              )}
              {useMusePrediction && predictedVAD && (
                <div className="mt-3 text-xs text-white/90">
                  <div>V: {formatVAD(predictedVAD.valence)}</div>
                  <div>A: {formatVAD(predictedVAD.arousal)}</div>
                  <div>D: {formatVAD(predictedVAD.dominance)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Manual Override Toggle */}
          <div className="flex flex-col gap-4 w-full max-w-xs">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="use-muse"
                checked={useMusePrediction}
                onChange={(e) => setUseMusePrediction(e.target.checked)}
                disabled={!predictedEmotion}
                className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <label
                htmlFor="use-muse"
                className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Use Muse Prediction
                {predictedEmotion && ` (${predictedEmotion})`}
              </label>
            </div>

            {/* Manual Dropdown */}
            <div className="flex flex-col gap-2">
              <label
                htmlFor="emotion-select"
                className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Manual Override
              </label>
              <select
                id="emotion-select"
                value={selectedEmotion}
                onChange={(e) => {
                  setSelectedEmotion(e.target.value);
                  setUseMusePrediction(false);
                }}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-base text-black focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
              >
                {emotions.map((emotion) => (
                  <option key={emotion.name} value={emotion.name}>
                    {emotion.name.charAt(0).toUpperCase() + emotion.name.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

          {/* Right Side - Spotify Player */}
          <div className="flex flex-1 items-center justify-center border-l border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
            <Player ref={playerRef} emotion={useMusePrediction && predictedEmotion ? predictedEmotion.toLowerCase() : selectedEmotion} likeDislike={likeDislike} onTrackChange={handleTrackChange} />
          </div>
        </div>

        {/* Bottom Section - EEG + PPG Visualization */}
        <div className="border-t border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950" style={{ height: '460px' }}>
          <EEGVisualization eegData={eegData} ppgData={ppgData} ppgAvailable={ppgAvailable} maxDataPoints={512} />
        </div>
      </main>
    </div>
  );
}
