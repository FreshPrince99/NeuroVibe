'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { setCognitiveData, addEEGSnapshot } from '@/lib/sessionStore';

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
  onStopSession?: () => void;
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

function getActivityInsights(
  activity: ActivityId,
  avgFocus: number,
  avgCalm: number,
  avgControl: number,
  symmetry: number,
  ppg: number,
  peakValue: number,
  lapTimeSeconds?: number | null,
): { title: string; insight: string; quality: 'excellent' | 'good' | 'fair' | 'needs-work'; score: number } {
  if (activity === 'neural-ball') {
    const balanceScore = Math.abs(avgFocus - avgCalm);
    const quality = balanceScore < 0.15 ? 'excellent' : balanceScore < 0.25 ? 'good' : balanceScore < 0.35 ? 'fair' : 'needs-work';
    return {
      title: 'Expansion Balance',
      insight: `Focus and calm were ${balanceScore < 0.15 ? 'well-balanced' : balanceScore < 0.25 ? 'reasonably balanced' : 'imbalanced'}. ${avgFocus > avgCalm ? 'You were more focused than relaxed.' : 'You were more relaxed than focused.'} The sphere reached ${Math.round(peakValue * 100)}% at peak.`,
      quality,
      score: (avgFocus * 0.55 + avgCalm * 0.45),
    };
  }
  if (activity === 'neuro-drive') {
    const speed = Math.round(avgControl * 180);
    const quality = lapTimeSeconds && lapTimeSeconds < 120 ? 'excellent' : lapTimeSeconds && lapTimeSeconds < 180 ? 'good' : lapTimeSeconds && lapTimeSeconds < 240 ? 'fair' : 'needs-work';
    return {
      title: 'Racing Performance',
      insight: `You completed the race in ${lapTimeSeconds?.toFixed(2)}s at average speed ${speed} km/h. ${lapTimeSeconds && lapTimeSeconds < 120 ? 'Excellent control and focus!' : lapTimeSeconds && lapTimeSeconds < 180 ? 'Good steady performance.' : 'Try maintaining focus for better lap times.'}`,
      quality,
      score: lapTimeSeconds ? clamp(1 - lapTimeSeconds / 300) : 0,
    };
  }
  if (activity === 'signal-shield') {
    const symmetryQuality = symmetry > 0.7 ? 'excellent' : symmetry > 0.55 ? 'good' : symmetry > 0.4 ? 'fair' : 'needs-work';
    return {
      title: 'Frontal Balance Mastery',
      insight: `Frontal symmetry: ${Math.round(symmetry * 100)}% (${['excellent', 'good', 'fair', 'needs-work'][['excellent', 'good', 'fair', 'needs-work'].indexOf(symmetryQuality)]}). Your hemispheres were ${symmetry > 0.7 ? 'well-synchronized' : symmetry > 0.55 ? 'reasonably balanced' : 'asymmetric'}. Peak strength: ${Math.round(peakValue * 100)}%.`,
      quality: symmetryQuality as 'excellent' | 'good' | 'fair' | 'needs-work',
      score: symmetry,
    };
  }
  // pulse-pilot
  const hrvQuality = ppg > 0.7 ? 'excellent' : ppg > 0.55 ? 'good' : ppg > 0.4 ? 'fair' : 'needs-work';
  return {
    title: 'Vagal Tone Development',
    insight: `Heart rhythm stability: ${Math.round(ppg * 100)}% (${hrvQuality}). ${ppg > 0.7 ? 'Strong parasympathetic tone — excellent stress resilience.' : ppg > 0.55 ? 'Good vagal control. Keep practicing.' : 'Pulse was erratic. Try deeper breathing.'}`,
    quality: hrvQuality,
    score: ppg,
  };
}

function SessionGraph({ data }: { data: Array<{ focus: number; calm: number; control: number }> }) {
  if (data.length === 0) return null;
  const svgW = 600;
  const svgH = 240;
  const padding = 40;
  const graphW = svgW - padding * 2;
  const graphH = svgH - padding * 2;

  const points = data.map((sample, i) => ({
    x: padding + (i / Math.max(data.length - 1, 1)) * graphW,
    focus: padding + graphH - clamp(sample.focus) * graphH,
    calm: padding + graphH - clamp(sample.calm) * graphH,
    control: padding + graphH - clamp(sample.control) * graphH,
  }));

  const focusPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.focus}`).join(' ');
  const calmPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.calm}`).join(' ');
  const controlPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.control}`).join(' ');

  return (
    <div className="rounded-xl border border-gray-700 bg-black/30 p-4">
      <p className="mb-4 text-sm font-semibold text-gray-300">Session Progression</p>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full">
        <defs>
          <linearGradient id="gridGrad" x1="0%" x2="100%">
            <stop offset="0%" stopColor="rgba(100,100,150,0.1)" />
            <stop offset="100%" stopColor="rgba(100,100,150,0.05)" />
          </linearGradient>
        </defs>
        
        {/* Grid background */}
        <rect x={padding} y={padding} width={graphW} height={graphH} fill="url(#gridGrad)" />
        
        {/* Axis labels */}
        <text x={padding - 30} y={padding + graphH + 5} fontSize="11" fill="#888">0%</text>
        <text x={padding - 30} y={padding + 10} fontSize="11" fill="#888">100%</text>
        
        {/* Control line */}
        <path d={controlPath} stroke="#a855f7" strokeWidth="2" fill="none" />
        
        {/* Focus line */}
        <path d={focusPath} stroke="#06b6d4" strokeWidth="2" fill="none" />
        
        {/* Calm line */}
        <path d={calmPath} stroke="#ec4899" strokeWidth="2" fill="none" />
      </svg>
      <div className="mt-3 flex gap-4 text-xs">
        <div className="flex items-center gap-2"><div className="h-2 w-2 rounded-full bg-cyan-400" />Focus</div>
        <div className="flex items-center gap-2"><div className="h-2 w-2 rounded-full bg-pink-400" />Calm</div>
        <div className="flex items-center gap-2"><div className="h-2 w-2 rounded-full bg-purple-400" />Control</div>
      </div>
    </div>
  );
}

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

function RunningVisualization({ selectedActivity, progressValue, metrics, ppgData, lapTimeSeconds }: {
  selectedActivity: ActivityId;
  progressValue: number;
  metrics: ReturnType<typeof calculateBrainMetrics>;
  ppgData: number[];
  lapTimeSeconds?: number | null;
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
    const speed = Math.round(clamp(progressValue) * 220);
    const raceProgress = clamp(progressValue) * 100;
    const isFinished = progressValue >= 1.0;
    const drift = (0.5 - metrics.stability) * 76;
    const laneHalfWidth = 88;
    const edgeWarning = Math.abs(drift) > laneHalfWidth * 0.82;
    const scrollMs = Math.max(1200 - speed * 4, 240);
    const engineMs = Math.max(650 - speed * 1.6, 220);
    const speedStrength = clamp(speed / 220);
    const flameLength = 8 + speedStrength * 18;
    const remainingMeters = Math.max(0, Math.round((1 - clamp(progressValue)) * 100));

    return (
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <style>{`
          @keyframes neuro-track-scroll {
            from { background-position-y: 0; }
            to   { background-position-y: 220px; }
          }
          @keyframes neuro-engine-thrum {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-2px); }
          }
          @keyframes neuro-speed-line {
            from { transform: translateY(0); opacity: 0; }
            15% { opacity: 1; }
            to { transform: translateY(18px); opacity: 0; }
          }
          @keyframes neuro-pulse-dot {
            0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6); }
            70% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
          }
        `}</style>

        <div className="relative overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950 p-4">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(56,189,248,0.15),transparent_45%),linear-gradient(to_bottom,rgba(30,41,59,0.7),rgba(2,6,23,0.9))]" />

          <div className="relative h-[30rem] overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900">
            <div
              className="absolute inset-0"
              style={{
                clipPath: 'polygon(14% 100%, 86% 100%, 62% 0%, 38% 0%)',
                background: 'linear-gradient(to bottom, rgba(71,85,105,0.35), rgba(15,23,42,0.95))',
              }}
            />

            <div
              className="absolute inset-0"
              style={{
                clipPath: 'polygon(14% 100%, 86% 100%, 62% 0%, 38% 0%)',
                backgroundImage: 'repeating-linear-gradient(to bottom, rgba(148,163,184,0.22) 0px, rgba(148,163,184,0.22) 6px, rgba(15,23,42,0) 6px, rgba(15,23,42,0) 34px)',
                animation: `neuro-track-scroll ${scrollMs}ms linear infinite`,
              }}
            />

            <div className="absolute inset-y-0 left-[14%] w-2 bg-gradient-to-b from-amber-200/80 via-amber-300/50 to-amber-400/70" />
            <div className="absolute inset-y-0 right-[14%] w-2 bg-gradient-to-b from-amber-200/80 via-amber-300/50 to-amber-400/70" />

            <div
              className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2"
              style={{
                backgroundImage: 'repeating-linear-gradient(to bottom, rgba(226,232,240,0.95) 0px, rgba(226,232,240,0.95) 20px, transparent 20px, transparent 58px)',
                animation: `neuro-track-scroll ${Math.max(scrollMs * 0.75, 180)}ms linear infinite`,
              }}
            />

            <div className="absolute left-[34%] right-[34%] top-4 h-6 rounded bg-[repeating-linear-gradient(90deg,#111827_0_10px,#e5e7eb_10px_20px)] ring-1 ring-white/35" />
            <p className="absolute left-1/2 top-4 -translate-x-1/2 text-[10px] font-bold tracking-[0.35em] text-slate-100">FINISH</p>

            <div className="absolute left-4 top-4 rounded-lg border border-cyan-300/40 bg-slate-950/75 px-3 py-2 backdrop-blur-sm">
              <p className="text-[10px] tracking-[0.2em] text-cyan-200">SPEED</p>
              <p className="text-2xl font-semibold text-cyan-100">{speed}<span className="ml-1 text-xs font-normal text-cyan-300">km/h</span></p>
            </div>

            <div className="absolute right-4 top-4 w-20 rounded-lg border border-slate-600/70 bg-slate-950/80 p-2 text-center backdrop-blur-sm">
              <p className="text-[10px] tracking-[0.18em] text-slate-300">TRACK</p>
              <div className="mx-auto mt-2 h-36 w-3 rounded-full bg-slate-800">
                <div className="relative h-full w-full rounded-full bg-gradient-to-t from-cyan-500/20 to-emerald-400/35">
                  <div
                    className="absolute left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-emerald-300"
                    style={{ bottom: `${raceProgress}%`, animation: 'neuro-pulse-dot 1.1s ease-out infinite' }}
                  />
                </div>
              </div>
              <p className="mt-2 text-xs font-semibold text-emerald-300">{Math.round(raceProgress)}%</p>
            </div>

            <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent" />

            <div
              className="absolute bottom-9 transition-[left] duration-200"
              style={{ left: `calc(50% - 30px + ${drift}px)` }}
            >
              <div className="relative h-16 w-[60px]" style={{ animation: `neuro-engine-thrum ${engineMs}ms ease-in-out infinite` }}>
                <div className={`absolute left-1/2 top-0 h-4 -translate-x-1/2 rounded-full px-2 text-[10px] font-semibold tracking-wide ${edgeWarning ? 'bg-red-500/25 text-red-200' : 'bg-cyan-500/20 text-cyan-100'}`}>
                  {edgeWarning ? 'EDGE' : 'LOCK'}
                </div>

                <div className="absolute bottom-0 left-1/2 h-[46px] w-[48px] -translate-x-1/2 rounded-xl border border-cyan-200/40 bg-gradient-to-b from-cyan-300 to-blue-700 shadow-[0_8px_22px_rgba(34,211,238,0.35)]">
                  <div className="absolute inset-x-2 top-1.5 h-4 rounded-md bg-slate-100/70" />
                  <div className="absolute bottom-1 left-1 h-3 w-3 rounded-full bg-slate-900 ring-1 ring-slate-500" />
                  <div className="absolute bottom-1 right-1 h-3 w-3 rounded-full bg-slate-900 ring-1 ring-slate-500" />
                </div>

                <div
                  className="absolute left-1/2 top-[46px] -z-10 w-5 -translate-x-1/2 rounded-b-full bg-gradient-to-b from-orange-200 via-amber-400 to-transparent"
                  style={{ height: `${flameLength}px`, opacity: 0.55 + speedStrength * 0.35 }}
                />
              </div>
            </div>

            {Array.from({ length: 7 }).map((_, index) => (
              <div
                key={index}
                className="absolute left-1/2 h-6 w-[2px] -translate-x-1/2 rounded-full bg-cyan-200"
                style={{
                  bottom: `${22 + index * 10}%`,
                  marginLeft: `${(index - 3) * 26 + drift * 0.22}px`,
                  opacity: speedStrength * (0.14 + index * 0.05),
                  animation: `neuro-speed-line ${Math.max(360 - speed, 90)}ms linear infinite`,
                  animationDelay: `${index * 70}ms`,
                }}
              />
            ))}

            {isFinished && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
                <div className="rounded-xl border border-emerald-300/60 bg-emerald-500/15 px-6 py-4 text-center">
                  <p className="text-xs tracking-[0.28em] text-emerald-200">LAP TIME</p>
                  <p className="mt-2 text-4xl font-semibold text-emerald-100">{lapTimeSeconds?.toFixed(2)}s</p>
                </div>
              </div>
            )}
          </div>

          <div className="relative z-10 mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3">
              <p className="text-xs uppercase tracking-wide text-cyan-200">Speed Load</p>
              <p className="mt-1 text-lg font-semibold text-cyan-100">{Math.round(speedStrength * 100)}%</p>
            </div>
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
              <p className="text-xs uppercase tracking-wide text-emerald-200">Track Stability</p>
              <p className="mt-1 text-lg font-semibold text-emerald-100">{Math.round(metrics.stability * 100)}%</p>
            </div>
            <div className="rounded-xl border border-violet-400/30 bg-violet-500/10 p-3">
              <p className="text-xs uppercase tracking-wide text-violet-200">Control</p>
              <p className="mt-1 text-lg font-semibold text-violet-100">{Math.round(metrics.control * 100)}%</p>
            </div>
            <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
              <p className="text-xs uppercase tracking-wide text-amber-200">Distance Left</p>
              <p className="mt-1 text-lg font-semibold text-amber-100">{remainingMeters} m</p>
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
  const wavePoints = ppgData.slice(-180);
  const waveMin = Math.min(...wavePoints, 0);
  const waveMax = Math.max(...wavePoints, 1);
  const waveRange = Math.max(waveMax - waveMin, 1);
  const normalizedWave = wavePoints.map((value) => clamp((value - waveMin) / waveRange));
  const smoothedWave = normalizedWave.map((_, index) => {
    const start = Math.max(index - 2, 0);
    const end = Math.min(index + 3, normalizedWave.length);
    return average(normalizedWave.slice(start, end));
  });
  const svgH = 220;
  const svgW = 520;
  const linePoints = smoothedWave.map((value, index) => {
    const x = (index / Math.max(smoothedWave.length - 1, 1)) * svgW;
    const y = svgH - value * (svgH - 24) - 12;
    return { x, y };
  });
  const linePath = linePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${svgW} ${svgH - 10} L 0 ${svgH - 10} Z`;
  const latestAmplitude = smoothedWave.length ? smoothedWave[smoothedWave.length - 1] : 0.5;
  const coherence = clamp(metrics.ppgRegulation * 0.7 + metrics.calm * 0.3);
  const regulationColor = metrics.ppgRegulation > 0.72 ? '#fb7185' : metrics.ppgRegulation > 0.45 ? '#f59e0b' : '#94a3b8';
  const coreScale = 0.84 + latestAmplitude * 0.38 + metrics.ppgRegulation * 0.22;
  const ringOpacity = 0.2 + coherence * 0.55;
  let peakCount = 0;
  for (let i = 1; i < smoothedWave.length - 1; i += 1) {
    if (smoothedWave[i] > smoothedWave[i - 1] && smoothedWave[i] > smoothedWave[i + 1] && smoothedWave[i] > 0.68) peakCount += 1;
  }
  const pulseDensity = Math.min(peakCount, 24);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 rounded-2xl border border-rose-400/40 bg-gradient-to-b from-rose-500/10 via-slate-950 to-slate-950 p-6">
      <style>{`
        @keyframes pulse-core {
          0%, 100% { transform: scale(0.94); }
          50% { transform: scale(1.08); }
        }
        @keyframes pulse-ring {
          from { transform: scale(0.8); opacity: 0.5; }
          to { transform: scale(1.55); opacity: 0; }
        }
        @keyframes pulse-scan {
          from { transform: translateX(-100%); }
          to { transform: translateX(100%); }
        }
      `}</style>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="relative overflow-hidden rounded-xl border border-rose-300/30 bg-slate-900/70 p-4 text-center">
          <p className="text-xs uppercase tracking-[0.22em] text-rose-200">Pulse Core</p>
          <div className="relative mx-auto mt-5 h-44 w-44">
            <div
              className="absolute inset-0 rounded-full border border-rose-300/30"
              style={{ animation: 'pulse-ring 1.4s ease-out infinite', opacity: ringOpacity }}
            />
            <div
              className="absolute inset-4 rounded-full border border-rose-300/25"
              style={{ animation: 'pulse-ring 1.4s ease-out 0.35s infinite', opacity: ringOpacity * 0.9 }}
            />
            <div
              className="absolute inset-8 rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.95),rgba(157,23,77,0.7)_60%,rgba(15,23,42,0.95)_100%)]"
              style={{
                transform: `scale(${coreScale})`,
                animation: `pulse-core ${Math.max(1200 - pulseDensity * 28, 420)}ms ease-in-out infinite`,
                boxShadow: `0 0 48px rgba(251,113,133,${0.3 + coherence * 0.35})`,
              }}
            />
          </div>
          <p className="mt-4 text-xs text-slate-300">Beat Activity</p>
          <p className="text-3xl font-semibold text-rose-100">{pulseDensity}</p>
        </div>

        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(248,113,113,0.08),rgba(15,23,42,0.95))]" />
          <p className="absolute left-3 top-2 text-xs uppercase tracking-[0.2em] text-slate-400">Heart Rhythm Stream</p>
          {linePoints.length > 2 ? (
            <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-56 w-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="pulseArea" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="rgba(251,113,133,0.45)" />
                  <stop offset="100%" stopColor="rgba(251,113,133,0)" />
                </linearGradient>
                <pattern id="pulseGrid" width="36" height="22" patternUnits="userSpaceOnUse">
                  <path d="M 36 0 L 0 0 0 22" fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width={svgW} height={svgH} fill="url(#pulseGrid)" />
              <path d={areaPath} fill="url(#pulseArea)" />
              <path d={linePath} fill="none" stroke={regulationColor} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              <path d={linePath} fill="none" stroke={regulationColor} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.18" />
              <circle
                cx={linePoints[linePoints.length - 1]?.x}
                cy={linePoints[linePoints.length - 1]?.y}
                r={4}
                fill={regulationColor}
                style={{ filter: 'drop-shadow(0 0 8px rgba(251,113,133,0.65))' }}
              />
            </svg>
          ) : (
            <div className="flex h-56 items-center justify-center text-sm text-slate-500">Waiting for PPG data...</div>
          )}
          <div
            className="pointer-events-none absolute inset-y-0 w-14 bg-gradient-to-r from-transparent via-rose-200/20 to-transparent"
            style={{ animation: `pulse-scan ${Math.max(2200 - pulseDensity * 60, 700)}ms linear infinite` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          Heart Rhythm Stability<br />
          <span className="text-xl text-rose-300">{Math.round(metrics.ppgRegulation * 100)}%</span>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-rose-400 transition-all duration-300" style={{ width: `${Math.round(metrics.ppgRegulation * 100)}%` }} /></div>
          <p className="mt-1 text-xs text-gray-500">Smoother pulse = better vagal tone</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          Neural Calmness<br />
          <span className="text-xl text-rose-300">{Math.round(metrics.calm * 100)}%</span>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-pink-400 transition-all duration-300" style={{ width: `${Math.round(metrics.calm * 100)}%` }} /></div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          Nervous System Control<br />
          <span className="text-xl text-rose-300">{Math.round(metrics.control * 100)}%</span>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800"><div className="h-full rounded-full bg-orange-400 transition-all duration-300" style={{ width: `${Math.round(metrics.control * 100)}%` }} /></div>
        </div>
      </div>

      <div className="rounded-lg border border-rose-600/40 bg-rose-900/20 p-3 text-xs text-rose-200">
        <strong>What is happening:</strong> You are training vagal tone, the ability of your parasympathetic nervous system to regulate heart-rate variability. The pulse core and waveform become cleaner when your nervous system response is more stable.
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
  onStopSession,
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
  const [lapTimeSeconds, setLapTimeSeconds] = useState<number | null>(null);
  const lapTimeRef = useRef<number | null>(null);
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

    // Record snapshot to session store for the shared results page
    addEEGSnapshot({
      focus: clamp(metrics.focus),
      calm: clamp(metrics.calm),
      control: clamp(metrics.control),
      symmetry: clamp(metrics.symmetry),
      ppg: clamp(metrics.ppgRegulation),
    });

    // For neuro-drive: record lap time when car reaches finish
    if (selectedActivity === 'neuro-drive' && newProgress >= 1.0 && lapTimeRef.current === null) {
      const elapsedTime = durationMinutes * 60 - remainingSeconds;
      lapTimeRef.current = elapsedTime;
      setLapTimeSeconds(elapsedTime);
    }
  }, [metrics, phase, selectedActivity, durationMinutes, remainingSeconds]);

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

  const handleStopSession = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setCognitiveData(sessionStats, selectedActivity, peakValue, lapTimeSeconds);
    onStopSession?.();
  };

  const resetToSelection = () => {
    setPhase('select');
    setRemainingSeconds(durationMinutes * 60);
    setSessionStats([]);
    setPeakValue(0);
    setLapTimeSeconds(null);
    lapTimeRef.current = null;
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

            <RunningVisualization selectedActivity={selectedActivity} progressValue={progressValue} metrics={metrics} ppgData={ppgData} lapTimeSeconds={lapTimeSeconds} />

            <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Focus<br />{Math.round(clamp(metrics.focus) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Calm<br />{Math.round(clamp(metrics.calm) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Control<br />{Math.round(clamp(metrics.control) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">PPG Reg.<br />{Math.round(clamp(metrics.ppgRegulation) * 100)}%</div>
            </div>

            <button onClick={finishEarly} className="rounded-full border border-gray-700 px-6 py-2 text-sm text-gray-300 hover:border-gray-500 transition-colors">Finish now</button>
            <button onClick={handleStopSession} className="rounded-full border border-red-700 bg-red-600/10 px-6 py-2 text-sm text-red-400 hover:bg-red-600/20 transition-colors">Stop Session</button>
          </div>
        )}

        {phase === 'results' && (() => {
          const insights = getActivityInsights(
            selectedActivity,
            avgFocus,
            avgCalm,
            avgControl,
            avgSymmetry,
            avgPpg,
            peakValue,
            lapTimeSeconds,
          );
          const colorMap = { excellent: 'emerald', good: 'blue', fair: 'amber', 'needs-work': 'red' };
          const colorClass = colorMap[insights.quality];

          return (
            <div className="mx-auto max-w-5xl space-y-8">
              <div className="text-center">
                <h2 className="text-4xl font-light">Session Complete</h2>
                <p className="mt-2 text-gray-400">Deep analysis of your {selectedMeta.title} session</p>
              </div>

              {/* Activity-specific insights */}
              <div className={`rounded-2xl border-2 border-${colorClass}-500/40 bg-${colorClass}-500/10 p-6`}>
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-2xl font-semibold text-white">{insights.title}</h3>
                    <p className={`mt-3 text-sm leading-relaxed text-${colorClass}-200`}>{insights.insight}</p>
                  </div>
                  <div className={`rounded-full bg-${colorClass}-500/30 px-4 py-2 text-center`}>
                    <p className={`text-xs uppercase tracking-widest text-${colorClass}-300`}>{insights.quality}</p>
                    <p className={`mt-1 text-2xl font-bold text-${colorClass}-400`}>{Math.round(insights.score * 100)}%</p>
                  </div>
                </div>
              </div>

              {/* Core metrics */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Performance Metrics</h4>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-cyan-600/40 bg-cyan-500/10 p-4">
                    <p className="text-xs text-cyan-300 uppercase tracking-widest">Avg Focus</p>
                    <p className="mt-2 text-2xl font-bold text-cyan-300">{Math.round(clamp(avgFocus) * 100)}%</p>
                    <p className="mt-1 text-xs text-gray-500">Frontal engagement + stability</p>
                  </div>
                  <div className="rounded-xl border border-pink-600/40 bg-pink-500/10 p-4">
                    <p className="text-xs text-pink-300 uppercase tracking-widest">Avg Calm</p>
                    <p className="mt-2 text-2xl font-bold text-pink-300">{Math.round(clamp(avgCalm) * 100)}%</p>
                    <p className="mt-1 text-xs text-gray-500">Low arousal + symmetry</p>
                  </div>
                  <div className="rounded-xl border border-purple-600/40 bg-purple-500/10 p-4">
                    <p className="text-xs text-purple-300 uppercase tracking-widest">Avg Control</p>
                    <p className="mt-2 text-2xl font-bold text-purple-300">{Math.round(clamp(avgControl) * 100)}%</p>
                    <p className="mt-1 text-xs text-gray-500">Combined regulation</p>
                  </div>
                  <div className="rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-4">
                    <p className="text-xs text-emerald-300 uppercase tracking-widest">Frontal Symmetry</p>
                    <p className="mt-2 text-2xl font-bold text-emerald-300">{Math.round(clamp(avgSymmetry) * 100)}%</p>
                    <p className="mt-1 text-xs text-gray-500">Hemisphere balance</p>
                  </div>
                  <div className="rounded-xl border border-orange-600/40 bg-orange-500/10 p-4">
                    <p className="text-xs text-orange-300 uppercase tracking-widest">Heart Rhythm</p>
                    <p className="mt-2 text-2xl font-bold text-orange-300">{Math.round(clamp(avgPpg) * 100)}%</p>
                    <p className="mt-1 text-xs text-gray-500">PPG stability</p>
                  </div>
                  <div className="rounded-xl border border-blue-600/40 bg-blue-500/10 p-4">
                    <p className="text-xs text-blue-300 uppercase tracking-widest">Peak Score</p>
                    <p className="mt-2 text-2xl font-bold text-blue-300">{Math.round(clamp(peakValue) * 100)}%</p>
                    <p className="mt-1 text-xs text-gray-500">Best moment</p>
                  </div>
                </div>
              </div>

              {/* Session progression graph */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Signal Evolution</h4>
                <SessionGraph data={sessionStats} />
              </div>

              {/* Detailed observations */}
              <div className="rounded-2xl border border-gray-700 bg-gray-900/40 p-6">
                <h4 className="text-sm font-semibold uppercase tracking-widest text-gray-300">Session Summary</h4>
                <div className="mt-4 space-y-2 text-sm text-gray-300">
                  <p>• <span className="text-gray-400">Duration:</span> {durationMinutes} minutes</p>
                  <p>• <span className="text-gray-400">Samples recorded:</span> {sessionStats.length} snapshots</p>
                  <p>• <span className="text-gray-400">Stability:</span> {sessionStats.length > 0 ? (Math.max(...sessionStats.map(s => s.focus)) - Math.min(...sessionStats.map(s => s.focus))) < 0.3 ? 'Very stable session' : 'Variable performance' : 'N/A'}</p>
                  <p>• <span className="text-gray-400">Pattern:</span> {avgFocus > 0.6 && avgCalm > 0.6 ? 'Strong integrated state' : avgFocus > 0.6 ? 'Focus-dominant' : avgCalm > 0.6 ? 'Relaxation-dominant' : 'Balanced mixed state'}</p>
                </div>
              </div>

              <div className="flex items-center justify-center gap-4">
                <button onClick={resetToSelection} className="rounded-full bg-white px-6 py-3 font-semibold text-black hover:bg-gray-200 transition-colors">Play Another Activity</button>
                <button onClick={onBackToHome} className="rounded-full border border-gray-600 px-6 py-3 font-semibold text-gray-300 hover:border-gray-400 transition-colors">Back to Home</button>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}

