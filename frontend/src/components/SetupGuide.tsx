'use client';
import { useState } from 'react';
import Image from 'next/image';
import { Brain, Bluetooth, Music, CheckCircle2, ArrowRight, ArrowLeft } from 'lucide-react';
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
  onBackToHome?: () => void;
}

export default function SetupGuide({ 
  onConnect, 
  onSpotifyAuth,
  onComplete,
  isConnecting, 
  isConnected,
  spotifyAuthenticated,
  connectionStatus,
  onBackToHome 
}: SetupGuideProps) {
  const [currentStep, setCurrentStep] = useState(1);

  const handleNext = async () => {
    if (currentStep === 1) {
      setCurrentStep(2);
    } else if (currentStep === 2) {
      if (!isConnected) {
        await onConnect();
      }
      if (isConnected) {
        setCurrentStep(3);
      }
    } else if (currentStep === 3) {
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
    <div className="flex min-h-screen flex-col bg-black text-white">
      {/* Header */}
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
        <div className="max-w-4xl mx-auto w-full">
          {/* Page Title */}
          <div className="text-center mb-12">
            <h2 className="text-5xl font-light tracking-tight mb-4 bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent">
              Setup Guide
            </h2>
            <p className="text-gray-400 text-sm tracking-widest uppercase">
              Let's get you connected
            </p>
          </div>

        {/* Progress Bar */}
        <div className="mb-16">
          <div className="flex items-center justify-center gap-2">
            {[
              { step: 1, label: 'Power On', icon: Brain },
              { step: 2, label: 'Connect Muse', icon: Bluetooth },
              { step: 3, label: 'Spotify', icon: Music }
            ].map(({ step, label, icon: Icon }, index) => (
              <div key={step} className="flex items-center">
                <div className="flex flex-col items-center gap-2">
                  <div className={`w-14 h-14 rounded-full flex items-center justify-center font-light text-lg border transition-all duration-500 ${
                    step === currentStep 
                      ? 'bg-white border-white text-black scale-110 shadow-lg shadow-white/20' 
                      : step < currentStep
                      ? 'bg-purple-500 border-purple-500 text-white'
                      : 'bg-transparent border-gray-700 text-gray-500'
                  }`}>
                    {step < currentStep ? <CheckCircle2 className="w-6 h-6" /> : <Icon className="w-5 h-5" strokeWidth={1.5} />}
                  </div>
                  <span className={`text-xs tracking-wider transition-colors duration-300 ${
                    step === currentStep ? 'text-white' : step < currentStep ? 'text-purple-400' : 'text-gray-600'
                  }`}>
                    {label}
                  </span>
                </div>
                {index < 2 && (
                  <div className={`w-20 h-px mx-4 transition-all duration-500 ${
                    step < currentStep ? 'bg-purple-500' : 'bg-gray-800'
                  }`}></div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <div className="border border-gray-800 rounded-3xl p-8 md:p-12 min-h-[500px] flex flex-col justify-between backdrop-blur-sm bg-gray-950/50">
          {/* Step 1: Power On Instructions */}
          {currentStep === 1 && (
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
              <h2 className="text-4xl md:text-5xl font-light tracking-tight">Power On Your Muse</h2>
              <p className="text-lg text-gray-400 max-w-xl mx-auto font-light leading-relaxed">
                Press and hold the power button until the LED starts blinking blue.
              </p>
              <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-8 text-left space-y-4 max-w-lg mx-auto">
                <h3 className="font-light text-lg mb-4 text-gray-300 tracking-wide">Before you continue:</h3>
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center flex-shrink-0">
                      <CheckCircle2 className="w-4 h-4 text-purple-400" strokeWidth={2} />
                    </div>
                    <span className="text-gray-400 font-light">Headset is fully charged</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center flex-shrink-0">
                      <CheckCircle2 className="w-4 h-4 text-purple-400" strokeWidth={2} />
                    </div>
                    <span className="text-gray-400 font-light">Bluetooth is enabled on your device</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/50 flex items-center justify-center flex-shrink-0">
                      <CheckCircle2 className="w-4 h-4 text-purple-400" strokeWidth={2} />
                    </div>
                    <span className="text-gray-400 font-light">LED light is blinking blue</span>
                  </div>
                </div>
              </div>
              <div className="mt-8 bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 max-w-lg mx-auto">
                <p className="text-sm text-blue-400/80 font-light">💡 Make sure your headset isn't connected to any other device</p>
              </div>
            </div>
          )}

          {/* Step 2: Connect Muse */}
          {currentStep === 2 && (
            <div className="text-center space-y-8">
              <div className="mb-8 rounded-2xl overflow-hidden max-w-lg mx-auto border border-gray-800">
                <Image 
                  src={pairImage} 
                  alt="Bluetooth Pairing" 
                  width={500}
                  height={350}
                  className="w-full h-auto object-cover"
                />
              </div>
              <h2 className="text-4xl md:text-5xl font-light tracking-tight">Connect Your Headset</h2>
              <p className="text-lg text-gray-400 max-w-xl mx-auto font-light leading-relaxed">
                Select your Muse device from the Bluetooth pairing dialog.
              </p>
              
              {!isConnected && !isConnecting && (
                <button
                  onClick={onConnect}
                  className="group relative flex items-center gap-3 px-10 py-4 mx-auto text-base font-light tracking-wide text-black bg-white rounded-full hover:shadow-2xl hover:shadow-white/20 transition-all duration-500 transform hover:scale-105"
                >
                  <Bluetooth className="w-5 h-5" strokeWidth={1.5} />
                  <span>Open Device Selector</span>
                  <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" strokeWidth={1.5} />
                </button>
              )}

              {isConnecting && (
                <div className="flex flex-col items-center gap-6 py-8">
                  <div className="relative">
                    <div className="w-16 h-16 rounded-full border-2 border-gray-800"></div>
                    <div className="absolute inset-0 w-16 h-16 rounded-full border-2 border-t-white border-r-white border-b-transparent border-l-transparent animate-spin"></div>
                  </div>
                  <p className="text-lg text-gray-400 font-light">Connecting to Muse...</p>
                </div>
              )}

              {isConnected && (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-8 max-w-lg mx-auto">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-purple-500/20 flex items-center justify-center">
                    <CheckCircle2 className="w-8 h-8 text-purple-400" strokeWidth={1.5} />
                  </div>
                  <h3 className="text-2xl font-light text-white mb-2">Successfully Connected</h3>
                  <p className="text-gray-400 font-light">Your Muse headset is now streaming data</p>
                </div>
              )}

              {connectionStatus && (
                <div className={`mt-6 p-4 rounded-xl max-w-lg mx-auto ${
                  connectionStatus.includes('failed') || connectionStatus.includes('cancelled')
                    ? 'bg-red-500/5 border border-red-500/20 text-red-400'
                    : connectionStatus.includes('success')
                    ? 'bg-green-500/5 border border-green-500/20 text-green-400'
                    : 'bg-blue-500/5 border border-blue-500/20 text-blue-400'
                }`}>
                  <p className="text-sm font-light">{connectionStatus}</p>
                </div>
              )}

              <div className="mt-8 bg-gray-900/50 border border-gray-800 rounded-xl p-4 max-w-lg mx-auto">
                <p className="text-sm text-gray-500 font-light">
                  Look for a device starting with <span className="text-gray-300">"Muse"</span> in the Bluetooth list
                </p>
              </div>
            </div>
          )}

          {/* Step 3: Spotify Auth */}
          {currentStep === 3 && (
            <div className="text-center space-y-8">
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
                <Music className="w-10 h-10 text-white" strokeWidth={1.5} />
              </div>
              <h2 className="text-4xl md:text-5xl font-light tracking-tight">Connect Spotify</h2>
              <p className="text-lg text-gray-400 max-w-xl mx-auto font-light leading-relaxed">
                Authenticate with Spotify to enable personalized music recommendations.
              </p>

              <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-6 max-w-lg mx-auto">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 className="w-6 h-6 text-purple-400" strokeWidth={1.5} />
                  </div>
                  <div className="flex-1 text-left">
                    <h3 className="font-light mb-1 text-white">Muse Connected</h3>
                    <p className="text-sm text-gray-400 font-light">Streaming EEG data successfully</p>
                  </div>
                </div>
              </div>

              {!spotifyAuthenticated && (
                <button
                  onClick={onSpotifyAuth}
                  className="group relative flex items-center gap-3 px-10 py-4 mx-auto text-base font-light tracking-wide text-white bg-gradient-to-r from-green-500 to-green-600 rounded-full hover:shadow-2xl hover:shadow-green-500/30 transition-all duration-500 transform hover:scale-105"
                >
                  <Music className="w-5 h-5" strokeWidth={1.5} />
                  <span>Connect Spotify</span>
                  <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" strokeWidth={1.5} />
                </button>
              )}

              {spotifyAuthenticated && (
                <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-8 max-w-lg mx-auto">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                    <CheckCircle2 className="w-8 h-8 text-green-400" strokeWidth={1.5} />
                  </div>
                  <h3 className="text-2xl font-light text-white mb-2">Spotify Connected</h3>
                  <p className="text-gray-400 font-light">You're all set to start listening</p>
                </div>
              )}

              <div className="mt-8 bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 max-w-lg mx-auto">
                <p className="text-sm text-blue-400/80 font-light">💡 A Spotify Premium account is recommended for the best experience</p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation Buttons */}
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
            <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-1" strokeWidth={1.5} />
            <span>Back</span>
          </button>

          <button
            onClick={handleNext}
            disabled={!canProceed() || isConnecting}
            className={`group flex items-center gap-2 px-8 py-3 rounded-full font-light tracking-wide transition-all duration-500 ${
              !canProceed() || isConnecting
                ? 'bg-gray-900 text-gray-700 cursor-not-allowed border border-gray-800'
                : currentStep === 3
                ? 'bg-gradient-to-r from-green-500 to-blue-500 text-white hover:shadow-xl hover:shadow-green-500/30 transform hover:scale-105'
                : 'bg-white text-black hover:shadow-xl hover:shadow-white/20 transform hover:scale-105'
            }`}
          >
            <span>{currentStep === 3 ? 'Start Listening' : 'Next'}</span>
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" strokeWidth={1.5} />
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
