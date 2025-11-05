import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { getDisplayStats } from '../../lib/tauri';

export function GraphSection() {
  const [displayStats, setDisplayStats] = useState<Array<[string, number]>>([]);
  const [showGraph, setShowGraph] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const toggleGraph = async () => {
    if (!showGraph) {
      setIsLoading(true);
      try {
        const stats = await getDisplayStats();
        setDisplayStats(stats);
      } catch (err) {
        console.error('Failed to load display stats:', err);
      } finally {
        setIsLoading(false);
      }
    }
    setShowGraph(!showGraph);
  };

  return (
    <div className="space-y-4">
      <button
        onClick={toggleGraph}
        disabled={isLoading}
        className="w-full flex items-center justify-between p-4 bg-gray-800 rounded hover:bg-gray-750 transition text-white font-semibold"
      >
        <span>表示回数グラフ</span>
        <BarChart3
          size={18}
          className={`transition-transform ${showGraph ? 'rotate-180' : ''} ${isLoading ? 'animate-spin' : ''}`}
        />
      </button>

      {showGraph && displayStats.length > 0 && (
        <div className="p-4 bg-gray-800 rounded">
          <div className="h-64 flex items-end gap-px overflow-x-auto bg-gray-900 rounded p-3">
            {displayStats.map(([path, count], index) => {
              const maxCount = Math.max(...displayStats.map(([, c]) => c));
              const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return (
                <div
                  key={index}
                  className="flex-1 min-w-[2px] bg-blue-500 hover:bg-blue-400 transition-colors cursor-pointer"
                  style={{ height: `${height}%` }}
                  title={`${path.split('\\').pop() || path.split('/').pop()}: ${count}回`}
                />
              );
            })}
          </div>
          <div className="mt-3 text-xs text-gray-400 text-center">
            各バーは画像1枚の表示回数（全{displayStats.length.toLocaleString()}枚）
          </div>
          <div className="mt-2 text-xs text-gray-500 text-center">
            完全平等ランダムアルゴリズムの検証：全てのバーが均等であれば正常動作
          </div>
        </div>
      )}

      {showGraph && displayStats.length === 0 && !isLoading && (
        <div className="p-4 bg-gray-800 rounded text-center text-gray-400">
          データがありません。スキャンを実行してください。
        </div>
      )}
    </div>
  );
}
