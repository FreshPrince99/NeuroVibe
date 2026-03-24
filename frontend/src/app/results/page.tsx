'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, SessionData, SongRecord } from '@/lib/sessionStore';
import FeedbackForm from '@/components/FeedbackForm';

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

function SignalGraph({ data, peakMetric, breaks }: {
  data: Array<{ t: number; focus: number; calm: number; control: number }>;
  peakMetric: 'focus' | 'calm';
  breaks?: Array<{ startMs: number; endMs: number }>;
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-gray-700 bg-black/20 text-gray-500 text-sm">
        Not enough signal data recorded
      </div>
    );
  }

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

  const yTicks = [0, 0.5, 1];

  // Find peak region: smooth with a small rolling window, then find peak
  const WIN = Math.max(1, Math.floor(pts.length / 20));
  let bestIdx = 0;
  let bestVal = -Infinity;
  for (let i = WIN; i < pts.length - WIN; i++) {
    let sum = 0;
    for (let j = i - WIN; j <= i + WIN; j++) sum += pts[j][peakMetric];
    const avg = sum / (2 * WIN + 1);
    if (avg > bestVal) { bestVal = avg; bestIdx = i; }
  }
  const peakT = pts[bestIdx]?.t ?? 0;
  const halfSpan = maxT * 0.07; // highlight 14% of timeline around peak
  const highlightX1 = x(Math.max(0, peakT - halfSpan));
  const highlightX2 = x(Math.min(maxT, peakT + halfSpan));
  const highlightColour = peakMetric === 'focus' ? 'rgba(6,182,212,0.10)' : 'rgba(236,72,153,0.10)';
  const highlightBorder = peakMetric === 'focus' ? 'rgba(6,182,212,0.35)' : 'rgba(236,72,153,0.35)';
  const peakLabel = peakMetric === 'focus' ? 'Peak focus' : 'Peak calm';
  const peakLabelColour = peakMetric === 'focus' ? '#22d3ee' : '#f472b6';

  return (
    <div>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" preserveAspectRatio="none">
        {/* Peak highlight band */}
        <rect
          x={highlightX1} y={pad.top}
          width={Math.max(highlightX2 - highlightX1, 2)}
          height={gH}
          fill={highlightColour}
          stroke={highlightBorder}
          strokeWidth="0.8"
          rx="2"
        />
        {/* Break markers */}
        {(breaks ?? []).map((br, i) => {
          const startSec = br.startMs / 1000;
          const endSec = (br.endMs > 0 ? br.endMs : br.startMs + 300_000) / 1000; // default 5 min if not ended
          const bx1 = x(Math.min(startSec, maxT));
          const bx2 = x(Math.min(endSec, maxT));
          const midX = (bx1 + bx2) / 2;
          return (
            <g key={i}>
              <rect
                x={bx1} y={pad.top}
                width={Math.max(bx2 - bx1, 2)}
                height={gH}
                fill="rgba(139,92,246,0.15)"
                stroke="rgba(139,92,246,0.35)"
                strokeWidth="0.8"
                rx="2"
              />
              <text x={midX} y={pad.top - 3} fontSize="8" fill="#a78bfa" textAnchor="middle">Break</text>
            </g>
          );
        })}
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
        {/* Peak label */}
        <text x={(highlightX1 + highlightX2) / 2} y={pad.top - 3} fontSize="8" fill={peakLabelColour} textAnchor="middle">{peakLabel}</text>
        {line('control', '#a855f7')}
        {line('focus', '#06b6d4')}
        {line('calm', '#ec4899')}
      </svg>
      <div className="mt-3 flex flex-wrap gap-5 text-xs text-gray-400">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-full bg-cyan-400" /> Focus — frontal engagement</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-full bg-pink-400" /> Calm — relaxation level</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-full bg-purple-400" /> Alertness — 1 − tiredness</span>
      </div>
    </div>
  );
}

function SongCard({ song, rank, mode }: { song: SongRecord; rank: number; mode: string }) {
  const pct = Math.round(song.score * 100);
  const barColour = song.score >= 0.7 ? 'bg-emerald-400' : song.score >= 0.5 ? 'bg-blue-400' : 'bg-amber-400';
  const spotifyUrl = song.uri.startsWith('spotify:track:')
    ? `https://open.spotify.com/track/${song.uri.split(':')[2]}`
    : '#';
  return (
    <a
      href={spotifyUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-900/50 p-3 hover:border-gray-500 hover:bg-gray-800/60 transition-all cursor-pointer no-underline"
    >
      {/* Album art */}
      {song.coverUrl ? (
        <img
          src={song.coverUrl}
          alt={song.name}
          className="h-14 w-14 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gray-800 text-sm font-bold text-gray-500">
          #{rank}
        </div>
      )}
      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-white text-sm">{song.name}</p>
        <p className="text-xs text-gray-400 truncate">{song.artist} · <span className="text-fuchsia-300">{song.genre}</span></p>
        <div className="mt-1.5 h-1.5 rounded-full bg-gray-800">
          <div className={`h-full rounded-full ${barColour} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {/* Score */}
      <div className="shrink-0 text-right">
        <p className={`text-sm font-semibold ${song.score >= 0.7 ? 'text-emerald-400' : song.score >= 0.5 ? 'text-blue-400' : 'text-amber-400'}`}>{pct}%</p>
        <p className="text-xs text-gray-600 mt-0.5">match</p>
      </div>
    </a>
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

function MusicDashboard({ session }: { session: SessionData }) {
  const allSongs   = session.songs;
  const sortedByScore = [...allSongs].sort((a, b) => b.score - a.score);

  // Emotion frequency across all songs
  const emotionFreq: Record<string, number> = {};
  for (const s of allSongs) {
    for (const e of s.emotions) emotionFreq[e] = (emotionFreq[e] ?? 0) + 1;
  }
  const topEmotions = Object.entries(emotionFreq).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const totalEmotionCount = Object.values(emotionFreq).reduce((a, b) => a + b, 0);

  if (!allSongs.length) {
    return (
      <div className="rounded-xl border border-gray-700 bg-gray-900/30 p-6 text-center text-gray-500 text-sm">
        No songs recorded in this session.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* ── Left column: song list ────────────────────────────── */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          Songs Played · Ranked by Effectiveness
        </h3>
        <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
          {sortedByScore.map((s, i) => (
            <SongCard key={s.uri + i} song={s} rank={i + 1} mode={session.mode} />
          ))}
        </div>
      </div>

      {/* ── Right column: genre + emotion analytics ───────────── */}
      <div className="space-y-5">
        {/* Genre effectiveness */}
        <div className="rounded-xl border border-gray-700 bg-gray-900/40 p-5 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Genre Effectiveness</h3>
          <GenreBreakdown songs={allSongs} mode={session.mode} />
        </div>

        {/* Emotional states */}
        {topEmotions.length > 0 && (
          <div className="rounded-xl border border-gray-700 bg-gray-900/40 p-5 space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">Emotional States</h3>
            <div className="space-y-2">
              {topEmotions.map(([emo, count]) => {
                const pct = Math.round((count / totalEmotionCount) * 100);
                return (
                  <div key={emo} className="flex items-center gap-3 text-sm">
                    <span className="w-24 shrink-0 capitalize text-gray-300">{emo}</span>
                    <div className="flex-1 h-2 rounded-full bg-gray-800">
                      <div className="h-full rounded-full bg-fuchsia-500/60 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
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
    'neural-ball': 'Sharpen Focus',
    'ocean-waves': 'Unwind & Relax',
    'balance-bar': 'Find Balance',
    'pulse-pilot': 'Reset & Breathe',
    // legacy
    'neuro-drive': 'Neuro Drive',
    'signal-shield': 'Signal Shield',
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
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState(false);

  // Session ID was saved by the emotion page when the session ended
  const sessionId = typeof window !== 'undefined'
    ? Number(sessionStorage.getItem('neurovibe_last_session_id') || '0') || null
    : null;

  const username = typeof window !== 'undefined'
    ? sessionStorage.getItem('neurovibe_username')
    : null;

  useEffect(() => {
    const s = getSession();
    if (!s.startTime) { router.replace('/'); return; }
    setSession(s);
  }, [router]);

  const handleLogout = () => {
    sessionStorage.removeItem('neurovibe_user_id');
    sessionStorage.removeItem('neurovibe_username');
    sessionStorage.removeItem('neurovibe_last_session_id');
    router.push('/');
  };

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <p className="text-gray-400">Loading results…</p>
      </div>
    );
  }

  const durationMs = (session.endTime || Date.now()) - session.startTime;
  const isMusic = session.mode === 'focus' || session.mode === 'relaxation';

  // Compute headline score for hero row
  const songs = session.songs;
  const avgScore = songs.length ? avg(songs.map(s => s.score)) : 0;
  const cogStats = session.cognitiveStats;
  const overallCog = cogStats.length
    ? avg(cogStats.map(s => s.focus)) * 0.35 + avg(cogStats.map(s => s.calm)) * 0.25
      + avg(cogStats.map(s => s.control)) * 0.25 + avg(cogStats.map(s => s.symmetry)) * 0.15
    : 0;
  const heroScore = isMusic ? avgScore : overallCog;
  const prod = productivityLabel(heroScore);

  const modeDesc = session.mode === 'focus'
    ? 'How well each song helped sustain focused, engaged attention'
    : session.mode === 'relaxation'
    ? 'How well each song helped achieve calm, restful states'
    : 'EEG-driven cognitive performance summary';

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-black/80 backdrop-blur-sm sticky top-0 z-10 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-8">
          <button onClick={() => router.push('/')} className="text-2xl font-light tracking-tight hover:text-gray-300 transition-colors">
            NeuroVibe
          </button>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            {username && (
              <>
                <span className="rounded-full border border-purple-700/50 bg-purple-900/20 px-3 py-1 text-purple-300">
                  {username}
                </span>
                <span className="text-gray-600">·</span>
              </>
            )}
            <span className="rounded-full border border-gray-700 px-3 py-1">{modeLabel(session.mode)}</span>
            <span className="text-gray-600">·</span>
            <span>{new Date(session.startTime).toLocaleString()}</span>
            <span className="text-gray-600">·</span>
            <span>{formatDuration(durationMs)}</span>
            {username && (
              <>
                <span className="text-gray-600">·</span>
                <button
                  onClick={handleLogout}
                  className="rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors"
                >
                  Log out
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">

        {/* ── Hero row ─────────────────────────────────────────────── */}
        <div className={`rounded-2xl border border-${prod.colour}-500/30 bg-gradient-to-br from-${prod.colour}-900/20 to-black p-6`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-gray-400">Session Report</p>
              <h1 className="mt-1 text-3xl font-light text-white">
                {modeLabel(session.mode)}
              </h1>
              <p className={`mt-2 text-lg font-semibold text-${prod.colour}-300`}>{prod.label}</p>
              <p className="mt-1 text-sm text-gray-400">{modeDesc}</p>
            </div>
            <div className="flex shrink-0 gap-4">
              {/* Score ring */}
              <div className={`flex flex-col items-center justify-center rounded-2xl border border-${prod.colour}-500/40 bg-${prod.colour}-500/10 px-8 py-5`}>
                <p className={`text-5xl font-bold text-${prod.colour}-300`}>{Math.round(heroScore * 100)}%</p>
                <p className="mt-1 text-xs text-gray-400 uppercase tracking-wider">effectiveness</p>
              </div>
              {/* Quick stats */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-gray-700 bg-gray-900/60 px-4 py-3 text-center">
                  <p className="text-2xl font-semibold text-white">{formatDuration(durationMs)}</p>
                  <p className="text-xs text-gray-500 mt-0.5">duration</p>
                </div>
                {isMusic ? (
                  <div className="rounded-xl border border-gray-700 bg-gray-900/60 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-white">{songs.length}</p>
                    <p className="text-xs text-gray-500 mt-0.5">songs played</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-gray-700 bg-gray-900/60 px-4 py-3 text-center">
                    <p className="text-2xl font-semibold text-white">{Math.round(session.peakValue * 100)}%</p>
                    <p className="text-xs text-gray-500 mt-0.5">peak score</p>
                  </div>
                )}
                <div className="rounded-xl border border-gray-700 bg-gray-900/60 px-4 py-3 text-center col-span-2">
                  <p className="text-lg font-semibold text-white">{session.eegSnapshots.length} pts</p>
                  <p className="text-xs text-gray-500 mt-0.5">EEG snapshots</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Brain signal graph (full width) ──────────────────────── */}
        <div className="rounded-2xl border border-gray-700 bg-gray-900/30 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
              Brain Signal Progression
            </h2>
            <p className="text-xs text-gray-600">
              {isMusic ? 'Derived from rule-based EEG scores' : 'Raw EEG band power'}
            </p>
          </div>
          <SignalGraph data={session.eegSnapshots} peakMetric={session.mode === 'relaxation' ? 'calm' : 'focus'} breaks={session.breaks ?? []} />
        </div>

        {/* ── Mode-specific content ─────────────────────────────────── */}
        {isMusic ? (
          <MusicDashboard session={session} />
        ) : (
          <CognitiveAnalysis session={session} />
        )}

        {/* ── Feedback ─────────────────────────────────────────────── */}
        {!feedbackDone && !showFeedback && (
          <div className="rounded-2xl border border-gray-700 bg-gray-900/30 p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white">Rate this session</p>
              <p className="text-xs text-gray-400 mt-0.5">~2 minutes · helps evaluate the system</p>
            </div>
            <button
              onClick={() => setShowFeedback(true)}
              className="rounded-full bg-white px-5 py-2 font-semibold text-black text-sm hover:bg-gray-200 transition-colors"
            >
              Give Feedback
            </button>
          </div>
        )}

        {showFeedback && !feedbackDone && (
          <FeedbackForm
            sessionId={sessionId}
            onDone={() => { setShowFeedback(false); setFeedbackDone(true); }}
          />
        )}

        {/* ── Actions ──────────────────────────────────────────────── */}
        <div className="flex justify-center gap-4 pb-10 pt-4">
          <button
            onClick={() => router.push('/emotion')}
            className="rounded-full bg-white px-7 py-3 font-semibold text-black hover:bg-gray-200 transition-colors"
          >
            New Session
          </button>
          <button
            onClick={() => router.push('/')}
            className="rounded-full border border-gray-600 px-7 py-3 font-semibold text-gray-300 hover:border-gray-400 transition-colors"
          >
            Back to Home
          </button>
        </div>
      </main>
    </div>
  );
}
