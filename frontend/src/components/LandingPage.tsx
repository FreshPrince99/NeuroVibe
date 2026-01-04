'use client';

interface LandingPageProps {
  onGetStarted: () => void;
}

export default function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white p-8">
      <div className="max-w-4xl mx-auto text-center space-y-8">
        {/* Logo/Title */}
        <div className="space-y-4">
          <h1 className="text-7xl font-bold bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent">
            NeuroVibe
          </h1>
          <p className="text-2xl text-gray-300">
            Music That Reads Your Mind
          </p>
        </div>

        {/* Description */}
        <div className="space-y-6 text-lg text-gray-400 max-w-2xl mx-auto">
          <p>
            Experience the future of personalized music streaming powered by your brain waves.
          </p>
          <p>
            NeuroVibe uses cutting-edge EEG technology to analyze your emotional state in real-time 
            and automatically curate the perfect playlist for your mood.
          </p>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12 mb-12">
          <div className="p-6 rounded-xl bg-gray-900 border border-gray-800 hover:border-purple-500 transition-all">
            <div className="text-4xl mb-4">🧠</div>
            <h3 className="text-xl font-semibold mb-2">Brain-Powered</h3>
            <p className="text-gray-400 text-sm">
              Advanced AI analyzes your EEG signals to understand your emotional state
            </p>
          </div>
          
          <div className="p-6 rounded-xl bg-gray-900 border border-gray-800 hover:border-blue-500 transition-all">
            <div className="text-4xl mb-4">🎵</div>
            <h3 className="text-xl font-semibold mb-2">Smart Playlists</h3>
            <p className="text-gray-400 text-sm">
              Get personalized music recommendations that match your current mood
            </p>
          </div>
          
          <div className="p-6 rounded-xl bg-gray-900 border border-gray-800 hover:border-pink-500 transition-all">
            <div className="text-4xl mb-4">⚡</div>
            <h3 className="text-xl font-semibold mb-2">Real-Time Sync</h3>
            <p className="text-gray-400 text-sm">
              Experience seamless adaptation as your emotions change throughout the day
            </p>
          </div>
        </div>

        {/* CTA Button */}
        <div className="pt-8">
          <button
            onClick={onGetStarted}
            className="group relative px-12 py-6 text-xl font-bold text-white bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 rounded-full hover:shadow-2xl hover:shadow-purple-500/50 transition-all duration-300 transform hover:scale-105"
          >
            <span className="relative z-10">Get Connected</span>
            <div className="absolute inset-0 rounded-full bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-xl"></div>
          </button>
        </div>

        {/* Tech Stack */}
        <div className="pt-12 text-sm text-gray-500">
          <p>Powered by Muse EEG • KAN Neural Network • Spotify API</p>
        </div>
      </div>
    </div>
  );
}
