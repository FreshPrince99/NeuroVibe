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
  | 'saving'
  | 'done'
  | 'error';

const BASELINE_SECONDS = 150;  // 2.5 minutes
const WIN_SIZE         = 1024; // samples per window (4 s @ 256 Hz)
const MIN_BASE_WINDOWS = 5;    // minimum usable baseline windows

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
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onComplete: () => void;
}

export default function CalibrationStep({ onComplete }: Props) {
  const [phase, setPhase]     = useState<Phase>('instructions');
  const [timer, setTimer]     = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg]   = useState('');

  // EEG data collected during baseline
  const baselineBuf = useRef<EEGSample[]>([]);

  const museRef       = useRef<MuseClient | null>(null);
  const museDeviceRef = useRef<BluetoothDevice | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef      = useRef<Phase>('instructions');
  const lastSampleRef = useRef<number>(0);
  const hasSavedRef   = useRef<boolean>(false);  // guard against double-save (React StrictMode)

  // Keep phaseRef in sync with phase state (needed inside intervals/subscriptions)
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      timerRef.current && clearInterval(timerRef.current);
      museRef.current?.disconnect();
    };
  }, []);

  // Reconnect when the tab comes back to the foreground
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (phaseRef.current !== 'baseline') return;
      const elapsed = Date.now() - lastSampleRef.current;
      if (elapsed > 5_000 && lastSampleRef.current > 0 && museDeviceRef.current) {
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
            lastSampleRef.current = Date.now();
            setStatusMsg('✓ Muse reconnected — recording resumed');
            zipSamples(nc.eegReadings).subscribe({
              next: (reading) => {
                lastSampleRef.current = Date.now();
                const s = {
                  tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
                  af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
                  af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
                  tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
                };
                if (phaseRef.current === 'baseline') baselineBuf.current.push(s);
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
  }, []);

  // ── Muse connection ──────────────────────────────────────────────────────
  const connectMuse = useCallback(async () => {
    setPhase('connecting');
    setStatusMsg('Connecting to Muse headset…');
    try {
      museRef.current = new MuseClient();
      museRef.current.enablePpg = true;
      await museRef.current.connect();
      const _dev = ((museRef.current as any).gatt)?.device as BluetoothDevice | undefined;
      if (_dev) museDeviceRef.current = _dev;
      await museRef.current.start();
      setStatusMsg('✓ Muse connected');
    } catch (err: any) {
      setErrorMsg(`Failed to connect: ${err.message ?? err}`);
      setPhase('error');
      return;
    }

    // Subscribe to EEG — samples accumulate in baselineBuf during baseline phase
    zipSamples(museRef.current.eegReadings).subscribe({
      next: (reading) => {
        lastSampleRef.current = Date.now();
        const sample: EEGSample = {
          tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
          af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
          af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
          tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
        };
        if (phaseRef.current === 'baseline') baselineBuf.current.push(sample);
      },
      error: (err) => {
        console.error('[CalibrationStep] EEG stream error:', err);
        const curPhase = phaseRef.current;
        if (curPhase === 'done' || curPhase === 'saving' || curPhase === 'error') return;
        setStatusMsg('📡 EEG disconnected — reconnecting…');
        void (async () => {
          try {
            if (museRef.current) { try { museRef.current.disconnect(); } catch {} }
            const newClient = new MuseClient();
            newClient.enablePpg = true;
            museRef.current = newClient;
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
            lastSampleRef.current = Date.now();
            setStatusMsg('✓ Muse reconnected — recording resumed');
            zipSamples(newClient.eegReadings).subscribe({
              next: (reading) => {
                lastSampleRef.current = Date.now();
                const s = {
                  tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
                  af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
                  af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
                  tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
                };
                if (phaseRef.current === 'baseline') baselineBuf.current.push(s);
              },
              error: (err2) => {
                console.error('[CalibrationStep] EEG error after reconnect:', err2);
                if (phaseRef.current !== 'done' && phaseRef.current !== 'saving') {
                  setErrorMsg('EEG disconnected twice. Please restart calibration.');
                  setPhase('error');
                }
              },
              complete: () => {},
            });
          } catch (reconnErr: unknown) {
            console.error('[CalibrationStep] Auto-reconnect failed:', reconnErr);
            if (phaseRef.current !== 'done' && phaseRef.current !== 'saving') {
              setErrorMsg('Could not reconnect headset. Please restart calibration.');
              setPhase('error');
            }
          }
        })();
      },
      complete: () => {
        const _p = phaseRef.current;
        if (_p === 'done' || _p === 'saving' || _p === 'error') return;
        setStatusMsg('📡 EEG stream ended — reconnecting…');
        void (async () => {
          try {
            if (museRef.current) { try { museRef.current.disconnect(); } catch {} }
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
            lastSampleRef.current = Date.now();
            setStatusMsg('✓ Muse reconnected — recording resumed');
            zipSamples(_nc.eegReadings).subscribe({
              next: (reading) => {
                lastSampleRef.current = Date.now();
                const s = {
                  tp9:  (Number.isFinite(reading.data[0] as number) ? reading.data[0] as number : 0),
                  af7:  (Number.isFinite(reading.data[1] as number) ? reading.data[1] as number : 0),
                  af8:  (Number.isFinite(reading.data[2] as number) ? reading.data[2] as number : 0),
                  tp10: (Number.isFinite(reading.data[3] as number) ? reading.data[3] as number : 0),
                };
                if (phaseRef.current === 'baseline') baselineBuf.current.push(s);
              },
              error: () => {},
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

    startBaseline();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── baseline recording ───────────────────────────────────────────────────
  const startBaseline = useCallback(() => {
    setPhase('baseline');
    setTimer(BASELINE_SECONDS);

    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          // Guard against React StrictMode double-invocation of state updaters
          if (!hasSavedRef.current) {
            hasSavedRef.current = true;
            void doSave();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── send baseline data to backend ────────────────────────────────────────
  const doSave = useCallback(async () => {
    setPhase('saving');

    try {
      const baselineWindows = splitIntoWindows(baselineBuf.current);
      if (baselineWindows.length < MIN_BASE_WINDOWS) {
        throw new Error(
          `Only ${baselineWindows.length} baseline windows collected (need ≥ ${MIN_BASE_WINDOWS}). ` +
          'Make sure the headset was connected for the full 2.5 minutes.'
        );
      }

      const userId = sessionStorage.getItem('neurovibe_user_id');
      const resp = await fetch('http://localhost:5000/calibration/build', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          baseline_samples: baselineWindows,
          ...(userId ? { user_id: Number(userId) } : {}),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error((err as any).error ?? `Server returned ${resp.status}`);
      }

      museRef.current?.disconnect();
      setPhase('done');
    } catch (err: any) {
      setErrorMsg(err.message ?? String(err));
      setPhase('error');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── baseline progress percentage ─────────────────────────────────────────
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
        <h2 className="text-4xl md:text-5xl font-light tracking-tight">EEG Baseline</h2>
        <p className="text-lg text-gray-400 max-w-2xl mx-auto mt-4 font-light leading-relaxed">
          A short resting recording personalises the emotion classifier to your brain signal.
        </p>
      </div>

      {/* ── Phase: Instructions ──────────────────────────────────────────── */}
      {phase === 'instructions' && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h3 className="text-lg font-light text-gray-200">What will happen</h3>
            <ol className="space-y-3 text-gray-400 font-light">
              <li className="flex gap-3">
                <span className="text-purple-400 font-medium mt-0.5">1.</span>
                <span>
                  Connect your Muse headset — it will record your brain signals for{' '}
                  <strong className="text-white">2.5 minutes</strong> while you sit quietly.
                  This establishes your personal resting baseline.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-purple-400 font-medium mt-0.5">2.</span>
                <span>
                  Sit comfortably, relax, and try not to move. Avoid talking, chewing, or blinking excessively.
                  Do <strong className="text-white">not</strong> listen to music during this step.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-purple-400 font-medium mt-0.5">3.</span>
                <span>
                  Once the timer completes, calibration is done and NeuroVibe will start.
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

      {/* ── Phase: Connecting ────────────────────────────────────────────── */}
      {phase === 'connecting' && (
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-300 font-light">{statusMsg}</p>
        </div>
      )}

      {/* ── Phase: Baseline ──────────────────────────────────────────────── */}
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
            {statusMsg ? (
              <p className="text-sm text-blue-400 mt-2 font-light">{statusMsg}</p>
            ) : null}
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

      {/* ── Phase: Saving ────────────────────────────────────────────────── */}
      {phase === 'saving' && (
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-300 font-light">Saving your baseline…</p>
        </div>
      )}

      {/* ── Phase: Done ──────────────────────────────────────────────────── */}
      {phase === 'done' && (
        <div className="max-w-xl mx-auto text-center space-y-6">
          <div className="w-20 h-20 mx-auto rounded-full bg-green-500/20 border-2 border-green-400 flex items-center justify-center">
            <span className="text-3xl">✓</span>
          </div>
          <div>
            <p className="text-2xl font-light text-white">Baseline Complete</p>
            <p className="text-gray-400 font-light mt-2">
              Your resting EEG has been saved. NeuroVibe is now personalised for you.
            </p>
          </div>
          <button
            onClick={onComplete}
            className="group flex items-center gap-3 px-10 py-4 mx-auto rounded-full bg-gradient-to-r from-green-500 to-blue-600 text-white font-light tracking-wide hover:shadow-2xl hover:shadow-green-500/30 transition-all duration-500 transform hover:scale-105"
          >
            <span>Start NeuroVibe →</span>
          </button>
        </div>
      )}

      {/* ── Phase: Error ─────────────────────────────────────────────────── */}
      {phase === 'error' && (
        <div className="max-w-xl mx-auto text-center space-y-6">
          <div className="w-20 h-20 mx-auto rounded-full bg-red-500/20 border-2 border-red-400 flex items-center justify-center">
            <span className="text-3xl">⚠️</span>
          </div>
          <div>
            <p className="text-2xl font-light text-white">Calibration Failed</p>
            <p className="text-red-400 font-light mt-2 text-sm">{errorMsg}</p>
          </div>
          <button
            onClick={() => {
              baselineBuf.current = [];
              hasSavedRef.current = false;
              setErrorMsg('');
              setPhase('instructions');
            }}
            className="group flex items-center gap-3 px-10 py-4 mx-auto rounded-full bg-gradient-to-r from-red-500 to-orange-500 text-white font-light tracking-wide hover:shadow-2xl transition-all duration-500 transform hover:scale-105"
          >
            <span>Try Again</span>
          </button>
        </div>
      )}
    </div>
  );
}
