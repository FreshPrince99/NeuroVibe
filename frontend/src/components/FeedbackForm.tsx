"use client";

import { useState } from "react";

// ── Standard SUS questions (alternating polarity as per original) ─────────────
const SUS_QUESTIONS = [
  "I think that I would like to use this system frequently.",
  "I found the system unnecessarily complex.",
  "I thought the system was easy to use.",
  "I think that I would need the support of a technical person to be able to use this system.",
  "I found the various functions in this system were well integrated.",
  "I thought there was too much inconsistency in this system.",
  "I would imagine that most people would learn to use this system very quickly.",
  "I found the system very cumbersome to use.",
  "I felt very confident using the system.",
  "I needed to learn a lot of things before I could get going with this system.",
];

// Odd-indexed SUS questions are reversed (1-indexed: Q2,4,6,8,10 → index 1,3,5,7,9)
const SUS_REVERSED = new Set([1, 3, 5, 7, 9]);

const TASK_QUESTIONS = [
  { id: "emotion_accuracy", label: "The emotion detection felt accurate to my mental state." },
  { id: "music_match",      label: "The music recommendations matched my mood and session goal." },
  { id: "eeg_responsive",  label: "The EEG visualisations/exercises responded to my brain state." },
  { id: "goal_achieved",   label: "I felt more focused / relaxed after the session (as intended)." },
];

const SCALE_LABELS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];

function ScaleRow({ label, value, onChange }: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <div className="py-3 border-b border-gray-800 last:border-0">
      <p className="text-sm text-gray-300 mb-2">{label}</p>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            onClick={() => onChange(n)}
            title={SCALE_LABELS[n - 1]}
            className={`flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-medium transition-all
              ${value === n
                ? 'border-white bg-white text-black'
                : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}
          >
            {n}
          </button>
        ))}
        <span className="ml-2 self-center text-xs text-gray-600 hidden sm:block">
          {value ? SCALE_LABELS[value - 1] : '—'}
        </span>
      </div>
    </div>
  );
}

function computeSUS(responses: Record<string, number>): number {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const raw = responses[`sus_${i}`] ?? 3;
    const score = SUS_REVERSED.has(i) ? (5 - raw) : (raw - 1);
    total += score;
  }
  return total * 2.5; // 0–100
}

export interface FeedbackFormProps {
  sessionId: number | null;
  onDone: () => void;
}

export default function FeedbackForm({ sessionId, onDone }: FeedbackFormProps) {
  const [susAnswers, setSusAnswers] = useState<Record<string, number | null>>(
    Object.fromEntries(SUS_QUESTIONS.map((_, i) => [`sus_${i}`, null]))
  );
  const [taskAnswers, setTaskAnswers] = useState<Record<string, number | null>>(
    Object.fromEntries(TASK_QUESTIONS.map(q => [q.id, null]))
  );
  const [openText, setOpenText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const allAnswered =
    Object.values(susAnswers).every(v => v !== null) &&
    Object.values(taskAnswers).every(v => v !== null);

  const handleSubmit = async () => {
    if (!allAnswered) return;
    setSubmitting(true);

    const filled = susAnswers as Record<string, number>;
    const susScore = computeSUS(filled);
    const userId = sessionStorage.getItem('neurovibe_user_id');

    const responses = {
      sus: filled,
      task: taskAnswers,
      open_text: openText.trim() || null,
      sus_score: susScore,
    };

    try {
      await fetch('http://localhost:5000/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId ? Number(userId) : null,
          session_id: sessionId,
          sus_score: susScore,
          responses,
        }),
      });
    } catch { /* backend may not be running */ }

    setSubmitting(false);
    setSubmitted(true);
  };

  if (submitted) {
    const susScore = computeSUS(susAnswers as Record<string, number>);
    return (
      <div className="rounded-2xl border border-emerald-600/30 bg-emerald-900/10 p-8 text-center space-y-3">
        <p className="text-2xl font-light text-emerald-300">Thank you for your feedback!</p>
        <p className="text-sm text-gray-400">
          Your SUS score: <span className="font-semibold text-white">{Math.round(susScore)}/100</span>
          {susScore >= 68 ? ' — above average usability' : ' — recorded'}
        </p>
        <button
          onClick={onDone}
          className="mt-4 rounded-full bg-white px-7 py-2.5 font-semibold text-black hover:bg-gray-200 transition-colors"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-700 bg-gray-900/40 p-6 space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Rate Your Experience</h2>
        <p className="text-sm text-gray-400 mt-1">
          Takes ~2 minutes. Your responses help evaluate the system.
          Rate each statement 1 (strongly disagree) to 5 (strongly agree).
        </p>
      </div>

      {/* SUS */}
      <div>
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">System Usability Scale</p>
        <div>
          {SUS_QUESTIONS.map((q, i) => (
            <ScaleRow
              key={i}
              label={`${i + 1}. ${q}`}
              value={susAnswers[`sus_${i}`]}
              onChange={v => setSusAnswers(prev => ({ ...prev, [`sus_${i}`]: v }))}
            />
          ))}
        </div>
      </div>

      {/* Task-specific */}
      <div>
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">NeuroVibe-Specific</p>
        <div>
          {TASK_QUESTIONS.map(q => (
            <ScaleRow
              key={q.id}
              label={q.label}
              value={taskAnswers[q.id]}
              onChange={v => setTaskAnswers(prev => ({ ...prev, [q.id]: v }))}
            />
          ))}
        </div>
      </div>

      {/* Open text */}
      <div>
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">Open Feedback (optional)</p>
        <textarea
          rows={3}
          placeholder="What worked well? What was confusing? Would you use this regularly?"
          value={openText}
          onChange={e => setOpenText(e.target.value)}
          className="w-full rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-gray-500 focus:outline-none resize-none"
        />
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={handleSubmit}
          disabled={!allAnswered || submitting}
          className="rounded-full bg-white px-7 py-3 font-semibold text-black hover:bg-gray-200 transition-colors disabled:opacity-40"
        >
          {submitting ? 'Saving…' : 'Submit Feedback'}
        </button>
        {!allAnswered && (
          <p className="text-xs text-gray-500">Please answer all questions before submitting.</p>
        )}
        <button onClick={onDone} className="ml-auto text-xs text-gray-600 hover:text-gray-400 transition-colors">
          Skip
        </button>
      </div>
    </div>
  );
}
