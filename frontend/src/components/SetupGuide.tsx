'use client';
import { useState } from 'react';
import Image from 'next/image';
import museImage from '@/assets/muse.jpg';
import pairImage from '@/assets/pair.png';

interface SetupGuideProps {
  onConnect: () => Promise<void>;
  onSpotifyAuth: () => void;
  onComplete: () => void;
  isConnecting: boolean;
  isConnected: boolean;
  spotifyAuthenticated: boolean;
  connectionStatus: string;
}

export default function SetupGuide({ 
  onConnect, 
  onSpotifyAuth,
  onComplete,
  isConnecting, 
  isConnected,
  spotifyAuthenticated,
  connectionStatus 
}: SetupGuideProps) {
  const [currentStep, setCurrentStep] = useState(1);

  const handleNext = async () => {
    if (currentStep === 1) {
      // Just move to next step - instructions only
      setCurrentStep(2);
    } else if (currentStep === 2) {
      // Connect Muse before moving forward
      if (!isConnected) {
        await onConnect();
      }
      // Wait for connection to complete
      if (isConnected) {
        setCurrentStep(3);
      }
    } else if (currentStep === 3) {
      // Check Spotify auth before completing
      if (spotifyAuthenticated) {
        onComplete();
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const canProceed = () => {
    if (currentStep === 1) return true;
    if (currentStep === 2) return isConnected;
    if (currentStep === 3) return spotifyAuthenticated;
    return false;
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white p-8">
      <div className="max-w-3xl mx-auto w-full">
        {/* Progress Bar */}
        <div className="mb-12">
          <div className="flex items-center justify-center gap-4">
            {[1, 2, 3].map((step) => (
              <div key={step} className="flex items-center">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg border-2 transition-all ${
                  step === currentStep 
                    ? 'bg-purple-500 border-purple-500 text-white scale-110' 
                    : step < currentStep
                    ? 'bg-green-500 border-green-500 text-white'
                    : 'bg-gray-800 border-gray-600 text-gray-400'
                }`}>
                  {step < currentStep ? '✓' : step}
                </div>
                {step < 3 && (
                  <div className={`w-24 h-1 mx-2 transition-all ${
                    step < currentStep ? 'bg-green-500' : 'bg-gray-700'
                  }`}></div>
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-4 text-sm text-gray-400 px-4">
            <span className={currentStep === 1 ? 'text-purple-400 font-semibold' : ''}>Power On</span>
            <span className={currentStep === 2 ? 'text-purple-400 font-semibold' : ''}>Connect Muse</span>
            <span className={currentStep === 3 ? 'text-purple-400 font-semibold' : ''}>Spotify Auth</span>
          </div>
        </div>

        {/* Step Content */}
        <div className="bg-gray-900 rounded-2xl p-12 border border-gray-800 min-h-[400px] flex flex-col justify-between">
          {/* Step 1: Power On Instructions */}
          {currentStep === 1 && (
            <div className="text-center space-y-6">
              <div className="mb-6 rounded-xl overflow-hidden max-w-md mx-auto">
                <Image 
                  src={museImage} 
                  alt="Muse Headset" 
                  width={400}
                  height={300}
                  className="w-full h-auto object-cover"
                />
              </div>
              <h2 className="text-4xl font-bold mb-4">Power On Your Muse Headset</h2>
              <p className="text-xl text-gray-400 mb-8">
                Press and hold the power button on your Muse headset until the LED starts blinking blue.
              </p>
              <div className="bg-gray-800 rounded-xl p-6 text-left space-y-4">
                <h3 className="font-semibold text-lg mb-3">Checklist:</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">✓</span>
                    <span className="text-gray-300">Headset is charged</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">✓</span>
                    <span className="text-gray-300">Bluetooth is enabled on your device</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">✓</span>
                    <span className="text-gray-300">LED light is blinking blue</span>
                  </div>
                </div>
              </div>
              <div className="mt-6 bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                <p className="text-sm text-blue-400">💡 Tip: Make sure your headset is not connected to any other device</p>
              </div>
            </div>
          )}

          {/* Step 2: Connect Muse */}
          {currentStep === 2 && (
            <div className="text-center space-y-6">
              <div className="mb-6 rounded-xl overflow-hidden max-w-md mx-auto">
                <Image 
                  src={pairImage} 
                  alt="Bluetooth Pairing" 
                  width={400}
                  height={300}
                  className="w-full h-auto object-cover"
                />
              </div>
              <h2 className="text-4xl font-bold mb-4">Connect Your Muse Headset</h2>
              <p className="text-xl text-gray-400 mb-8">
                Click the button below to open the Bluetooth device selector and choose your Muse headset.
              </p>
              
              {!isConnected && !isConnecting && (
                <button
                  onClick={onConnect}
                  className="px-12 py-4 text-lg font-bold text-white bg-gradient-to-r from-blue-500 to-purple-500 rounded-full hover:shadow-2xl hover:shadow-purple-500/50 transition-all duration-300 transform hover:scale-105"
                >
                  Open Device Selector
                </button>
              )}

              {isConnecting && (
                <div className="flex flex-col items-center gap-4">
                  <svg className="animate-spin h-12 w-12 text-purple-500" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <p className="text-lg text-gray-400">Connecting to Muse...</p>
                </div>
              )}

              {isConnected && (
                <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-6">
                  <div className="text-6xl mb-4">✓</div>
                  <h3 className="text-2xl font-semibold text-green-400 mb-2">Successfully Connected!</h3>
                  <p className="text-gray-400">Your Muse headset is now streaming data</p>
                </div>
              )}

              {connectionStatus && (
                <div className={`mt-4 p-4 rounded-lg ${
                  connectionStatus.includes('failed') || connectionStatus.includes('cancelled')
                    ? 'bg-red-500/10 border border-red-500/30 text-red-400'
                    : connectionStatus.includes('success')
                    ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                    : 'bg-blue-500/10 border border-blue-500/30 text-blue-400'
                }`}>
                  {connectionStatus}
                </div>
              )}

              <div className="mt-6 bg-gray-800 rounded-lg p-4 text-left">
                <p className="text-sm text-gray-400">
                  <strong>Note:</strong> Look for a device starting with "Muse" in the Bluetooth device list
                </p>
              </div>
            </div>
          )}

          {/* Step 3: Spotify Auth */}
          {currentStep === 3 && (
            <div className="text-center space-y-6">
              <div className="text-8xl mb-6">🎵</div>
              <h2 className="text-4xl font-bold mb-4">Connect to Spotify</h2>
              <p className="text-xl text-gray-400 mb-8">
                Authenticate with your Spotify account to enable personalized music recommendations.
              </p>

              <div className="bg-gray-800 rounded-xl p-6 mb-6">
                <div className="flex items-start gap-4 text-left">
                  <div className="text-2xl text-green-500 mt-1">✓</div>
                  <div className="flex-1">
                    <h3 className="font-semibold mb-2">Muse Headset Connected</h3>
                    <p className="text-sm text-gray-400">Streaming EEG data successfully</p>
                  </div>
                </div>
              </div>

              {!spotifyAuthenticated && (
                <button
                  onClick={onSpotifyAuth}
                  className="px-12 py-4 text-lg font-bold text-white bg-gradient-to-r from-green-500 to-green-600 rounded-full hover:shadow-2xl hover:shadow-green-500/50 transition-all duration-300 transform hover:scale-105"
                >
                  Connect Spotify Account
                </button>
              )}

              {spotifyAuthenticated && (
                <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-6">
                  <div className="text-6xl mb-4">✓</div>
                  <h3 className="text-2xl font-semibold text-green-400 mb-2">Spotify Connected!</h3>
                  <p className="text-gray-400">You're all set to start listening</p>
                </div>
              )}

              <div className="mt-6 bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                <p className="text-sm text-blue-400">💡 A Spotify Premium account is recommended for the best experience</p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation Buttons */}
        <div className="flex justify-between mt-8">
          <button
            onClick={handleBack}
            disabled={currentStep === 1}
            className={`px-8 py-3 rounded-full font-semibold transition-all ${
              currentStep === 1
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-gray-800 text-white hover:bg-gray-700'
            }`}
          >
            ← Back
          </button>

          <button
            onClick={handleNext}
            disabled={!canProceed() || isConnecting}
            className={`px-8 py-3 rounded-full font-semibold transition-all ${
              !canProceed() || isConnecting
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : currentStep === 3
                ? 'bg-gradient-to-r from-green-500 to-blue-500 text-white hover:shadow-xl hover:shadow-green-500/50 transform hover:scale-105'
                : 'bg-gradient-to-r from-blue-500 to-purple-500 text-white hover:shadow-xl hover:shadow-purple-500/50 transform hover:scale-105'
            }`}
          >
            {currentStep === 3 ? 'Start Listening →' : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
}
