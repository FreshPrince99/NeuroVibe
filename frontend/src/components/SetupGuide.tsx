'use client';
import { useState } from 'react';
import Image from 'next/image';
import museImage from '@/assets/muse.jpg';
import CalibrationStep from '@/components/CalibrationStep';

interface SetupGuideProps {
  onSpotifyAuth: () => void;
  onComplete: () => void;
  spotifyAuthenticated: boolean;
  onBackToHome?: () => void;
  onTestMode?: () => void;
  /** If true, insert a calibration step before Choose Mode */
  needsCalibration?: boolean;
}

type SessionMode = 'focus' | 'relaxation' | 'cognitive';
type FocusEnergy = 'energetic' | 'calm' | '';

const musicGenres = [
  'Lo-fi',
  'Classical',
  'Ambient',
  'Jazz',
  'Instrumental',
  'Electronic',
  'Nature sounds',
  'Soft pop'
];

export default function SetupGuide({
  onSpotifyAuth,
  onComplete,
  spotifyAuthenticated,
  onBackToHome,
  onTestMode,
  needsCalibration = false,
}: SetupGuideProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [preferredGenres, setPreferredGenres] = useState<string[]>([]);
  const [focusEnergy, setFocusEnergy] = useState<FocusEnergy>('');
  const [selectedMode, setSelectedMode] = useState<SessionMode | ''>('');

  // Steps:
  //   1 – Connect Spotify
  //   2 – Music Survey
  //   3 – Pair Headset
  //   4 – Calibration  (first-time users only, needsCalibration=true)
  //   4/5 – Choose Mode  (always last)
  const totalSteps = needsCalibration ? 5 : 4;
  const PAIR_STEP  = 3;
  const CAL_STEP   = needsCalibration ? 4 : -1;   // -1 means not present
  const MODE_STEP  = needsCalibration ? 5 : 4;    // Choose Mode is always last

  // Step metadata for the progress indicator
  const stepDefs = needsCalibration
    ? [
        { step: 1, label: 'Connect Spotify',  icon: '🎵' },
        { step: 2, label: 'Music Survey',      icon: '🎧' },
        { step: 3, label: 'Pair Headset',      icon: '📡' },
        { step: 4, label: 'Calibration',       icon: '🧬' },
        { step: 5, label: 'Choose Mode',       icon: '✨' },
      ]
    : [
        { step: 1, label: 'Connect Spotify',  icon: '🎵' },
        { step: 2, label: 'Music Survey',      icon: '🎧' },
        { step: 3, label: 'Pair Headset',      icon: '📡' },
        { step: 4, label: 'Choose Mode',       icon: '✨' },
      ];

  const handleGenreToggle = (genre: string) => {
    setPreferredGenres((prev) =>
      prev.includes(genre) ? prev.filter((item) => item !== genre) : [...prev, genre]
    );
  };

  const handleNext = async () => {
    if (!canProceed()) return;

    // Calibration step uses its own CTA (CalibrationStep.onComplete) — skip here
    if (currentStep === CAL_STEP) return;

    if (currentStep < totalSteps) {
      setCurrentStep(currentStep + 1);
      return;
    }

    // Last step (Choose Mode) — save and complete
    localStorage.setItem('neurovibe_music_genres', JSON.stringify(preferredGenres));
    localStorage.setItem('neurovibe_focus_energy', focusEnergy);
    localStorage.setItem('neurovibe_mode', selectedMode);
    onComplete();
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const canProceed = () => {
    if (currentStep === 1) return spotifyAuthenticated;
    if (currentStep === 2) return preferredGenres.length > 0 && focusEnergy !== '';
    if (currentStep === PAIR_STEP) return true;
    if (currentStep === CAL_STEP) return false;  // CalibrationStep drives its own advance
    if (currentStep === MODE_STEP) return selectedMode === 'focus' || selectedMode === 'relaxation' || selectedMode === 'cognitive';
    return false;
  };

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <header className="w-full border-b border-gray-800 bg-black py-4">
        <div className="container mx-auto px-8">
          <button
            onClick={onBackToHome}
            className="text-3xl font-light text-white hover:text-gray-300 transition-colors cursor-pointer"
          >
            NeuroVibe
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="max-w-5xl mx-auto w-full">
          <div className="text-center mb-12">
            <h2 className="text-5xl font-light tracking-tight mb-4 bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent">
              Setup Guide
            </h2>
            <p className="text-gray-400 text-sm tracking-widest uppercase">
              Connect Spotify → Music Survey → Choose Mode → Pair Headset
            </p>
          </div>

          <div className="mb-16">
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {stepDefs.map(({ step, label, icon }, index) => (
                <div key={step} className="flex items-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center font-light text-lg border transition-all duration-500 ${
                      step === currentStep
                        ? 'bg-white border-white text-black scale-110 shadow-lg shadow-white/20'
                        : step < currentStep
                        ? 'bg-purple-500 border-purple-500 text-white'
                        : 'bg-transparent border-gray-700 text-gray-500'
                    }`}>
                      {step < currentStep ? <span className="text-xl">✓</span> : <span className="text-lg">{icon}</span>}
                    </div>
                    <span className={`text-xs tracking-wider transition-colors duration-300 ${
                      step === currentStep ? 'text-white' : step < currentStep ? 'text-purple-400' : 'text-gray-600'
                    }`}>
                      {label}
                    </span>
                  </div>
                  {index < totalSteps - 1 && (
                    <div className={`w-10 md:w-16 h-px mx-2 transition-all duration-500 ${
                      step < currentStep ? 'bg-purple-500' : 'bg-gray-800'
                    }`}></div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border border-gray-800 rounded-3xl p-8 md:p-12 min-h-[520px] flex flex-col justify-between backdrop-blur-sm bg-gray-950/50">
            {currentStep === 1 && (
              <div className="text-center space-y-8">
                <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
                  <span className="text-4xl">🎵</span>
                </div>
                <h2 className="text-4xl md:text-5xl font-light tracking-tight">Connect Spotify</h2>
                <p className="text-lg text-gray-400 max-w-xl mx-auto font-light leading-relaxed">
                  Authenticate with Spotify to enable personalized music recommendations based on your emotions.
                </p>

                {!spotifyAuthenticated && (
                  <button
                    onClick={onSpotifyAuth}
                    className="group relative flex items-center gap-3 px-10 py-4 mx-auto text-base font-light tracking-wide text-white bg-gradient-to-r from-green-500 to-green-600 rounded-full hover:shadow-2xl hover:shadow-green-500/30 transition-all duration-500 transform hover:scale-105"
                  >
                    <span className="text-lg">🎵</span>
                    <span>Connect Spotify</span>
                    <span className="text-lg transition-transform group-hover:translate-x-1">→</span>
                  </button>
                )}

                {spotifyAuthenticated && (
                  <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-8 max-w-lg mx-auto">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                      <span className="text-3xl text-green-400">✓</span>
                    </div>
                    <h3 className="text-2xl font-light text-white mb-2">Spotify Connected</h3>
                    <p className="text-gray-400 font-light">Now tell us what music helps you focus.</p>
                  </div>
                )}
              </div>
            )}

            {currentStep === 2 && (
              <div className="space-y-8">
                <div className="text-center">
                  <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 flex items-center justify-center">
                    <span className="text-4xl">🎧</span>
                  </div>
                  <h2 className="text-4xl md:text-5xl font-light tracking-tight">Music Focus Survey</h2>
                  <p className="text-lg text-gray-400 max-w-2xl mx-auto mt-4 font-light leading-relaxed">
                    What kind of music helps you focus best? Choose the genres you prefer and whether your focus improves more with energetic or calm tracks.
                  </p>
                </div>

                <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
                  <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6">
                    <h3 className="text-lg font-light mb-4 text-gray-200">Preferred focus genres</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {musicGenres.map((genre) => {
                        const isSelected = preferredGenres.includes(genre);
                        return (
                          <button
                            key={genre}
                            onClick={() => handleGenreToggle(genre)}
                            className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                              isSelected
                                ? 'bg-purple-500/20 border-purple-400 text-purple-200'
                                : 'bg-gray-950 border-gray-700 text-gray-400 hover:border-gray-500'
                            }`}
                          >
                            {genre}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-6">
                    <h3 className="text-lg font-light mb-4 text-gray-200">Focus energy preference</h3>
                    <div className="space-y-3">
                      <button
                        onClick={() => setFocusEnergy('energetic')}
                        className={`w-full p-4 rounded-xl border text-left transition-colors ${
                          focusEnergy === 'energetic'
                            ? 'bg-orange-500/20 border-orange-400 text-orange-200'
                            : 'bg-gray-950 border-gray-700 text-gray-400 hover:border-gray-500'
                        }`}
                      >
                        <p className="font-medium">Energetic music</p>
                        <p className="text-sm opacity-80">Upbeat, motivating tracks that keep you alert.</p>
                      </button>
                      <button
                        onClick={() => setFocusEnergy('calm')}
                        className={`w-full p-4 rounded-xl border text-left transition-colors ${
                          focusEnergy === 'calm'
                            ? 'bg-teal-500/20 border-teal-400 text-teal-200'
                            : 'bg-gray-950 border-gray-700 text-gray-400 hover:border-gray-500'
                        }`}
                      >
                        <p className="font-medium">Calm music</p>
                        <p className="text-sm opacity-80">Gentle, low-stimulation tracks for deep concentration.</p>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {currentStep === PAIR_STEP && (
              <div className="text-center space-y-8">
                <div className="mb-8 rounded-2xl overflow-hidden max-w-lg mx-auto border border-gray-800">
                  <Image
                    src={museImage}
                    alt="Muse Headset"
                    width={500}
                    height={350}
                    className="w-full h-auto object-cover"
                  />
                </div>
                <h2 className="text-4xl md:text-5xl font-light tracking-tight">Pair Your Muse Headset</h2>
                <p className="text-lg text-gray-400 max-w-xl mx-auto font-light leading-relaxed">
                  Press and hold the power button until the LED starts blinking blue, then continue to pair and start your session.
                </p>
                <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left space-y-4 max-w-lg mx-auto">
                  <h3 className="font-light text-lg mb-4 text-gray-300 tracking-wide">Before you continue:</h3>
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm text-purple-400">✓</span>
                      </div>
                      <span className="text-gray-400 font-light">Headset is fully charged</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm text-purple-400">✓</span>
                      </div>
                      <span className="text-gray-400 font-light">Bluetooth is enabled on your device</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm text-purple-400">✓</span>
                      </div>
                      <span className="text-gray-400 font-light">LED light is blinking blue</span>
                    </div>
                  </div>
                </div>
                <div className="mt-6 bg-gray-900/50 border border-gray-800 rounded-xl p-4 max-w-lg mx-auto">
                  <p className="text-sm text-gray-400 font-light">
                    On the next page, click &quot;Connect Muse Headset&quot; to complete pairing and begin your selected mode.
                  </p>
                </div>

                {onTestMode && (
                  <div className="mt-8 pt-8 border-t border-gray-800 max-w-lg mx-auto">
                    <p className="text-xs text-gray-600 uppercase tracking-widest mb-4">No headset? Try a demo</p>
                    <button
                      onClick={() => {
                        localStorage.setItem('neurovibe_music_genres', JSON.stringify(preferredGenres));
                        localStorage.setItem('neurovibe_focus_energy', focusEnergy);
                        localStorage.setItem('neurovibe_mode', selectedMode);
                        onTestMode?.();
                      }}
                      className="group flex items-center gap-3 px-8 py-3 mx-auto rounded-full border border-dashed border-gray-600 text-gray-400 hover:border-purple-500 hover:text-purple-300 transition-all duration-300 text-sm font-light tracking-wide"
                    >
                      <span>🧪</span>
                      <span>Use Test Mode</span>
                      <span className="transition-transform group-hover:translate-x-1">→</span>
                    </button>
                    <p className="text-xs text-gray-700 mt-3">Simulates EEG emotions so you can explore the full experience.</p>
                  </div>
                )}
              </div>
            )}

            {needsCalibration && currentStep === CAL_STEP && (
              <CalibrationStep onComplete={() => setCurrentStep(CAL_STEP + 1)} />
            )}

            {currentStep === MODE_STEP && (
              <div className="space-y-8">
                <div className="text-center">
                  <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-pink-400 to-purple-600 flex items-center justify-center">
                    <span className="text-4xl">✨</span>
                  </div>
                  <h2 className="text-4xl md:text-5xl font-light tracking-tight">Choose Your Mode</h2>
                  <p className="text-lg text-gray-400 max-w-2xl mx-auto mt-4 font-light leading-relaxed">
                    Select the experience that best matches your goal for each session.
                  </p>
                </div>

                <div className="grid md:grid-cols-3 gap-4 max-w-5xl mx-auto">
                  <button
                    onClick={() => setSelectedMode('focus')}
                    className={`p-6 rounded-2xl border text-left transition-colors ${
                      selectedMode === 'focus'
                        ? 'bg-indigo-500/20 border-indigo-400'
                        : 'bg-gray-900/50 border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-lg text-indigo-300">🧠</span>
                      <h3 className="text-lg font-medium text-white">Focus Mode</h3>
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed">
                      Tracks your emotion and plays music to help you remain focused. If your emotion spikes, the music shifts toward more alertness.
                    </p>
                  </button>

                  <button
                    onClick={() => setSelectedMode('relaxation')}
                    className={`p-6 rounded-2xl border text-left transition-colors ${
                      selectedMode === 'relaxation'
                        ? 'bg-emerald-500/20 border-emerald-400'
                        : 'bg-gray-900/50 border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-lg text-emerald-300">🍃</span>
                      <h3 className="text-lg font-medium text-white">Relaxation Mode</h3>
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed">
                      Helps you exit negative or high-stress emotional states. It detects spikes in stress or sadness and responds with calming, uplifting music.
                    </p>
                  </button>

                  <button
                    onClick={() => setSelectedMode('cognitive')}
                    className={`p-6 rounded-2xl border text-left transition-colors ${
                      selectedMode === 'cognitive'
                        ? 'bg-fuchsia-500/20 border-fuchsia-400'
                        : 'bg-gray-900/50 border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-lg text-fuchsia-300">⚡</span>
                      <h3 className="text-lg font-medium text-white">Improve Cognitive Power</h3>
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed">
                      Train focus, calm control, reaction stability, and physiological regulation with EEG + PPG guided exercises.
                    </p>
                  </button>
                </div>
              </div>
            )}
          </div>

          {currentStep !== CAL_STEP && (
          <div className="flex justify-between mt-10 gap-4">
            <button
              onClick={handleBack}
              disabled={currentStep === 1}
              className={`group flex items-center gap-2 px-6 py-3 rounded-full font-light tracking-wide transition-all duration-300 ${
                currentStep === 1
                  ? 'bg-gray-900 text-gray-700 cursor-not-allowed border border-gray-800'
                  : 'bg-gray-900 text-white hover:bg-gray-800 border border-gray-800 hover:border-gray-700'
              }`}
            >
              <span className="text-sm transition-transform group-hover:-translate-x-1">←</span>
              <span>Back</span>
            </button>

            <button
              onClick={handleNext}
              disabled={!canProceed()}
              className={`group flex items-center gap-2 px-8 py-3 rounded-full font-light tracking-wide transition-all duration-500 ${
                !canProceed()
                  ? 'bg-gray-900 text-gray-700 cursor-not-allowed border border-gray-800'
                  : currentStep === totalSteps
                  ? 'bg-gradient-to-r from-green-500 to-blue-500 text-white hover:shadow-xl hover:shadow-green-500/30 transform hover:scale-105'
                  : 'bg-white text-black hover:shadow-xl hover:shadow-white/20 transform hover:scale-105'
              }`}
            >
              <span>{currentStep === totalSteps ? 'Start Session' : 'Next'}</span>
              <span className="text-sm transition-transform group-hover:translate-x-1">→</span>
            </button>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
