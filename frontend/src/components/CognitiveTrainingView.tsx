'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface EEGData {
  tp9: number;
  af7: number;
  af8: number;
  tp10: number;
  timestamp: number;
}

interface VADData {
  valence: number;
  arousal: number;
  dominance: number;
}

type ActivityId = 'neural-ball' | 'neuro-drive' | 'signal-shield' | 'pulse-pilot';
type Phase = 'select' | 'running' | 'results';

interface CognitiveTrainingViewProps {
  eegData: EEGData[];
  ppgData: number[];
  predictedVAD?: VADData | null;
  connectionStatus: string;
  sampleCount: number;
  needsConnect?: boolean;
  isConnecting?: boolean;
  onConnect?: () => void;
  onBackToHome?: () => void;
  onPauseToggle: () => void;
  isPaused: boolean;
}

const ACTIVITIES: Array<{ id: ActivityId; title: string; description: string; channels: string }> = [
  {
    id: 'neural-ball',
    title: 'Neural Expansion Ball',
    description: 'Wear the headset and grow the sphere by sustaining focus + calm control for 3–5 minutes.',
    channels: 'AF7 • AF8 • TP9 • TP10 • VAD',
  },
  {
    id: 'neuro-drive',
    title: 'Neuro Drive',
    description: 'Drive a car with your brain. Speed rises with steady focus and drops with unstable signals.',
    channels: 'AF7 • AF8 • TP9 • TP10 • VAD',
  },
  {
    id: 'signal-shield',
    title: 'Signal Shield',
    description: 'Keep a shield strong by balancing frontal symmetry and temporal stability under pressure.',
    channels: 'AF7 • AF8 • TP9 • TP10',
  },
  {
    id: 'pulse-pilot',
    title: 'Pulse Pilot',
    description: 'Regulate your heart-wave rhythm (Muse 2 PPG) while staying mentally stable.',
    channels: 'PPG • AF7 • AF8 • TP9 • TP10 • VAD',
  },
];

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function stdDev(values: number[]) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function calculateBrainMetrics(eegData: EEGData[], ppgData: number[], predictedVAD?: VADData | null) {
  const window = eegData.slice(-96);

  const af7 = window.map((x) => x.af7);
  const af8 = window.map((x) => x.af8);
  const tp9 = window.map((x) => x.tp9);
  const tp10 = window.map((x) => x.tp10);

  const af7Energy = average(af7.map((v) => Math.abs(v)));
  const af8Energy = average(af8.map((v) => Math.abs(v)));
  const tp9Energy = average(tp9.map((v) => Math.abs(v)));
  const tp10Energy = average(tp10.map((v) => Math.abs(v)));

  const frontalEnergy = (af7Energy + af8Energy) / 2;
  const temporalEnergy = (tp9Energy + tp10Energy) / 2;
  const asymmetry = Math.abs(af7Energy - af8Energy) / (frontalEnergy + 1e-6);
  const symmetry = clamp(1 - asymmetry);

  const overallStd = stdDev(window.flatMap((s) => [s.tp9, s.af7, s.af8, s.tp10]).map((v) => Math.abs(v)));
  const stability = clamp(1 - overallStd / 250);
  const engagement = clamp((frontalEnergy + 1) / (temporalEnergy + frontalEnergy + 2));

  const arousal = predictedVAD?.arousal ?? 0.5;
  const valence = predictedVAD?.valence ?? 0.5;

  const focus = clamp(0.45 * engagement + 0.35 * stability + 0.2 * arousal);
  const calm = clamp(0.4 * symmetry + 0.4 * (1 - arousal) + 0.2 * stability);
  const control = clamp((focus + calm + valence) / 3);

  const ppgWindow = ppgData.slice(-160);
  const ppgDiff = ppgWindow.slice(1).map((value, index) => Math.abs(value - ppgWindow[index]));
  const ppgRegulation = ppgWindow.length > 20
    ? clamp(1 - stdDev(ppgDiff) / (average(ppgDiff) + 8))
    : 0;

  return {
    focus,
    calm,
    control,
    symmetry,
    stability,
    ppgRegulation,
  };
}

export default function CognitiveTrainingView({
  eegData,
  ppgData,
  predictedVAD,
  connectionStatus,
  sampleCount,
  needsConnect = false,
  isConnecting = false,
  onConnect,
  onBackToHome,
  onPauseToggle,
  isPaused,
}: CognitiveTrainingViewProps) {
  const [phase, setPhase] = useState<Phase>('select');
  const [selectedActivity, setSelectedActivity] = useState<ActivityId>('neural-ball');
  const [durationMinutes, setDurationMinutes] = useState(3);
  const [remainingSeconds, setRemainingSeconds] = useState(durationMinutes * 60);
  const [progressValue, setProgressValue] = useState(0.25);
  const [sessionStats, setSessionStats] = useState<Array<{ focus: number; calm: number; control: number; ppg: number; symmetry: number }>>([]);
  const [peakValue, setPeakValue] = useState(0);
  const metrics = useMemo(() => calculateBrainMetrics(eegData, ppgData, predictedVAD), [eegData, ppgData, predictedVAD]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedMeta = ACTIVITIES.find((activity) => activity.id === selectedActivity)!;

  useEffect(() => {
    setRemainingSeconds(durationMinutes * 60);
  }, [durationMinutes]);

  useEffect(() => {
    if (phase !== 'running') return;

    const newProgress = (() => {
      if (selectedActivity === 'neural-ball') return clamp(metrics.focus * 0.55 + metrics.calm * 0.45);
      if (selectedActivity === 'neuro-drive') return clamp(metrics.focus * 0.7 + metrics.control * 0.3);
      if (selectedActivity === 'signal-shield') return clamp(metrics.symmetry * 0.5 + metrics.stability * 0.5);
      return clamp(metrics.ppgRegulation * 0.55 + metrics.calm * 0.25 + metrics.control * 0.2);
    })();

    setProgressValue(newProgress);
    setPeakValue((previous) => Math.max(previous, newProgress));
    setSessionStats((previous) => [
      ...previous,
      { focus: metrics.focus, calm: metrics.calm, control: metrics.control, ppg: metrics.ppgRegulation, symmetry: metrics.symmetry },
    ].slice(-1000));
  }, [metrics, phase, selectedActivity]);

  useEffect(() => {
    if (phase !== 'running') return;

    tickRef.current = setInterval(() => {
      setRemainingSeconds((previous) => {
        if (previous <= 1) {
          if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
          }
          setPhase('results');
          return 0;
        }
        return previous - 1;
      });
    }, 1000);

    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [phase]);

  const startSession = () => {
    setSessionStats([]);
    setPeakValue(0);
    setProgressValue(0.25);
    setRemainingSeconds(durationMinutes * 60);
    setPhase('running');
  };

  const finishEarly = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setPhase('results');
  };

  const resetToSelection = () => {
    setPhase('select');
    setRemainingSeconds(durationMinutes * 60);
    setSessionStats([]);
    setPeakValue(0);
  };

  const avgFocus = average(sessionStats.map((x) => x.focus));
  const avgCalm = average(sessionStats.map((x) => x.calm));
  const avgControl = average(sessionStats.map((x) => x.control));
  const avgPpg = average(sessionStats.map((x) => x.ppg));
  const avgSymmetry = average(sessionStats.map((x) => x.symmetry));

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="w-full border-b border-zinc-800 bg-black py-4">
        <div className="container mx-auto flex items-center justify-between px-8">
          <button onClick={onBackToHome} className="text-3xl font-light hover:text-gray-300">NeuroVibe</button>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-400">{sampleCount} samples</span>
            <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-4 py-1 text-cyan-200">{connectionStatus}</span>
            <button
              onClick={onPauseToggle}
              className={`rounded-lg px-4 py-2 font-semibold ${isPaused ? 'bg-green-500 text-white' : 'bg-orange-500 text-white'}`}
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
          </div>
        </div>
      </header>

      {isConnecting && !needsConnect && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center">Connecting to Muse…</div>
        </div>
      )}

      {needsConnect && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center">
            <p className="mb-4 text-5xl">📡</p>
            <h2 className="mb-3 text-2xl font-semibold">Connect Muse Headset</h2>
            <p className="mb-5 text-gray-400">This mode needs EEG + PPG streams for brain training metrics.</p>
            <button onClick={onConnect} className="w-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500 px-6 py-3 font-semibold">Connect Muse Headset</button>
          </div>
        </div>
      )}

      <main className="container mx-auto px-6 py-10">
        {phase === 'select' && (
          <div className="space-y-8">
            <div className="text-center">
              <h1 className="text-4xl font-light">Improve Cognitive Power</h1>
              <p className="mx-auto mt-3 max-w-3xl text-gray-400">Choose a brain activity. After each run you will get a performance breakdown from every available Muse channel (TP9, AF7, AF8, TP10), VAD state, and PPG regulation when available.</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {ACTIVITIES.map((activity) => (
                <button
                  key={activity.id}
                  onClick={() => setSelectedActivity(activity.id)}
                  className={`rounded-2xl border p-6 text-left transition-colors ${selectedActivity === activity.id ? 'border-fuchsia-400 bg-fuchsia-500/10' : 'border-gray-800 bg-gray-900/40 hover:border-gray-600'}`}
                >
                  <h3 className="text-xl font-medium">{activity.title}</h3>
                  <p className="mt-2 text-sm text-gray-300">{activity.description}</p>
                  <p className="mt-3 text-xs uppercase tracking-widest text-fuchsia-300">Signals: {activity.channels}</p>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-gray-800 bg-gray-900/40 p-6">
              <label className="text-sm text-gray-300">Duration
                <select
                  className="ml-3 rounded-lg border border-gray-700 bg-black px-3 py-2"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(parseInt(e.target.value, 10))}
                >
                  {[3, 4, 5].map((option) => <option key={option} value={option}>{option} minutes</option>)}
                </select>
              </label>
              <button onClick={startSession} className="rounded-full bg-white px-6 py-3 font-semibold text-black">Start Activity</button>
            </div>
          </div>
        )}

        {phase === 'running' && (
          <div className="space-y-8 text-center">
            <div>
              <h2 className="text-3xl font-light">{selectedMeta.title}</h2>
              <p className="mt-2 text-gray-400">{selectedMeta.description}</p>
              <p className="mt-2 text-sm text-fuchsia-300">{Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, '0')} remaining</p>
            </div>

            <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-full border border-fuchsia-400/50 bg-fuchsia-500/10" style={{ transform: `scale(${0.7 + progressValue * 0.8})`, transition: 'transform 450ms ease' }}>
              <span className="text-2xl font-semibold">{Math.round(progressValue * 100)}%</span>
            </div>

            <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Focus<br />{Math.round(metrics.focus * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Calm<br />{Math.round(metrics.calm * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Control<br />{Math.round(metrics.control * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">PPG Reg.<br />{Math.round(metrics.ppgRegulation * 100)}%</div>
            </div>

            <button onClick={finishEarly} className="rounded-full border border-gray-700 px-6 py-2 text-sm text-gray-300">Finish now</button>
          </div>
        )}

        {phase === 'results' && (
          <div className="mx-auto max-w-4xl space-y-8">
            <div className="text-center">
              <h2 className="text-4xl font-light">Session Results</h2>
              <p className="mt-2 text-gray-400">Useful state summary from your selected cognitive activity.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Average Focus <p className="mt-2 text-2xl">{Math.round(avgFocus * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Average Calm <p className="mt-2 text-2xl">{Math.round(avgCalm * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Cognitive Control <p className="mt-2 text-2xl">{Math.round(avgControl * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Frontal Symmetry <p className="mt-2 text-2xl">{Math.round(avgSymmetry * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">PPG Regulation <p className="mt-2 text-2xl">{Math.round(avgPpg * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Peak Activity Score <p className="mt-2 text-2xl">{Math.round(peakValue * 100)}%</p></div>
            </div>

            <div className="rounded-2xl border border-fuchsia-500/40 bg-fuchsia-500/10 p-5 text-sm text-fuchsia-100">
              Interpretation: Focus = frontal engagement and channel stability, Calm = low arousal + symmetry, Control = combined regulation score, PPG Regulation = pulse smoothness control.
            </div>

            <div className="flex items-center justify-center gap-4">
              <button onClick={resetToSelection} className="rounded-full bg-white px-6 py-3 font-semibold text-black">Choose another activity</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
