"use client";

import { useState } from "react";
import Player from "@/components/player";
import MuseConnector from "@/components/MuseConnector";

export default function Home() {
  const [selectedEmotion, setSelectedEmotion] = useState<string>("happy");
  const [predictedEmotion, setPredictedEmotion] = useState<string>("");
  const [useMusePrediction, setUseMusePrediction] = useState<boolean>(false);

  const emotions = [
    { name: "happy", color: "bg-yellow-400" },
    { name: "sad", color: "bg-blue-500" },
    { name: "angry", color: "bg-red-500" },
    { name: "relaxed", color: "bg-green-400" },
  ];

  const getCurrentColor = () => {
    const currentEmotion = useMusePrediction ? predictedEmotion.toLowerCase() : selectedEmotion;
    return emotions.find((e) => e.name === currentEmotion)?.color || "bg-gray-300";
  };

  const getDisplayEmotion = () => {
    return useMusePrediction ? predictedEmotion : selectedEmotion;
  };

  const handleEmotionPrediction = (emotion: string) => {
    setPredictedEmotion(emotion);
    setUseMusePrediction(true);
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      {/* Header */}
      <header className="w-full border-b border-zinc-200 bg-white py-6 dark:border-zinc-800 dark:bg-black">
        <div className="container mx-auto px-8">
          <h1 className="text-3xl font-bold text-black dark:text-white">
            NeuroVibe
          </h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 flex-col lg:flex-row">
        {/* Left Side - Emotion Circle & Muse Connector */}
        <div className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
          {/* Muse Connection Status */}
          <div className="w-full max-w-md">
            <MuseConnector onEmotionPredicted={handleEmotionPrediction} />
          </div>

          {/* Circle */}
          <div
            className={`flex h-64 w-64 items-center justify-center rounded-full ${getCurrentColor()} transition-colors duration-500 shadow-lg`}
          >
            <div className="text-center">
              <span className="text-3xl font-semibold capitalize text-white">
                {getDisplayEmotion()}
              </span>
              {useMusePrediction && (
                <p className="mt-2 text-sm text-white/80">
                  🧠 Live from Muse
                </p>
              )}
            </div>
          </div>

          {/* Manual Override Toggle */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="use-muse"
                checked={useMusePrediction}
                onChange={(e) => setUseMusePrediction(e.target.checked)}
                disabled={!predictedEmotion}
                className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <label
                htmlFor="use-muse"
                className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Use Muse Prediction
                {predictedEmotion && ` (${predictedEmotion})`}
              </label>
            </div>

            {/* Manual Dropdown */}
            <div className="flex flex-col gap-2">
              <label
                htmlFor="emotion-select"
                className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Manual Override
              </label>
              <select
                id="emotion-select"
                value={selectedEmotion}
                onChange={(e) => {
                  setSelectedEmotion(e.target.value);
                  setUseMusePrediction(false);
                }}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-base text-black focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
              >
                {emotions.map((emotion) => (
                  <option key={emotion.name} value={emotion.name}>
                    {emotion.name.charAt(0).toUpperCase() + emotion.name.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Right Side - Spotify Player */}
        <div className="flex flex-1 items-center justify-center border-l border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
          <Player emotion={useMusePrediction ? predictedEmotion.toLowerCase() : selectedEmotion} />
        </div>
      </main>
    </div>
  );
}
