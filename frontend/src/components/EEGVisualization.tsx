'use client';
import { useEffect, useRef } from 'react';

interface EEGData {
  tp9: number;
  af7: number;
  af8: number;
  tp10: number;
  timestamp: number;
}

interface EEGVisualizationProps {
  eegData: EEGData[];
  maxDataPoints?: number;
  ppgData?: number[];   // raw PPG samples from Muse 2 (optional)
}

export default function EEGVisualization({ eegData, maxDataPoints = 512, ppgData = [] }: EEGVisualizationProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const ppgCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // If no data, show placeholder
    if (eegData.length === 0) {
      ctx.fillStyle = '#666666';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for EEG data...', rect.width / 2, rect.height / 2);
      return;
    }

    // Channel configuration
    const channels = [
      { name: 'TP9', key: 'tp9', color: '#3B82F6' },
      { name: 'AF7', key: 'af7', color: '#10B981' },
      { name: 'AF8', key: 'af8', color: '#F59E0B' },
      { name: 'TP10', key: 'tp10', color: '#EF4444' }
    ];

    const channelHeight = rect.height / channels.length;
    const dataToShow = eegData.slice(-maxDataPoints);

    // Find global min/max for scaling
    let globalMin = Infinity;
    let globalMax = -Infinity;
    dataToShow.forEach(sample => {
      [sample.tp9, sample.af7, sample.af8, sample.tp10].forEach(val => {
        if (val < globalMin) globalMin = val;
        if (val > globalMax) globalMax = val;
      });
    });

    // Add some padding to the range
    const range = globalMax - globalMin;
    const padding = range * 0.2;
    globalMin -= padding;
    globalMax += padding;

    // Draw each channel
    channels.forEach((channel, channelIndex) => {
      const y = channelIndex * channelHeight;
      
      // Draw channel separator
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(rect.width, y);
      ctx.stroke();

      // Draw channel label
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(channel.name, 10, y + 20);

      // Draw waveform
      ctx.strokeStyle = channel.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      dataToShow.forEach((sample, index) => {
        const value = sample[channel.key as keyof EEGData] as number;
        const x = (index / maxDataPoints) * rect.width;
        
        // Scale value to fit in channel height
        const normalizedValue = (value - globalMin) / (globalMax - globalMin);
        const yPos = y + channelHeight - (normalizedValue * channelHeight * 0.8) - (channelHeight * 0.1);
        
        if (index === 0) {
          ctx.moveTo(x, yPos);
        } else {
          ctx.lineTo(x, yPos);
        }
      });

      ctx.stroke();

      // Draw center line
      ctx.strokeStyle = '#444444';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, y + channelHeight / 2);
      ctx.lineTo(rect.width, y + channelHeight / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Draw border
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, rect.width, rect.height);

  }, [eegData, maxDataPoints]);

  // ── PPG canvas rendering ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ppgCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (ppgData.length < 2) {
      ctx.fillStyle = '#666666';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for PPG data…', rect.width / 2, rect.height / 2);
      return;
    }

    const display = ppgData.slice(-maxDataPoints);
    const minVal  = Math.min(...display);
    const maxVal  = Math.max(...display);
    const range   = (maxVal - minVal) || 1;
    const pad     = range * 0.15;

    // Label
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('PPG', 10, 18);

    // Waveform
    ctx.strokeStyle = '#ec4899';   // pink
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    display.forEach((val, i) => {
      const x    = (i / (display.length - 1)) * rect.width;
      const norm = (val - minVal + pad) / (range + 2 * pad);
      const y    = rect.height - norm * rect.height * 0.85 - rect.height * 0.05;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Centre line
    ctx.strokeStyle = '#444444';
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, rect.height / 2);
    ctx.lineTo(rect.width, rect.height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Border
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, rect.width, rect.height);
  }, [ppgData, maxDataPoints]);

  return (
    <div className="w-full h-full flex flex-col gap-2">
      <div className="flex items-center justify-between px-4">
        <h3 className="text-lg font-semibold text-black dark:text-white">
          EEG Signal Visualization
        </h3>
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {eegData.length} samples
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full flex-1 rounded-lg"
        style={{ minHeight: '200px' }}
      />

      {/* PPG waveform panel */}
      <div className="flex items-center justify-between px-4 pt-2">
        <h3 className="text-base font-semibold text-pink-400">
          PPG — Heart Rate
        </h3>
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {ppgData.length} samples
        </span>
      </div>
      <canvas
        ref={ppgCanvasRef}
        className="w-full rounded-lg"
        style={{ height: '80px' }}
      />
    </div>
  );
}
