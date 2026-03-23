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

type GoalId = 'focus' | 'relax' | 'balance' | 'reset';
type ActivityId = 'neural-ball' | 'ocean-waves' | 'balance-bar' | 'pulse-pilot';
type Phase = 'select' | 'running' | 'results';

const GOAL_TO_ACTIVITY: Record<GoalId, ActivityId> = {
  focus: 'neural-ball',
  relax: 'ocean-waves',
  balance: 'balance-bar',
  reset: 'pulse-pilot',
};

const GOALS: Array<{ id: GoalId; title: string; subtitle: string; description: string; icon: string; color: string }> = [
  {
    id: 'focus',
    title: 'Sharpen Focus',
    subtitle: 'Grow your focus sphere',
    description: 'Train sustained attention. Watch the neural sphere expand as your frontal brain engagement increases.',
    icon: '🎯',
    color: 'cyan',
  },
  {
    id: 'relax',
    title: 'Unwind & Relax',
    subtitle: 'Still the ocean waves',
    description: 'Calm your mind and watch the waves settle into a peaceful sea as your brain enters a relaxed state.',
    icon: '🌊',
    color: 'blue',
  },
  {
    id: 'balance',
    title: 'Find Balance',
    subtitle: 'Center your mind',
    description: 'Balance your left and right brain activity. Keep the needle centered to achieve mental equilibrium.',
    icon: '⚖️',
    color: 'violet',
  },
  {
    id: 'reset',
    title: 'Reset & Breathe',
    subtitle: 'Steady your heart rhythm',
    description: 'Follow the breathing guide to slow your heart rate and build calm through paced breathing.',
    icon: '🫁',
    color: 'rose',
  },
];

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
  isBreakMode?: boolean;
  onReturnToSession?: () => void;
}

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
    const q = avgFocus > 0.7 ? 'excellent' : avgFocus > 0.55 ? 'good' : avgFocus > 0.4 ? 'fair' : 'needs-work';
    return {
      title: 'Focus Training',
      insight: `Average focus: ${Math.round(avgFocus * 100)}%. The sphere reached ${Math.round(peakValue * 100)}% at peak. ${avgFocus > 0.7 ? 'Excellent sustained attention!' : avgFocus > 0.55 ? 'Good focus — keep training.' : 'Try to minimize distractions and breathe steadily.'}`,
      quality: q,
      score: avgFocus,
    };
  }
  if (activity === 'ocean-waves') {
    const q = avgCalm > 0.7 ? 'excellent' : avgCalm > 0.55 ? 'good' : avgCalm > 0.4 ? 'fair' : 'needs-work';
    return {
      title: 'Relaxation Depth',
      insight: `Average calm: ${Math.round(avgCalm * 100)}%. ${avgCalm > 0.7 ? 'Deep relaxation achieved — excellent parasympathetic tone.' : avgCalm > 0.55 ? 'Good relaxation. Keep practicing slow breathing.' : 'Waves were still active. Try progressive muscle relaxation before the next session.'}`,
      quality: q,
      score: avgCalm,
    };
  }
  if (activity === 'balance-bar') {
    const q = symmetry > 0.7 ? 'excellent' : symmetry > 0.55 ? 'good' : symmetry > 0.4 ? 'fair' : 'needs-work';
    return {
      title: 'Hemispheric Balance',
      insight: `Frontal symmetry: ${Math.round(symmetry * 100)}% (${q}). Your hemispheres were ${symmetry > 0.7 ? 'well-synchronized' : symmetry > 0.55 ? 'reasonably balanced' : 'asymmetric'}. Peak balance score: ${Math.round(peakValue * 100)}%.`,
      quality: q,
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
        <rect x={padding} y={padding} width={graphW} height={graphH} fill="url(#gridGrad)" />
        <text x={padding - 30} y={padding + graphH + 5} fontSize="11" fill="#888">0%</text>
        <text x={padding - 30} y={padding + 10} fontSize="11" fill="#888">100%</text>
        <path d={controlPath} stroke="#a855f7" strokeWidth="2" fill="none" />
        <path d={focusPath} stroke="#06b6d4" strokeWidth="2" fill="none" />
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

  const frontalRatio = frontalEnergy / Math.max(frontalEnergy + temporalEnergy, 1e-6);
  const engagement = clamp((frontalRatio - 0.3) / 0.7);

  const arousal = clamp(toFinite(predictedVAD?.arousal, 0.5));
  const valence = clamp(toFinite(predictedVAD?.valence, 0.5));

  const focus = clamp(0.45 * engagement + 0.35 * stability + 0.2 * arousal);
  const calm = clamp(0.4 * symmetry + 0.4 * (1 - arousal) + 0.2 * stability);
  const control = clamp((focus + calm + valence) / 3);

  const ppgWindow = ppgData.slice(-160).map((value) => toFinite(value));
  const ppgDiff = ppgWindow.slice(1).map((value, index) => Math.abs(value - ppgWindow[index]));
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
    af7Energy,
    af8Energy,
  };
}

// ── Wave animation helper ──────────────────────────────────────────────────
function generateWavePath(width: number, height: number, amplitude: number, phase: number, wavelength: number): string {
  const points: string[] = [];
  for (let x = 0; x <= width; x += 4) {
    const y = height / 2 + Math.sin((x / wavelength) * 2 * Math.PI + phase) * amplitude;
    points.push(`${x === 0 ? 'M' : 'L'} ${x} ${y}`);
  }
  return points.join(' ');
}

// ── PPG BPM estimation ─────────────────────────────────────────────────────
const PPG_FS = 64;

function estimateBpm(data: number[]): number | null {
  if (data.length < PPG_FS * 3) return null;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const std = Math.sqrt(data.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / data.length);
  if (std < 1e-6) return null;
  const norm = data.map(v => (v - mean) / std);
  const minDist = Math.round(PPG_FS * 0.35);
  const peaks: number[] = [];
  for (let i = minDist; i < norm.length - minDist; i++) {
    if (norm[i] > 0.3) {
      let isPeak = true;
      for (let j = i - minDist; j <= i + minDist; j++) {
        if (j !== i && norm[j] >= norm[i]) { isPeak = false; break; }
      }
      if (isPeak) peaks.push(i);
    }
  }
  if (peaks.length < 2) return null;
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push((peaks[i] - peaks[i - 1]) / PPG_FS);
  }
  const valid = intervals.filter(v => v > 0.3 && v < 2.0).sort((a, b) => a - b);
  if (valid.length < 1) return null;
  const medianRR = valid[Math.floor(valid.length / 2)];
  const bpm = Math.round(60 / medianRR);
  return bpm > 30 && bpm < 200 ? bpm : null;
}

// ── Running visualizations ─────────────────────────────────────────────────
function OceanWavesVisualization({ metrics }: { metrics: ReturnType<typeof calculateBrainMetrics> }) {
  const calmLevel = clamp(metrics.calm);
  const phaseRef = useRef([0, 0, 0]);
  const animFrameRef = useRef<number | null>(null);
  const [wavePaths, setWavePaths] = useState<string[]>(['', '', '']);

  const calmLabel =
    calmLevel >= 0.85 ? 'Deep Calm' :
    calmLevel >= 0.70 ? 'Calm' :
    calmLevel >= 0.50 ? 'Settling' :
    calmLevel >= 0.30 ? 'Unsettled' : 'Agitated';

  const calmLabelColor =
    calmLevel >= 0.70 ? '#34d399' :
    calmLevel >= 0.50 ? '#60a5fa' :
    calmLevel >= 0.30 ? '#f59e0b' : '#f87171';

  useEffect(() => {
    const maxAmps = [60, 50, 40];
    const wavelengths = [180, 220, 150];
    const speeds = [0.018, 0.012, 0.022];
    const svgW = 520;
    const svgH = 160;

    const animate = () => {
      const calm = clamp(metrics.calm);
      phaseRef.current = phaseRef.current.map((p, i) => p + speeds[i] * (1 + (1 - calm) * 1.5));
      const paths = maxAmps.map((maxAmp, i) => {
        const amplitude = (1 - calm) * maxAmp + 4;
        return generateWavePath(svgW, svgH, amplitude, phaseRef.current[i], wavelengths[i]);
      });
      setWavePaths(paths);
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    };
  }, [metrics.calm]);

  const waveColors = ['#0ea5e9', '#38bdf8', '#7dd3fc'];
  const waveOpacities = [0.8, 0.6, 0.4];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {/* Ocean scene */}
      <div className="relative overflow-hidden rounded-2xl border border-blue-500/30 bg-gradient-to-b from-slate-950 via-blue-950/40 to-slate-950" style={{ minHeight: 340 }}>
        {/* Stars */}
        <div className="pointer-events-none absolute inset-0">
          {[...Array(20)].map((_, i) => (
            <div key={i} className="absolute rounded-full bg-white"
              style={{
                width: Math.random() * 2 + 1,
                height: Math.random() * 2 + 1,
                top: `${Math.random() * 40}%`,
                left: `${Math.random() * 100}%`,
                opacity: 0.3 + Math.random() * 0.5,
              }}
            />
          ))}
        </div>
        {/* Moon */}
        <div className="absolute top-6 right-10 h-10 w-10 rounded-full bg-yellow-100/80 shadow-[0_0_20px_rgba(253,224,71,0.4)]" />

        {/* Calm score overlay */}
        <div className="absolute top-5 left-6 space-y-1">
          <p className="text-xs uppercase tracking-widest text-blue-300">Calm Level</p>
          <p className="text-4xl font-bold" style={{ color: calmLabelColor }}>{Math.round(calmLevel * 100)}%</p>
          <p className="text-sm font-medium" style={{ color: calmLabelColor }}>{calmLabel}</p>
        </div>

        {/* SVG waves */}
        <div className="absolute bottom-0 left-0 right-0" style={{ height: 200 }}>
          <svg viewBox="0 0 520 160" className="w-full h-full" preserveAspectRatio="none">
            {waveColors.map((color, i) => (
              <path
                key={i}
                d={wavePaths[i]}
                fill="none"
                stroke={color}
                strokeWidth={2.5 - i * 0.4}
                strokeOpacity={waveOpacities[i]}
                strokeLinecap="round"
                style={{ transition: 'stroke-opacity 1.5s ease' }}
              />
            ))}
            {/* Water fill under first wave */}
            {wavePaths[0] && (
              <path
                d={`${wavePaths[0]} L 520 160 L 0 160 Z`}
                fill={`rgba(14,165,233,${0.06 + calmLevel * 0.08})`}
                style={{ transition: 'fill 1.5s ease' }}
              />
            )}
          </svg>
        </div>

        {/* Calm bar */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-64">
          <div className="flex justify-between text-xs text-blue-300 mb-1">
            <span>Agitated</span><span>Deep Calm</span>
          </div>
          <div className="h-2 rounded-full bg-blue-950/60 border border-blue-500/30">
            <div
              className="h-full rounded-full transition-all duration-[1500ms] ease"
              style={{ width: `${Math.round(calmLevel * 100)}%`, background: 'linear-gradient(to right, #38bdf8, #34d399)' }}
            />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
          <p className="text-xs text-blue-300 uppercase tracking-widest">Calm Score</p>
          <p className="mt-2 text-2xl font-bold text-blue-200">{Math.round(calmLevel * 100)}%</p>
          <p className="mt-1 text-xs text-gray-500">Neural relaxation index</p>
        </div>
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-4">
          <p className="text-xs text-sky-300 uppercase tracking-widest">State</p>
          <p className="mt-2 text-2xl font-bold" style={{ color: calmLabelColor }}>{calmLabel}</p>
          <p className="mt-1 text-xs text-gray-500">Current mental state</p>
        </div>
      </div>
    </div>
  );
}

function BalanceBarVisualization({ metrics, eegData }: {
  metrics: ReturnType<typeof calculateBrainMetrics>;
  eegData: EEGData[];
}) {
  const inGreenZoneCountRef = useRef(0);
  const totalSamplesRef = useRef(0);
  const [balanceScore, setBalanceScore] = useState(0);

  const window96 = eegData.slice(-96);
  const af7Energy = average(window96.map(s => Math.abs(toFinite(s.af7))));
  const af8Energy = average(window96.map(s => Math.abs(toFinite(s.af8))));
  const total = af7Energy + af8Energy;
  const needlePos = total > 1e-6 ? (af8Energy - af7Energy) / total : 0; // -1 (AF7 dominant) to +1 (AF8 dominant)
  const needlePct = clamp((needlePos + 1) / 2) * 100; // 0-100%
  const inGreenZone = Math.abs(needlePos) < 0.15;

  useEffect(() => {
    totalSamplesRef.current += 1;
    if (inGreenZone) inGreenZoneCountRef.current += 1;
    setBalanceScore(totalSamplesRef.current > 0 ? inGreenZoneCountRef.current / totalSamplesRef.current : 0);
  }, [needlePos, inGreenZone]);

  const needleColor = inGreenZone ? '#34d399' : Math.abs(needlePos) < 0.35 ? '#f59e0b' : '#f87171';

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="rounded-2xl border border-violet-500/30 bg-violet-500/5 p-6 space-y-6">
        {/* Labels */}
        <div className="flex justify-between text-sm">
          <div className="text-left">
            <p className="font-semibold text-violet-300">Left Brain (AF7)</p>
            <p className="text-xs text-gray-500">Logical · Analytical · Language</p>
          </div>
          <div className="text-right">
            <p className="font-semibold text-violet-300">Right Brain (AF8)</p>
            <p className="text-xs text-gray-500">Creative · Intuitive · Spatial</p>
          </div>
        </div>

        {/* Balance track */}
        <div className="relative">
          <div className="h-8 rounded-full bg-gray-800 border border-gray-700 overflow-hidden relative">
            {/* Green center zone */}
            <div
              className="absolute inset-y-0 bg-emerald-500/20 border-x border-emerald-500/40"
              style={{ left: '35%', width: '30%' }}
            />
            {/* Amber zones */}
            <div className="absolute inset-y-0 bg-amber-500/10 border-r border-amber-500/20" style={{ left: '15%', width: '20%' }} />
            <div className="absolute inset-y-0 bg-amber-500/10 border-l border-amber-500/20" style={{ left: '65%', width: '20%' }} />
            {/* Red outer zones */}
            <div className="absolute inset-y-0 bg-red-500/10" style={{ left: 0, width: '15%' }} />
            <div className="absolute inset-y-0 bg-red-500/10" style={{ right: 0, width: '15%' }} />
            {/* Center marker */}
            <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white/20" />
            {/* Needle */}
            <div
              className="absolute top-1 h-6 w-3 rounded-full transition-all duration-300"
              style={{
                left: `calc(${needlePct}% - 6px)`,
                background: needleColor,
                boxShadow: `0 0 10px ${needleColor}`,
              }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>Left</span>
            <span className="text-emerald-400">Center Zone</span>
            <span>Right</span>
          </div>
        </div>

        {/* Goal text */}
        <p className="text-center text-sm text-gray-400">Keep the needle centered for whole-brain thinking</p>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-violet-600/30 bg-violet-500/10 p-3 text-center">
            <p className="text-xs text-violet-300 uppercase tracking-widest">Left (AF7)</p>
            <p className="mt-1 text-xl font-bold text-violet-200">{Math.round(af7Energy)}</p>
            <p className="text-xs text-gray-500">µV</p>
          </div>
          <div className="rounded-xl border border-emerald-600/30 bg-emerald-500/10 p-3 text-center">
            <p className="text-xs text-emerald-300 uppercase tracking-widest">Balance Score</p>
            <p className="mt-1 text-xl font-bold text-emerald-200">{Math.round(balanceScore * 100)}%</p>
            <p className="text-xs text-gray-500">time in zone</p>
          </div>
          <div className="rounded-xl border border-violet-600/30 bg-violet-500/10 p-3 text-center">
            <p className="text-xs text-violet-300 uppercase tracking-widest">Right (AF8)</p>
            <p className="mt-1 text-xl font-bold text-violet-200">{Math.round(af8Energy)}</p>
            <p className="text-xs text-gray-500">µV</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunningVisualization({ selectedActivity, progressValue, metrics, ppgData, eegData }: {
  selectedActivity: ActivityId;
  progressValue: number;
  metrics: ReturnType<typeof calculateBrainMetrics>;
  ppgData: number[];
  eegData: EEGData[];
}) {
  if (selectedActivity === 'neural-ball') {
    const displayProgress = clamp(metrics.focus);
    const hue = Math.round(180 + displayProgress * 60);
    const glow = Math.round(displayProgress * 100);
    const rings = [1.6, 1.3, 1.0];
    const isGood = metrics.focus >= 0.5;

    return (
      <div className="flex flex-col items-center gap-5">
        {/* Guidance banner */}
        <div className="rounded-xl border border-gray-700 bg-black/40 px-5 py-3 text-center">
          {isGood ? (
            <p className="text-sm font-medium text-emerald-300">Great focus — sphere is growing</p>
          ) : (
            <p className="text-sm font-medium text-amber-300">Raise your <span className="font-bold">focus</span> to grow the sphere</p>
          )}
          <p className="mt-0.5 text-xs text-gray-500">Increase frontal brain engagement to expand the sphere</p>
        </div>

        {/* Sphere */}
        <div className="relative flex h-72 w-72 items-center justify-center">
          {rings.map((scale, i) => (
            <div
              key={i}
              className="absolute rounded-full border"
              style={{
                width: `${scale * (0.7 + displayProgress * 0.5) * 200}px`,
                height: `${scale * (0.7 + displayProgress * 0.5) * 200}px`,
                borderColor: `hsla(${hue}, 70%, 60%, ${0.25 - i * 0.07})`,
                transition: 'all 450ms ease',
              }}
            />
          ))}
          <div
            className="flex items-center justify-center rounded-full text-2xl font-bold text-white"
            style={{
              width: `${(0.7 + displayProgress * 0.5) * 200}px`,
              height: `${(0.7 + displayProgress * 0.5) * 200}px`,
              background: `radial-gradient(circle, hsl(${hue},80%,60%) 0%, hsl(${hue},60%,30%) 100%)`,
              boxShadow: `0 0 ${glow}px hsl(${hue},80%,60%)`,
              transition: 'all 450ms ease',
            }}
          >
            {Math.round(displayProgress * 100)}%
          </div>
        </div>

        {/* Single focus bar */}
        <div className="w-full max-w-sm rounded-lg border bg-black/40 p-3"
          style={{ borderColor: isGood ? '#22d3ee40' : '#f8717130' }}>
          <div className="flex justify-between text-gray-300 text-sm">
            <span>Focus</span>
            <span style={{ color: isGood ? '#22d3ee' : '#f87171' }} className="font-semibold">{Math.round(metrics.focus * 100)}%</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-gray-800">
            <div className="h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.round(metrics.focus * 100)}%`, background: isGood ? '#22d3ee' : '#f87171' }} />
          </div>
          <p className="mt-1 text-xs" style={{ color: isGood ? '#22d3ee90' : '#f8717190' }}>
            Frontal engagement · {isGood ? '✓ Good' : 'Needs work'}
          </p>
        </div>
      </div>
    );
  }

  if (selectedActivity === 'ocean-waves') {
    return <OceanWavesVisualization metrics={metrics} />;
  }

  if (selectedActivity === 'balance-bar') {
    return <BalanceBarVisualization metrics={metrics} eegData={eegData} />;
  }

  // ── Pulse Pilot ────────────────────────────────────────────────────────
  const ppgWindow = ppgData.slice(-PPG_FS * 10);
  const estBpm = estimateBpm(ppgWindow);

  const wavePoints = ppgData.slice(-PPG_FS * 5); // 5 seconds
  const waveMin = Math.min(...wavePoints, 0);
  const waveMax = Math.max(...wavePoints, 1);
  const waveRange = Math.max(waveMax - waveMin, 1);
  const normalizedWave = wavePoints.map((v) => clamp((v - waveMin) / waveRange));
  const smoothedWave = normalizedWave.map((_, i) => {
    const s = Math.max(i - 2, 0);
    const e = Math.min(i + 3, normalizedWave.length);
    return average(normalizedWave.slice(s, e));
  });
  const svgH = 200;
  const svgW = 520;
  const linePoints = smoothedWave.map((v, i) => ({
    x: (i / Math.max(smoothedWave.length - 1, 1)) * svgW,
    y: svgH - v * (svgH - 24) - 12,
  }));
  const linePath = linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${svgW} ${svgH - 10} L 0 ${svgH - 10} Z`;
  const coherence = clamp(metrics.ppgRegulation * 0.7 + metrics.calm * 0.3);
  const regulationColor = metrics.ppgRegulation > 0.72 ? '#fb7185' : metrics.ppgRegulation > 0.45 ? '#f59e0b' : '#94a3b8';
  const stabilityLabel = metrics.ppgRegulation > 0.72 ? 'Smooth — excellent coherence' : metrics.ppgRegulation > 0.45 ? 'Moderate — keep breathing slowly' : 'Irregular — slow your breath';

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 rounded-2xl border border-rose-400/40 bg-gradient-to-b from-rose-500/8 via-slate-950 to-slate-950 p-6">
      <style>{`
        @keyframes pp-breathe {
          0%       { transform: scale(0.55); background: rgba(96,165,250,0.25); }
          33%      { transform: scale(1.05); background: rgba(96,165,250,0.60); }
          42%      { transform: scale(1.05); background: rgba(167,139,250,0.60); }
          92%      { transform: scale(0.55); background: rgba(167,139,250,0.25); }
          100%     { transform: scale(0.55); background: rgba(96,165,250,0.25); }
        }
        @keyframes pp-ring {
          from { transform: scale(0.8); opacity: 0.5; }
          to   { transform: scale(1.6); opacity: 0; }
        }
        @keyframes pp-label-inhale {
          0%,2%  { opacity:1 } 33%,100% { opacity:0 }
        }
        @keyframes pp-label-hold1 {
          0%,32%  { opacity:0 } 34%,41% { opacity:1 } 43%,100% { opacity:0 }
        }
        @keyframes pp-label-exhale {
          0%,41%  { opacity:0 } 43%,90% { opacity:1 } 92%,100% { opacity:0 }
        }
        @keyframes pp-label-hold2 {
          0%,91%  { opacity:0 } 93%,99% { opacity:1 } 100%      { opacity:0 }
        }
      `}</style>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* Breathing pacer */}
        <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-300/30 bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.22em] text-rose-200">Breathing Guide</p>
          <div className="relative flex h-40 w-40 items-center justify-center">
            <div className="absolute inset-0 rounded-full border border-rose-300/25"
              style={{ animation: `pp-ring 12s linear ${33 / 100 * 12}s infinite`, opacity: coherence * 0.5 }} />
            <div className="absolute inset-6 rounded-full"
              style={{ animation: 'pp-breathe 12s ease-in-out infinite',
                boxShadow: `0 0 32px rgba(251,113,133,${0.2 + coherence * 0.4})` }} />
            <div className="relative z-10 text-center select-none">
              <p className="text-xs font-semibold text-blue-200" style={{ animation: 'pp-label-inhale 12s ease-in-out infinite' }}>Inhale</p>
              <p className="text-xs font-semibold text-purple-300 absolute top-0 left-0 right-0" style={{ animation: 'pp-label-hold1 12s ease-in-out infinite' }}>Hold</p>
              <p className="text-xs font-semibold text-purple-200 absolute top-0 left-0 right-0" style={{ animation: 'pp-label-exhale 12s ease-in-out infinite' }}>Exhale</p>
              <p className="text-xs font-semibold text-blue-300 absolute top-0 left-0 right-0" style={{ animation: 'pp-label-hold2 12s ease-in-out infinite' }}>Hold</p>
            </div>
          </div>
          <p className="text-[10px] text-center text-slate-400">
            4s inhale · 1s hold · 6s exhale · 1s hold
          </p>
          <div className="w-full rounded-lg border border-rose-600/30 bg-rose-900/20 px-3 py-2 text-xs text-rose-200 text-center">
            {stabilityLabel}
          </div>
        </div>

        {/* PPG waveform */}
        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(248,113,113,0.06),rgba(15,23,42,0.95))]" />
          <p className="absolute left-3 top-2 text-xs uppercase tracking-[0.2em] text-slate-400">Heart Rhythm Stream</p>
          <p className="absolute right-3 top-2 text-xs text-slate-500">Last 5 seconds</p>
          {linePoints.length > 2 ? (
            <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-52 w-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="ppArea" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="rgba(251,113,133,0.40)" />
                  <stop offset="100%" stopColor="rgba(251,113,133,0)" />
                </linearGradient>
                <pattern id="ppGrid" width="36" height="22" patternUnits="userSpaceOnUse">
                  <path d="M 36 0 L 0 0 0 22" fill="none" stroke="rgba(148,163,184,0.14)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width={svgW} height={svgH} fill="url(#ppGrid)" />
              <path d={areaPath} fill="url(#ppArea)" />
              <path d={linePath} fill="none" stroke={regulationColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d={linePath} fill="none" stroke={regulationColor} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" opacity="0.15" />
              <circle cx={linePoints[linePoints.length - 1]?.x} cy={linePoints[linePoints.length - 1]?.y} r={4}
                fill={regulationColor} style={{ filter: 'drop-shadow(0 0 7px rgba(251,113,133,0.65))' }} />
            </svg>
          ) : (
            <div className="flex h-52 items-center justify-center text-sm text-slate-500">Waiting for PPG data…</div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          <p className="text-xs text-gray-400">HRV Coherence</p>
          <p className="mt-1 text-xl font-semibold text-rose-300">{Math.round(metrics.ppgRegulation * 100)}%</p>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800">
            <div className="h-full rounded-full bg-rose-400 transition-all duration-300" style={{ width: `${Math.round(metrics.ppgRegulation * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-gray-500">Smoother = better vagal tone</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          <p className="text-xs text-gray-400">Neural Calm</p>
          <p className="mt-1 text-xl font-semibold text-pink-300">{Math.round(metrics.calm * 100)}%</p>
          <div className="mt-2 h-1.5 rounded-full bg-gray-800">
            <div className="h-full rounded-full bg-pink-400 transition-all duration-300" style={{ width: `${Math.round(metrics.calm * 100)}%` }} />
          </div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-black/40 p-3">
          <p className="text-xs text-gray-400">Est. Heart Rate</p>
          <p className="mt-1 text-xl font-semibold text-orange-300">{estBpm !== null ? `${estBpm} bpm` : '—'}</p>
          <p className="mt-3 text-xs text-gray-500">Target: 50–70 bpm during exercise</p>
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
  onStopSession,
  onPauseToggle,
  isPaused,
  isBreakMode = false,
  onReturnToSession,
}: CognitiveTrainingViewProps) {
  const [phase, setPhase] = useState<Phase>('select');
  const [selectedGoal, setSelectedGoal] = useState<GoalId | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(isBreakMode ? 5 : 3);
  const [remainingSeconds, setRemainingSeconds] = useState(durationMinutes * 60);
  const [progressValue, setProgressValue] = useState(0.25);
  const [sessionStats, setSessionStats] = useState<Array<{ focus: number; calm: number; control: number; ppg: number; symmetry: number }>>([]);
  const [peakValue, setPeakValue] = useState(0);
  const lapTimeRef = useRef<number | null>(null);
  const metrics = useMemo(() => calculateBrainMetrics(eegData, ppgData, predictedVAD), [eegData, ppgData, predictedVAD]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedActivity: ActivityId = selectedGoal ? GOAL_TO_ACTIVITY[selectedGoal] : 'neural-ball';
  const selectedGoalMeta = GOALS.find(g => g.id === selectedGoal);

  useEffect(() => {
    setRemainingSeconds(durationMinutes * 60);
  }, [durationMinutes]);

  useEffect(() => {
    if (phase !== 'running') return;

    const newProgress = (() => {
      if (selectedActivity === 'neural-ball') return clamp(metrics.focus);
      if (selectedActivity === 'ocean-waves') return clamp(metrics.calm);
      if (selectedActivity === 'balance-bar') return clamp(metrics.symmetry);
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

    addEEGSnapshot({
      focus: clamp(metrics.focus),
      calm: clamp(metrics.calm),
      control: clamp(metrics.control),
      symmetry: clamp(metrics.symmetry),
      ppg: clamp(metrics.ppgRegulation),
    });
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
    lapTimeRef.current = null;
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
    setCognitiveData(sessionStats, selectedActivity, peakValue, null);
    onStopSession?.();
  };

  const resetToSelection = () => {
    setPhase('select');
    setSelectedGoal(null);
    setRemainingSeconds(durationMinutes * 60);
    setSessionStats([]);
    setPeakValue(0);
    lapTimeRef.current = null;
  };

  const handleGoalSelect = (goalId: GoalId) => {
    setSelectedGoal(goalId);
    // In break mode, immediately start; in standalone, start immediately too (simple UX)
    setSessionStats([]);
    setPeakValue(0);
    setProgressValue(0.25);
    setRemainingSeconds(durationMinutes * 60);
    lapTimeRef.current = null;
    setPhase('running');
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
          <div className="flex items-center gap-3">
            <button onClick={onBackToHome} className="text-3xl font-light hover:text-gray-300">NeuroVibe</button>
            {isBreakMode && (
              <span className="rounded-full border border-violet-500/50 bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-300">On Break</span>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-400">{sampleCount} samples</span>
            <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-4 py-1 text-cyan-200">{connectionStatus}</span>
            {isBreakMode ? (
              <button
                onClick={onReturnToSession}
                className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 font-semibold text-white transition-colors"
              >
                Return to Session
              </button>
            ) : (
              <button
                onClick={onPauseToggle}
                className={`rounded-lg px-4 py-2 font-semibold ${isPaused ? 'bg-green-500 text-white' : 'bg-orange-500 text-white'}`}
              >
                {isPaused ? 'Resume' : 'Pause'}
              </button>
            )}
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
              <h1 className="text-4xl font-light">
                {isBreakMode ? 'Take a Brain Break' : 'What would you like to work on?'}
              </h1>
              <p className="mx-auto mt-3 max-w-2xl text-gray-400">
                {isBreakMode
                  ? 'Choose a short mental exercise to refresh your mind before returning to the music session.'
                  : 'Choose a goal. Each exercise uses real-time EEG signals from your Muse headset.'}
              </p>
            </div>

            {/* Duration selector — only in standalone mode */}
            {!isBreakMode && (
              <div className="flex justify-center">
                <label className="text-sm text-gray-300 flex items-center gap-3">
                  Duration
                  <select
                    className="rounded-lg border border-gray-700 bg-black px-3 py-2"
                    value={durationMinutes}
                    onChange={(event) => setDurationMinutes(parseInt(event.target.value, 10))}
                  >
                    {[3, 4, 5].map((option) => <option key={option} value={option}>{option} minutes</option>)}
                  </select>
                </label>
              </div>
            )}

            {/* Goal cards 2×2 grid */}
            <div className="grid gap-4 sm:grid-cols-2">
              {GOALS.map((goal) => (
                <button
                  key={goal.id}
                  onClick={() => handleGoalSelect(goal.id)}
                  className={`rounded-2xl border p-6 text-left transition-all hover:scale-[1.02] border-gray-800 bg-gray-900/40 hover:border-${goal.color}-500/50 hover:bg-${goal.color}-500/5`}
                >
                  <div className="flex items-start gap-4">
                    <span className="text-4xl">{goal.icon}</span>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-xl font-semibold text-white">{goal.title}</h3>
                      <p className={`mt-0.5 text-sm font-medium text-${goal.color}-300`}>{goal.subtitle}</p>
                      <p className="mt-2 text-sm text-gray-400">{goal.description}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {phase === 'running' && selectedGoalMeta && (
          <div className="space-y-8 text-center">
            <div>
              <h2 className="text-3xl font-light">{selectedGoalMeta.title}</h2>
              <p className="mt-2 text-gray-400">{selectedGoalMeta.description}</p>
              <p className="mt-2 text-sm text-fuchsia-300">{Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, '0')} remaining</p>
            </div>

            <RunningVisualization
              selectedActivity={selectedActivity}
              progressValue={progressValue}
              metrics={metrics}
              ppgData={ppgData}
              eegData={eegData}
            />

            <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Focus<br />{Math.round(clamp(metrics.focus) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Calm<br />{Math.round(clamp(metrics.calm) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">Control<br />{Math.round(clamp(metrics.control) * 100)}%</div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">PPG Reg.<br />{Math.round(clamp(metrics.ppgRegulation) * 100)}%</div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button onClick={finishEarly} className="rounded-full border border-gray-700 px-6 py-2 text-sm text-gray-300 hover:border-gray-500 transition-colors">Finish now</button>
              {isBreakMode ? (
                <button onClick={onReturnToSession} className="rounded-full border border-violet-600 bg-violet-600/10 px-6 py-2 text-sm text-violet-400 hover:bg-violet-600/20 transition-colors">Return to Session</button>
              ) : (
                <button onClick={handleStopSession} className="rounded-full border border-red-700 bg-red-600/10 px-6 py-2 text-sm text-red-400 hover:bg-red-600/20 transition-colors">Stop Session</button>
              )}
            </div>
          </div>
        )}

        {phase === 'results' && selectedGoalMeta && (() => {
          const insights = getActivityInsights(
            selectedActivity,
            avgFocus,
            avgCalm,
            avgControl,
            avgSymmetry,
            avgPpg,
            peakValue,
            null,
          );
          const colorMap = { excellent: 'emerald', good: 'blue', fair: 'amber', 'needs-work': 'red' };
          const colorClass = colorMap[insights.quality];

          return (
            <div className="mx-auto max-w-5xl space-y-8">
              <div className="text-center">
                <h2 className="text-4xl font-light">Session Complete</h2>
                <p className="mt-2 text-gray-400">Deep analysis of your {selectedGoalMeta.title} session</p>
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

              <div className="flex flex-wrap items-center justify-center gap-4">
                {/* Return to Session — primary in break mode */}
                {isBreakMode && (
                  <button
                    onClick={onReturnToSession}
                    className="rounded-full bg-violet-600 hover:bg-violet-500 px-7 py-3 font-semibold text-white transition-colors"
                  >
                    Return to Session
                  </button>
                )}
                <button onClick={resetToSelection} className="rounded-full bg-white px-6 py-3 font-semibold text-black hover:bg-gray-200 transition-colors">
                  {isBreakMode ? 'Try Another Exercise' : 'Play Another Activity'}
                </button>
                <button onClick={onBackToHome} className="rounded-full border border-gray-600 px-6 py-3 font-semibold text-gray-300 hover:border-gray-400 transition-colors">Back to Home</button>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}
