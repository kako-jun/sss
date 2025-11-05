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
        <div className="flex justify-between text-gray-300">
          <span>1回でも表示済みのファイル数:</span>
          <span className="font-mono">{stats.displayedImages.toLocaleString()} / {stats.totalImages.toLocaleString()}</span>
        </div>
      )}

      <div className="bg-gray-800 rounded p-4">
        <h3 className="text-lg font-semibold text-white mb-4">画像ごとの表示回数</h3>
        <div className="h-64 bg-gray-900 rounded p-3 relative">
          {/* Y軸グリッド線 */}
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="border-t border-gray-700/50" />
            ))}
          </div>
          {/* X軸基準線（0の位置） */}
          <div className="absolute bottom-3 left-3 right-3 border-b border-gray-500 pointer-events-none" />
          {/* グラフバー */}
          <div className="h-full flex items-end relative">
            {displayStats.map(([path, count], index) => {
              const maxCount = Math.max(...displayStats.map(([, c]) => c));
              const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return (
                <div
                  key={index}
                  className="flex-1 bg-blue-500 hover:bg-blue-400 transition-colors cursor-pointer"
                  style={{ height: `${height}%` }}
                  title={`${path.split('\\').pop() || path.split('/').pop()}: ${count}回`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
