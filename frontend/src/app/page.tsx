"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import LandingPage from "@/components/LandingPage";

interface User { id: number; username: string; created_at: string; has_baseline?: boolean; }

export default function Home() {
  const router = useRouter();
  const [showPicker, setShowPicker] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [nameInput, setNameInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchUsers = async () => {
    try {
      const res = await fetch('http://localhost:5000/users');
      if (res.ok) {
        const data = await res.json();
        // Enrich each user with baseline info
        const enriched: User[] = await Promise.all(
          (data.users ?? []).map(async (u: User) => {
            try {
              const r = await fetch(`http://localhost:5000/user/exists?user_id=${u.id}`);
              const d = await r.json();
              return { ...u, has_baseline: d.exists };
            } catch { return u; }
          })
        );
        setUsers(enriched);
      }
    } catch { /* backend not running */ }
  };

  useEffect(() => {
    if (showPicker) fetchUsers();
  }, [showPicker]);

  const handleGetStarted = () => {
    setShowPicker(true);
    setNameInput('');
    setError('');
  };

  // Quick-select an existing profile from the list
  const selectUser = async (user: User) => {
    setLoading(true);
    sessionStorage.setItem('neurovibe_user_id', String(user.id));
    sessionStorage.setItem('neurovibe_username', user.username);
    try {
      await fetch(`http://localhost:5000/users/${user.id}/load-baseline`, { method: 'POST' });
    } catch { /* backend may not be running yet */ }
    setLoading(false);
    router.push('/setup');
  };

  // Submit the name input: check → create or load
  const handleNameSubmit = async () => {
    const name = nameInput.trim();
    if (!name) return;
    setLoading(true);
    setError('');

    try {
      // 1. Check if username already exists
      const findRes = await fetch(`http://localhost:5000/users/find?username=${encodeURIComponent(name)}`);
      const findData = await findRes.json();

      if (findData.user) {
        // Existing user
        const user: User = findData.user;
        sessionStorage.setItem('neurovibe_user_id', String(user.id));
        sessionStorage.setItem('neurovibe_username', user.username);
        if (user.has_baseline) {
          // Load their baseline as the active one
          await fetch(`http://localhost:5000/users/${user.id}/load-baseline`, { method: 'POST' });
        }
        setLoading(false);
        router.push('/setup');
      } else {
        // New user — create
        const createRes = await fetch('http://localhost:5000/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: name }),
        });
        if (createRes.status === 409) {
          // Shouldn't happen (find didn't match), but handle race
          setError('Something went wrong. Please try again.');
          setLoading(false);
          return;
        }
        const newUser: User = await createRes.json();
        sessionStorage.setItem('neurovibe_user_id', String(newUser.id));
        sessionStorage.setItem('neurovibe_username', newUser.username);
        setLoading(false);
        router.push('/setup');
      }
    } catch {
      // Backend not running — store name locally and continue
      sessionStorage.setItem('neurovibe_user_id', '');
      sessionStorage.setItem('neurovibe_username', name);
      setLoading(false);
      router.push('/setup');
    }
  };

  return (
    <>
      <LandingPage onGetStarted={handleGetStarted} />

      {showPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-950 p-8 shadow-2xl">
            <h2 className="text-xl font-semibold text-white mb-1">Who's using NeuroVibe?</h2>
            <p className="text-sm text-gray-400 mb-6">
              Enter your name. If you've used it before, your profile will be loaded automatically.
            </p>

            {/* Name input */}
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                placeholder="Your name"
                value={nameInput}
                onChange={e => { setNameInput(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleNameSubmit()}
                autoFocus
                className="flex-1 rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-white placeholder-gray-600 focus:border-gray-500 focus:outline-none"
                maxLength={40}
              />
              <button
                onClick={handleNameSubmit}
                disabled={loading || !nameInput.trim()}
                className="rounded-xl bg-white px-5 py-3 font-semibold text-black hover:bg-gray-200 transition-colors disabled:opacity-40"
              >
                {loading ? '…' : 'Continue'}
              </button>
            </div>
            {error && <p className="mb-4 text-xs text-red-400">{error}</p>}

            {/* Existing profiles (quick-click) */}
            {users.length > 0 && (
              <div className="mt-6 border-t border-gray-800 pt-5">
                <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">Or select a profile</p>
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {users.map(u => (
                    <button
                      key={u.id}
                      onClick={() => selectUser(u)}
                      disabled={loading}
                      className="w-full flex items-center justify-between rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-left hover:border-gray-500 hover:bg-gray-800 transition-all disabled:opacity-50"
                    >
                      <span className="text-white font-medium">{u.username}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${u.has_baseline ? 'bg-green-900/40 text-green-400' : 'bg-amber-900/40 text-amber-400'}`}>
                        {u.has_baseline ? 'Ready' : 'Needs calibration'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => setShowPicker(false)}
              className="mt-5 text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
