import { useState, useEffect } from 'react';
import { getDisplayStats, getStats } from '../../lib/tauri';
import type { Stats } from '../../types';

export function GraphSection() {
  const [displayStats, setDisplayStats] = useState<Array<[string, number]>>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      setIsLoading(true);
      try {
        const [graphStats, summaryStats] = await Promise.all([
          getDisplayStats(),
          getStats(),
        ]);
        setDisplayStats(graphStats);
        setStats(summaryStats);
      } catch (err) {
        console.error('Failed to load display stats:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadStats();
  }, []);

  if (isLoading) {
    return (
      <div className="p-4 bg-gray-800 rounded text-center text-gray-400">
        読み込み中...
      </div>
    );
  }

  if (displayStats.length === 0) {
    return (
      <div className="p-4 bg-gray-800 rounded text-center text-gray-400">
        データがありません。スキャンを実行してください。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stats && (
        <div className="p-4 bg-gray-800 rounded">
          <div className="flex justify-between text-gray-300">
            <span>1回でも表示済みのファイル数:</span>
            <span className="font-mono">{stats.displayedImages.toLocaleString()}</span>
          </div>
        </div>
      )}

      <div className="p-4 bg-gray-800 rounded">
        <h3 className="text-lg font-semibold text-white mb-4">画像ごとの表示回数</h3>
        <div className="h-64 flex items-end gap-px overflow-x-auto bg-gray-900 rounded p-3">
          {displayStats.map(([path, count], index) => {
            const maxCount = Math.max(...displayStats.map(([, c]) => c));
            const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
            return (
              <div
                key={index}
                className="flex-1 min-w-[2px] bg-gray-500 hover:bg-gray-400 transition-colors cursor-pointer"
                style={{ height: `${height}%` }}
                title={`${path.split('\\').pop() || path.split('/').pop()}: ${count}回`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
