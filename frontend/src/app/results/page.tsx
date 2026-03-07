'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, SessionData, SongRecord } from '@/lib/sessionStore';

// ── Helpers ──────────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(v: number) { return Math.max(0, Math.min(1, v)); }

function modeLabel(mode: string) {
  if (mode === 'focus') return 'Focus Session';
  if (mode === 'relaxation') return 'Relaxation Session';
  return 'Cognitive Training';
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function productivityLabel(score: number): { label: string; colour: string } {
  if (score >= 0.75) return { label: 'Highly effective', colour: 'emerald' };
  if (score >= 0.55) return { label: 'Moderately effective', colour: 'blue' };
  if (score >= 0.35) return { label: 'Somewhat effective', colour: 'amber' };
  return { label: 'Needs improvement', colour: 'red' };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalGraph({ data }: {
  data: Array<{ t: number; focus: number; calm: number; control: number }>;
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-gray-700 bg-black/20 text-gray-500 text-sm">
        Not enough signal data recorded
      </div>
    );
  }

  // Downsample to max 300 points (performance)
  const step = Math.max(1, Math.floor(data.length / 300));
  const pts = data.filter((_, i) => i % step === 0);

  const svgW = 600;
  const svgH = 200;
  const pad = { top: 16, bottom: 24, left: 36, right: 16 };
  const gW = svgW - pad.left - pad.right;
  const gH = svgH - pad.top - pad.bottom;
  const maxT = pts[pts.length - 1].t || 1;

  const x = (t: number) => pad.left + (t / maxT) * gW;
  const y = (v: number) => pad.top + gH - clamp(v) * gH;

  const line = (key: 'focus' | 'calm' | 'control', colour: string) => {
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t)} ${y(p[key])}`).join(' ');
    return <path key={key} d={d} stroke={colour} strokeWidth="1.8" fill="none" strokeLinejoin="round" />;
  };

  // Y-axis labels at 0%, 50%, 100%
  const yTicks = [0, 0.5, 1];

  return (
    <div className="rounded-xl border border-gray-700 bg-black/30 p-4">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" preserveAspectRatio="none">
        {/* Grid lines */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={pad.left} x2={svgW - pad.right} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.07)" />
            <text x={pad.left - 4} y={y(v) + 4} fontSize="9" fill="#666" textAnchor="end">{Math.round(v * 100)}%</text>
          </g>
        ))}
        {/* Time labels */}
        {[0, 0.5, 1].map(frac => {
          const t = frac * maxT;
          const sec = Math.round(t);
          const label = sec >= 60 ? `${Math.floor(sec / 60)}m` : `${sec}s`;
          return (
            <text key={frac} x={x(t)} y={svgH - 4} fontSize="9" fill="#666" textAnchor="middle">{label}</text>
          );
        })}
        {line('control', '#a855f7')}
        {line('focus', '#06b6d4')}
        {line('calm', '#ec4899')}
      </svg>
      <div className="mt-3 flex gap-5 text-xs">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-full bg-cyan-400" /> Focus</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-full bg-pink-400" /> Calm</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-full bg-purple-400" /> Control</span>
      </div>
    </div>
  );
}

function SongCard({ song, rank, mode }: { song: SongRecord; rank: number; mode: string }) {
  const pct = Math.round(song.score * 100);
  const barColour = song.score >= 0.7 ? 'bg-emerald-400' : song.score >= 0.5 ? 'bg-blue-400' : 'bg-amber-400';
  return (
    <div className="flex items-start gap-4 rounded-xl border border-gray-700 bg-gray-900/50 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-800 text-sm font-bold text-gray-300">
        #{rank}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-white">{song.name}</p>
        <p className="text-xs text-gray-400">{song.artist} · <span className="text-fuchsia-300">{song.genre}</span></p>
        <p className="mt-1 text-xs text-gray-500">
          Dominant emotion: <span className="capitalize text-gray-300">{song.dominantEmotion}</span>
          {song.likeDislikeLabel && (
            <span className={`ml-2 ${song.likeDislikeLabel === 'like' ? 'text-emerald-400' : 'text-red-400'}`}>
              {song.likeDislikeLabel === 'like' ? '👍 liked' : '👎 disliked'}
            </span>
          )}
        </p>
        <div className="mt-2 h-1.5 rounded-full bg-gray-800">
          <div className={`h-full rounded-full ${barColour} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-0.5 text-right text-xs text-gray-500">{pct}% effective for {mode}</p>
      </div>
    </div>
  );
}

function GenreBreakdown({ songs, mode }: { songs: SongRecord[]; mode: string }) {
  const genreMap: Record<string, { totalScore: number; count: number }> = {};
  for (const s of songs) {
    if (!genreMap[s.genre]) genreMap[s.genre] = { totalScore: 0, count: 0 };
    genreMap[s.genre].totalScore += s.score;
    genreMap[s.genre].count += 1;
  }
  const genres = Object.entries(genreMap)
    .map(([g, { totalScore, count }]) => ({ genre: g, avg: totalScore / count, count }))
    .sort((a, b) => b.avg - a.avg);

  if (!genres.length) return null;

  return (
    <div className="space-y-2">
      {genres.map(({ genre, avg: score, count }) => {
        const pct = Math.round(score * 100);
        const barColour = score >= 0.65 ? 'bg-emerald-400' : score >= 0.45 ? 'bg-blue-400' : 'bg-amber-400';
        return (
          <div key={genre} className="flex items-center gap-3 text-sm">
            <span className="w-28 shrink-0 truncate text-gray-300 capitalize">{genre}</span>
            <div className="flex-1 rounded-full bg-gray-800 h-2">
              <div className={`h-full rounded-full ${barColour}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-10 text-right text-xs text-gray-400">{pct}%</span>
            <span className="text-xs text-gray-600">({count} song{count > 1 ? 's' : ''})</span>
          </div>
        );
      })}
      <p className="pt-1 text-xs text-gray-500">
        Best genre for {mode}: <span className="text-gray-300 capitalize font-medium">{genres[0].genre}</span>
        {genres[genres.length - 1].avg < 0.5 && genres.length > 1 && (
          <> · Least effective: <span className="text-gray-400 capitalize">{genres[genres.length - 1].genre}</span></>
        )}
      </p>
    </div>
  );
}

function MusicAnalysis({ session }: { session: SessionData }) {
  const songs = [...session.songs].sort((a, b) => b.score - a.score);
  const top = songs.slice(0, 5);
  const avgScore = avg(songs.map(s => s.score));
  const productivity = productivityLabel(avgScore);

  // Emotion frequency across all songs
  const emotionFreq: Record<string, number> = {};
  for (const s of songs) {
    for (const e of s.emotions) emotionFreq[e] = (emotionFreq[e] ?? 0) + 1;
  }
  const topEmotions = Object.entries(emotionFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const modeDesc = session.mode === 'focus'
    ? 'How well each song helped sustain focused, engaged attention'
    : 'How well each song helped achieve calm, restful states';

  return (
    <div className="space-y-8">
      {/* Productivity summary */}
      <div className={`rounded-2xl border-2 border-${productivity.colour}-500/40 bg-${productivity.colour}-500/10 p-6`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-gray-400">Session Effectiveness</p>
            <p className={`mt-1 text-3xl font-semibold text-${productivity.colour}-300`}>{productivity.label}</p>
            <p className="mt-2 text-sm text-gray-400">{modeDesc}.</p>
          </div>
          <div className={`rounded-full bg-${productivity.colour}-500/20 px-5 py-3 text-center`}>
            <p className={`text-3xl font-bold text-${productivity.colour}-400`}>{Math.round(avgScore * 100)}%</p>
            <p className="text-xs text-gray-400">avg score</p>
          </div>
        </div>
      </div>

      {/* Top songs */}
      {top.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
            Top Songs for This Session
          </h3>
          <div className="space-y-3">
            {top.map((s, i) => <SongCard key={s.uri} song={s} rank={i + 1} mode={session.mode} />)}
          </div>
        </div>
      )}

      {/* Genre breakdown */}
      {songs.length > 0 && (
        <div className="rounded-xl border border-gray-700 bg-gray-900/30 p-5 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Genre Effectiveness</h3>
          <GenreBreakdown songs={songs} mode={session.mode} />
        </div>
      )}

      {/* Emotion distribution */}
      {topEmotions.length > 0 && (
        <div className="rounded-xl border border-gray-700 bg-gray-900/30 p-5 space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Emotional States During Session</h3>
          <div className="space-y-2">
            {topEmotions.map(([emo, count]) => {
              const total = Object.values(emotionFreq).reduce((a, b) => a + b, 0);
              const pct = Math.round((count / total) * 100);
              return (
                <div key={emo} className="flex items-center gap-3 text-sm">
                  <span className="w-24 capitalize text-gray-300">{emo}</span>
                  <div className="flex-1 h-2 rounded-full bg-gray-800">
                    <div className="h-full rounded-full bg-fuchsia-500/60" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CognitiveAnalysis({ session }: { session: SessionData }) {
  const stats = session.cognitiveStats;
  const avgFocus   = avg(stats.map(s => s.focus));
  const avgCalm    = avg(stats.map(s => s.calm));
  const avgControl = avg(stats.map(s => s.control));
  const avgSymmetry = avg(stats.map(s => s.symmetry));
  const avgPpg     = avg(stats.map(s => s.ppg));

  const activityNames: Record<string, string> = {
    'neural-ball': 'Neural Expansion Ball',
    'neuro-drive': 'Neuro Drive',
    'signal-shield': 'Signal Shield',
    'pulse-pilot': 'Pulse Pilot',
  };

  const activityName = activityNames[session.activityId ?? ''] ?? 'Cognitive Activity';
  const overallScore = (avgFocus * 0.35 + avgCalm * 0.25 + avgControl * 0.25 + avgSymmetry * 0.15);
  const prod = productivityLabel(overallScore);

  return (
    <div className="space-y-8">
      <div className={`rounded-2xl border-2 border-${prod.colour}-500/40 bg-${prod.colour}-500/10 p-6`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-gray-400">{activityName}</p>
            <p className={`mt-1 text-3xl font-semibold text-${prod.colour}-300`}>{prod.label}</p>
            {session.lapTimeSeconds && (
              <p className="mt-2 text-sm text-gray-400">Lap time: <span className="text-emerald-400 font-semibold">{session.lapTimeSeconds.toFixed(2)}s</span></p>
            )}
          </div>
          <div className={`rounded-full bg-${prod.colour}-500/20 px-5 py-3 text-center`}>
            <p className={`text-3xl font-bold text-${prod.colour}-400`}>{Math.round(session.peakValue * 100)}%</p>
            <p className="text-xs text-gray-400">peak</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          { label: 'Avg Focus', value: avgFocus, colour: 'cyan', desc: 'Frontal engagement' },
          { label: 'Avg Calm', value: avgCalm, colour: 'pink', desc: 'Low arousal + symmetry' },
          { label: 'Cognitive Control', value: avgControl, colour: 'purple', desc: 'Combined regulation' },
          { label: 'Frontal Symmetry', value: avgSymmetry, colour: 'emerald', desc: 'Hemisphere balance' },
          { label: 'Heart Rhythm', value: avgPpg, colour: 'orange', desc: 'PPG stability' },
          { label: 'Peak Score', value: session.peakValue, colour: 'blue', desc: 'Best moment' },
        ].map(({ label, value, colour, desc }) => (
          <div key={label} className={`rounded-xl border border-${colour}-600/30 bg-${colour}-500/10 p-4`}>
            <p className={`text-xs text-${colour}-300 uppercase tracking-widest`}>{label}</p>
            <p className={`mt-2 text-2xl font-bold text-${colour}-300`}>{Math.round(clamp(value) * 100)}%</p>
            <p className="mt-1 text-xs text-gray-500">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ResultsPage() {
  const router = useRouter();
  const [session, setSession] = useState<SessionData | null>(null);

  useEffect(() => {
    const s = getSession();
    // If no session started, redirect home
    if (!s.startTime) { router.replace('/'); return; }
    setSession(s);
  }, [router]);

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <p className="text-gray-400">Loading results…</p>
      </div>
    );
  }

  const durationMs = (session.endTime || Date.now()) - session.startTime;
  const isMusic = session.mode === 'focus' || session.mode === 'relaxation';

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-black py-4">
        <div className="container mx-auto flex items-center justify-between px-8">
          <button onClick={() => router.push('/')} className="text-3xl font-light hover:text-gray-300 transition-colors">
            NeuroVibe
          </button>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span className="rounded-full border border-gray-700 px-3 py-1">{modeLabel(session.mode)}</span>
            <span>{formatDuration(durationMs)}</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-5xl space-y-10 px-6 py-10">
        {/* Title */}
        <div className="text-center">
          <h1 className="text-4xl font-light">Session Report</h1>
          <p className="mt-2 text-gray-400">
            {new Date(session.startTime).toLocaleString()} · {formatDuration(durationMs)}
          </p>
        </div>

        {/* Mode-specific analysis */}
        {isMusic ? (
          <MusicAnalysis session={session} />
        ) : (
          <CognitiveAnalysis session={session} />
        )}

        {/* Signal progression — common to all modes */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
            Brain Signal Progression (Entire Session)
          </h2>
          <p className="text-xs text-gray-500">
            {isMusic
              ? 'Focus and Calm derived from VAD predictions. Control = dominance proxy.'
              : 'Computed from raw EEG band power (frontal engagement, temporal stability, asymmetry).'}
          </p>
          <SignalGraph data={session.eegSnapshots} />
        </div>

        {/* Actions */}
        <div className="flex justify-center gap-4 pb-10">
          <button
            onClick={() => router.push('/emotion')}
            className="rounded-full bg-white px-6 py-3 font-semibold text-black hover:bg-gray-200 transition-colors"
          >
            New Session
          </button>
          <button
            onClick={() => router.push('/')}
            className="rounded-full border border-gray-600 px-6 py-3 font-semibold text-gray-300 hover:border-gray-400 transition-colors"
          >
            Back to Home
          </button>
        </div>
      </main>
    </div>
  );
}
