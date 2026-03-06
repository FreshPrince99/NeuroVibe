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

const toFinite = (value: number | null | undefined, fallback = 0) => (
  Number.isFinite(value) ? Number(value) : fallback
);

const clamp = (value: number, min = 0, max = 1) => {
  const safeValue = toFinite(value, min);
  return Math.max(min, Math.min(max, safeValue));
};

function stdDev(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return Math.sqrt(variance);
}

function average(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function calculateBrainMetrics(eegData: EEGData[], ppgData: number[], predictedVAD?: VADData | null) {
  const window = eegData.slice(-96).map((sample) => ({
    tp9: toFinite(sample.tp9),
    af7: toFinite(sample.af7),
    af8: toFinite(sample.af8),
    tp10: toFinite(sample.tp10),
  }));

  const af7 = window.map((sample) => sample.af7);
  const af8 = window.map((sample) => sample.af8);
  const tp9 = window.map((sample) => sample.tp9);
  const tp10 = window.map((sample) => sample.tp10);

  const af7Energy = average(af7.map((value) => Math.abs(value)));
  const af8Energy = average(af8.map((value) => Math.abs(value)));
  const tp9Energy = average(tp9.map((value) => Math.abs(value)));
  const tp10Energy = average(tp10.map((value) => Math.abs(value)));

  const frontalEnergy = (af7Energy + af8Energy) / 2;
  const temporalEnergy = (tp9Energy + tp10Energy) / 2;
  const asymmetry = Math.abs(af7Energy - af8Energy) / Math.max(frontalEnergy, 1e-6);
  const symmetry = clamp(1 - asymmetry);

  const overallStd = stdDev(window.flatMap((sample) => [sample.tp9, sample.af7, sample.af8, sample.tp10]).map((value) => Math.abs(value)));
  const stability = clamp(1 - overallStd / 250);

  // Frontal engagement: ratio of frontal to total power, stretched from [0.3,1] → [0,1].
  // The old formula added constants (+1/+2) that swamped small EEG amplitudes — fixed here.
  const frontalRatio = frontalEnergy / Math.max(frontalEnergy + temporalEnergy, 1e-6);
  const engagement = clamp((frontalRatio - 0.3) / 0.7);

  const arousal = clamp(toFinite(predictedVAD?.arousal, 0.5));
  const valence = clamp(toFinite(predictedVAD?.valence, 0.5));

  const focus = clamp(0.45 * engagement + 0.35 * stability + 0.2 * arousal);
  const calm = clamp(0.4 * symmetry + 0.4 * (1 - arousal) + 0.2 * stability);
  const control = clamp((focus + calm + valence) / 3);

  const ppgWindow = ppgData.slice(-160).map((value) => toFinite(value));
  const ppgDiff = ppgWindow.slice(1).map((value, index) => Math.abs(value - ppgWindow[index]));
  // Coefficient of variation: lower CV = smoother pulse = better regulation.
  // Old formula added +8 to denominator which capped the score unreliably.
  const ppgMean = average(ppgDiff);
  const ppgCV = ppgMean > 1e-6 ? stdDev(ppgDiff) / ppgMean : 1;
  const ppgRegulation = ppgWindow.length > 20 ? clamp(1 - Math.min(ppgCV, 1)) : 0;

  return {
    focus,
    calm,
    control,
    symmetry,
    stability,
    ppgRegulation,
  };
}

function RunningVisualization({ selectedActivity, progressValue, metrics, ppgData }: {
  selectedActivity: ActivityId;
  progressValue: number;
  metrics: ReturnType<typeof calculateBrainMetrics>;
  ppgData: number[];
}) {
  if (selectedActivity === 'neural-ball') {
    // Colour shifts blue → cyan → green → gold as progress rises
    const hue = Math.round(200 + progressValue * 40);       // 200→240 blue range
    const glow = Math.round(progressValue * 80);
    const rings = [1.6, 1.3, 1.0];
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="relative flex h-72 w-72 items-center justify-center">
          {rings.map((scale, i) => (
            <div
              key={i}
              className="absolute rounded-full border border-cyan-400/30"
              style={{
                width: `${scale * (0.7 + progressValue * 0.5) * 200}px`,
                height: `${scale * (0.7 + progressValue * 0.5) * 200}px`,
                opacity: 0.3 - i * 0.08,
                transition: 'all 450ms ease',
              }}
            />
          ))}
          <div
            className="flex items-center justify-center rounded-full text-2xl font-bold text-white"
            style={{
              width: `${(0.7 + progressValue * 0.5) * 200}px`,
              height: `${(0.7 + progressValue * 0.5) * 200}px`,
              background: `radial-gradient(circle, hsl(${hue},80%,60%) 0%, hsl(${hue},60%,30%) 100%)`,
              boxShadow: `0 0 ${glow}px hsl(${hue},80%,60%)`,
              transition: 'all 450ms ease',
            }}
          >
            {Math.round(progressValue * 100)}%
          </div>
        </div>
        <div className="grid w-full max-w-xs grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-gray-700 bg-black/40 p-3">Focus<br /><span className="text-lg text-cyan-300">{Math.round(metrics.focus * 100)}%</span></div>
          <div className="rounded-lg border border-gray-700 bg-black/40 p-3">Calm<br /><span className="text-lg text-cyan-300">{Math.round(metrics.calm * 100)}%</span></div>
        </div>
      </div>
    );
  }

  if (selectedActivity === 'neuro-drive') {
    const speed = Math.round(progressValue * 180);
    // Car drifts when stability is LOW (not high — was previously inverted)
    const drift = (0.5 - metrics.stability) * 120;
    // Road scroll speed: faster at higher brain speed
    const scrollDuration = Math.max(700 - speed * 3.5, 80);

    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <style>{`
          @keyframes road-scroll {
            from { background-position-y: 0; }
            to   { background-position-y: 120px; }
          }
        `}</style>

        {/* Road viewport */}
        <div className="relative h-64 overflow-hidden rounded-2xl border border-gray-700 bg-gray-950">
          {/* Sky gradient */}
          <div className="absolute inset-0 bg-gradient-to-b from-gray-900 via-gray-950 to-black" />

          {/* Road surface */}
          <div className="absolute bottom-0 left-[25%] right-[25%] top-[40%] rounded-t-[60%] bg-gray-700/60" />

          {/* Scrolling road dashes */}
          <div
            className="absolute bottom-0 left-1/2 w-3 -translate-x-1/2"
            style={{
              top: '40%',
              backgroundImage: 'repeating-linear-gradient(to bottom, white 0px, white 20px, transparent 20px, transparent 40px)',
              backgroundSize: '100% 40px',
              animation: `road-scroll ${scrollDuration}ms linear infinite`,
              opacity: 0.7,
            }}
          />

          {/* Road edge lines */}
          <div className="absolute bottom-0 top-[40%] w-0.5 bg-yellow-400/70" style={{ left: '26%' }} />
          <div className="absolute bottom-0 top-[40%] w-0.5 bg-yellow-400/70" style={{ right: '26%' }} />

          {/* Car */}
          <div
            className="absolute bottom-6 transition-all duration-300"
            style={{ left: `calc(50% - 28px + ${drift}px)` }}
          >
            {/* Car body */}
            <div className="relative h-14 w-14 rounded-t-2xl rounded-b-lg bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.6)]">
              {/* Windscreen */}
              <div className="absolute inset-x-2 top-1 h-4 rounded-t-xl bg-cyan-200/40" />
              {/* Wheels */}
              <div className="absolute -bottom-1.5 -left-2 h-4 w-4 rounded-full bg-gray-800 ring-2 ring-gray-500" />
              <div className="absolute -bottom-1.5 -right-2 h-4 w-4 rounded-full bg-gray-800 ring-2 ring-gray-500" />
              {/* Headlights */}
              <div className="absolute -top-0.5 left-1.5 h-2 w-2 rounded-full bg-yellow-200 shadow-[0_0_6px_white]" />
              <div className="absolute -top-0.5 right-1.5 h-2 w-2 rounded-full bg-yellow-200 shadow-[0_0_6px_white]" />
            </div>
          </div>

          {/* Speed HUD */}
          <div className="absolute right-4 top-4 rounded-xl border border-blue-400/30 bg-black/60 px-4 py-2 text-center">
            <p className="text-2xl font-bold text-blue-300">{speed}</p>
            <p className="text-xs text-gray-400">km/h</p>
          </div>

          {/* Stability warning */}
          {metrics.stability < 0.35 && (
            <div className="absolute left-4 top-4 animate-pulse rounded-lg border border-red-500/60 bg-red-500/20 px-3 py-1 text-xs text-red-300">
              ⚠ Unstable
            </div>
          )}
        </div>

        {/* Gauges */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-gray-700 bg-black/50 p-3">
            <p className="text-gray-400">Speed</p>
            <p className="mt-1 text-xl text-blue-300">{speed} km/h</p>
            <div className="mt-2 h-1.5 rounded-full bg-gray-800">
              <div className="h-full rounded-full bg-blue-400 transition-all duration-300" style={{ width: `${Math.min(speed / 180 * 100, 100)}%` }} />
            </div>
          </div>
          <div className="rounded-xl border border-gray-700 bg-black/50 p-3">
            <p className="text-gray-400">Stability</p>
            <p className="mt-1 text-xl text-green-300">{Math.round(metrics.stability * 100)}%</p>
            <div className="mt-2 h-1.5 rounded-full bg-gray-800">
              <div className="h-full rounded-full bg-green-400 transition-all duration-300" style={{ width: `${Math.round(metrics.stability * 100)}%` }} />
            </div>
          </div>
          <div className="rounded-xl border border-gray-700 bg-black/50 p-3">
            <p className="text-gray-400">Control</p>
            <p className="mt-1 text-xl text-purple-300">{Math.round(metrics.control * 100)}%</p>
            <div className="mt-2 h-1.5 rounded-full bg-gray-800">
              <div className="h-full rounded-full bg-purple-400 transition-all duration-300" style={{ width: `${Math.round(metrics.control * 100)}%` }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (selectedActivity === 'signal-shield') {
    const shieldOpacity = 0.2 + progressValue * 0.8;
    const shieldScale = 0.8 + metrics.symmetry * 0.35;
    const shieldColor = progressValue > 0.7 ? '#34d399' : progressValue > 0.4 ? '#60a5fa' : '#f472b6';
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 rounded-2xl border border-emerald-400/30 bg-emerald-500/5 p-6">
        <div className="relative flex h-64 w-64 items-center justify-center">
          {/* Outer rotating ring only when symmetry is high */}
          {metrics.symmetry > 0.6 && (
            <div
              className="absolute h-72 w-72 rounded-full border border-dashed border-emerald-400/40"
              style={{ animation: `spin ${3 - metrics.symmetry * 2}s linear infinite` }}
            />
          )}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div
            className="absolute transition-all duration-300"
            style={{ transform: `scale(${shieldScale})`, opacity: shieldOpacity }}
          >
            <svg viewBox="0 0 100 120" width="200" height="240">
              <path
                d="M50 5 L95 25 L95 65 Q95 95 50 115 Q5 95 5 65 L5 25 Z"
                fill="none"
                stroke={shieldColor}
                strokeWidth="3"
                filter="url(#glow)"
              />
              <defs>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="2" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <path
                d="M50 15 L85 30 L85 65 Q85 90 50 107 Q15 90 15 65 L15 30 Z"
                fill={shieldColor}
                fillOpacity="0.08"
                stroke={shieldColor}
                strokeWidth="1.5"
                strokeOpacity="0.4"
              />
            </svg>
          </div>
          <span className="text-3xl font-bold" style={{ color: shieldColor }}>
            {Math.round(progressValue * 100)}%
          </span>
        </div>
        <div className="grid w-full grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
            Shield Strength<br />
            <span className="text-xl text-emerald-300">{Math.round(progressValue * 100)}%</span>
            <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-emerald-400 transition-all duration-300" style={{ width: `${Math.round(progressValue * 100)}%` }} /></div>
          </div>
          <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
            Frontal Symmetry<br />
            <span className="text-xl text-emerald-300">{Math.round(metrics.symmetry * 100)}%</span>
            <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-teal-400 transition-all duration-300" style={{ width: `${Math.round(metrics.symmetry * 100)}%` }} /></div>
          </div>
        </div>
      </div>
    );
  }

  // ── Pulse Pilot ────────────────────────────────────────────────────────
  const wavePoints = ppgData.slice(-120);
  const waveMin  = Math.min(...wavePoints, 0);
  const waveMax  = Math.max(...wavePoints, 1);
  const waveRange = Math.max(waveMax - waveMin, 1);
  const svgH = 160;
  const svgW = 400;
  const points = wavePoints.map((v, i) => {
    const x = (i / Math.max(wavePoints.length - 1, 1)) * svgW;
    const y = svgH - ((v - waveMin) / waveRange) * (svgH - 16) - 8;
    return `${x},${y}`;
  }).join(' ');

  const regulationColor = metrics.ppgRegulation > 0.7 ? '#f87171' : metrics.ppgRegulation > 0.4 ? '#fb923c' : '#94a3b8';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 rounded-2xl border border-rose-400/40 bg-rose-500/5 p-6">
      {/* Live PPG waveform */}
      <div className="relative overflow-hidden rounded-xl border border-gray-700 bg-black">
        <p className="absolute left-3 top-2 text-xs text-gray-500 uppercase tracking-widest">PPG Waveform</p>
        {wavePoints.length > 2 ? (
          <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-44 w-full" preserveAspectRatio="none">
            <polyline
              points={points}
              fill="none"
              stroke={regulationColor}
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {/* Glow duplicate */}
            <polyline
              points={points}
              fill="none"
              stroke={regulationColor}
              strokeWidth="6"
              strokeLinejoin="round"
              opacity="0.15"
            />
          </svg>
        ) : (
          <div className="flex h-44 items-center justify-center text-gray-600 text-sm">Waiting for PPG data…</div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          Pulse Smoothness<br />
          <span className="text-xl text-rose-300">{Math.round(metrics.ppgRegulation * 100)}%</span>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-rose-400 transition-all duration-300" style={{ width: `${Math.round(metrics.ppgRegulation * 100)}%` }} /></div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          Calm<br />
          <span className="text-xl text-rose-300">{Math.round(metrics.calm * 100)}%</span>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-pink-400 transition-all duration-300" style={{ width: `${Math.round(metrics.calm * 100)}%` }} /></div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          Neural Control<br />
          <span className="text-xl text-rose-300">{Math.round(metrics.control * 100)}%</span>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-orange-400 transition-all duration-300" style={{ width: `${Math.round(metrics.control * 100)}%` }} /></div>
        </div>
      </div>
    </div>
  );
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
      {
        focus: clamp(metrics.focus),
        calm: clamp(metrics.calm),
        control: clamp(metrics.control),
        ppg: clamp(metrics.ppgRegulation),
        symmetry: clamp(metrics.symmetry),
      },
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

  const avgFocus = average(sessionStats.map((sample) => sample.focus));
  const avgCalm = average(sessionStats.map((sample) => sample.calm));
  const avgControl = average(sessionStats.map((sample) => sample.control));
  const avgPpg = average(sessionStats.map((sample) => sample.ppg));
  const avgSymmetry = average(sessionStats.map((sample) => sample.symmetry));

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
                  onChange={(event) => setDurationMinutes(parseInt(event.target.value, 10))}
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

            <RunningVisualization selectedActivity={selectedActivity} progressValue={progressValue} metrics={metrics} ppgData={ppgData} />

            <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Focus<br />{Math.round(clamp(metrics.focus) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Calm<br />{Math.round(clamp(metrics.calm) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Control<br />{Math.round(clamp(metrics.control) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">PPG Reg.<br />{Math.round(clamp(metrics.ppgRegulation) * 100)}%</div>
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
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Average Focus <p className="mt-2 text-2xl">{Math.round(clamp(avgFocus) * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Average Calm <p className="mt-2 text-2xl">{Math.round(clamp(avgCalm) * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Cognitive Control <p className="mt-2 text-2xl">{Math.round(clamp(avgControl) * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Frontal Symmetry <p className="mt-2 text-2xl">{Math.round(clamp(avgSymmetry) * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">PPG Regulation <p className="mt-2 text-2xl">{Math.round(clamp(avgPpg) * 100)}%</p></div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">Peak Activity Score <p className="mt-2 text-2xl">{Math.round(clamp(peakValue) * 100)}%</p></div>
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
