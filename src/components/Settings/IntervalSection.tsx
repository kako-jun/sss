import { useState, useEffect } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';
import { DEFAULT_DISPLAY_INTERVAL, MIN_DISPLAY_INTERVAL, MAX_DISPLAY_INTERVAL } from '../../constants';

interface IntervalSectionProps {
  onIntervalChange?: (interval: number) => void;
}

export function IntervalSection({ onIntervalChange }: IntervalSectionProps) {
  const [displayInterval, setDisplayInterval] = useState<number>(DEFAULT_DISPLAY_INTERVAL);

  useEffect(() => {
    getSetting('display_interval').then((value) => {
      if (value) {
        setDisplayInterval(parseInt(value, 10));
      }
    }).catch(console.error);
  }, []);

  const handleIntervalChange = async (value: number) => {
    setDisplayInterval(value);
    try {
      await saveSetting('display_interval', value.toString());
      if (onIntervalChange) {
        onIntervalChange(value);
      }
    } catch (err) {
      console.error('Failed to save display interval:', err);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-white">表示間隔</h3>
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={MIN_DISPLAY_INTERVAL}
          max={MAX_DISPLAY_INTERVAL}
          value={displayInterval / 1000}
          onChange={(e) => handleIntervalChange(parseInt(e.target.value) * 1000)}
          className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MIN_DISPLAY_INTERVAL}
            max={MAX_DISPLAY_INTERVAL}
            value={displayInterval / 1000}
            onChange={(e) => {
              const value = Math.max(MIN_DISPLAY_INTERVAL, Math.min(MAX_DISPLAY_INTERVAL, parseInt(e.target.value) || MIN_DISPLAY_INTERVAL));
              handleIntervalChange(value * 1000);
            }}
            className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center"
          />
          <span className="text-gray-400 text-sm">秒</span>
        </div>
      </div>
    </div>
  );
}
