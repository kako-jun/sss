import { useEffect, useState } from 'react';
import { getStats } from '../../lib/tauri';
import type { Stats } from '../../types';

interface StatsSectionProps {
  isOpen: boolean;
  onStatsLoad?: (stats: Stats | null) => void;
}

export function StatsSection({ isOpen, onStatsLoad }: StatsSectionProps) {
  const [stats, setStats] = useState<Stats | null>(null);

  const loadStats = async () => {
    try {
      const updatedStats = await getStats();
      setStats(updatedStats);
      if (onStatsLoad) {
        onStatsLoad(updatedStats);
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
      setStats(null);
      if (onStatsLoad) {
        onStatsLoad(null);
      }
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadStats();
    }
  }, [isOpen]);

  if (!stats) {
    return null;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-white">スキャン結果</h3>
      <div className="space-y-2 p-4 bg-gray-800 rounded">
        <div className="flex justify-between text-gray-300">
          <span>画像数:</span>
          <span className="font-mono">{stats.totalImages.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
