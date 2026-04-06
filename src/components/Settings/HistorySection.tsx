import { Ban, ChevronRight } from 'lucide-react';
import { useState, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getRecentImages, excludeImage } from '../../lib/tauri';
import type { RecentImage } from '../../types';

export function HistorySection() {
  const [images, setImages] = useState<RecentImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  useEffect(() => {
    getRecentImages()
      .then((result) => {
        setImages(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load recent images:', err);
        setLoading(false);
      });
  }, []);

  const handleExclude = async (path: string, type: 'date' | 'file' | 'directory') => {
    try {
      await excludeImage(path, type);
      setImages((prev) => prev.filter((img) => img.path !== path));
      setActiveMenu(null);
    } catch (err) {
      console.error('Failed to exclude image:', err);
    }
  };

  if (loading) {
    return <div className="text-white/30 text-sm">読み込み中...</div>;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">
        最近の表示履歴（最新100件）
      </h3>

      {images.length === 0 ? (
        <div className="p-4 bg-black/30 rounded text-center text-white/30 text-sm border border-white/5">
          表示履歴はありません
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {images.map((img) => (
            <div key={img.path} className="relative group">
              <img
                src={convertFileSrc(img.path)}
                alt=""
                className="w-full aspect-square object-cover rounded border border-white/5"
                loading="lazy"
              />
              {/* 表示回数 */}
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white/50 text-xs text-center py-0.5 rounded-b">
                &times;{img.display_count}
              </div>
              {/* 除外ボタン */}
              <button
                onClick={() => setActiveMenu(activeMenu === img.path ? null : img.path)}
                className="absolute top-1 right-1 p-0.5 bg-black/70 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/90"
                title="除外"
              >
                <Ban className="w-3.5 h-3.5 text-white/60 hover:text-white/90" />
              </button>
              {/* 除外サブメニュー */}
              {activeMenu === img.path && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setActiveMenu(null)} />
                  <div className="absolute top-7 right-0 bg-black/90 rounded shadow-xl border border-white/8 p-1.5 space-y-0.5 w-44 z-50 backdrop-blur-sm">
                    <button
                      onClick={() => handleExclude(img.path, 'file')}
                      className="w-full p-1.5 rounded hover:bg-white/8 text-left text-xs text-white/50 hover:text-white/80 transition-colors flex items-center gap-1.5"
                    >
                      <ChevronRight size={10} />
                      この写真を除外
                    </button>
                    <button
                      onClick={() => handleExclude(img.path, 'date')}
                      className="w-full p-1.5 rounded hover:bg-white/8 text-left text-xs text-white/50 hover:text-white/80 transition-colors flex items-center gap-1.5"
                    >
                      <ChevronRight size={10} />
                      この日付を除外
                    </button>
                    <button
                      onClick={() => handleExclude(img.path, 'directory')}
                      className="w-full p-1.5 rounded hover:bg-white/8 text-left text-xs text-white/50 hover:text-white/80 transition-colors flex items-center gap-1.5"
                    >
                      <ChevronRight size={10} />
                      このフォルダを除外
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
