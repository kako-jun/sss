import { Ban, ChevronRight } from 'lucide-react';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { getRecentImages, excludeImage } from '../../lib/tauri';
import type { RecentImage } from '../../types';
import { useT } from '../../lib/i18n';
import { Thumbnail } from './Thumbnail';

export function HistorySection() {
  const t = useT();
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
    // #66レビュー2巡目nit: /30→/50（他の説明/補助テキストと同じ濃さに統一）。
    return <div className="text-white/50 text-sm">{t('loadingLabel')}</div>;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/70">{t('recentHistoryTitle')}</h3>

      {images.length === 0 ? (
        <div className="p-4 bg-black/30 rounded-lg text-center text-white/50 text-sm">
          {t('noHistoryItems')}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {images.map((img) => (
            <div key={img.path} className="relative group">
              <Thumbnail path={img.path} />
              {/* 表示回数 */}
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white/50 text-xs text-center py-0.5 rounded-b">
                &times;{img.displayCount}
              </div>
              {/* 除外ボタン */}
              <button
                onClick={() => setActiveMenu(activeMenu === img.path ? null : img.path)}
                // #66 問題9: hoverのみで表示されるとキーボード/タッチで見えなかった。
                // 既定でも薄く見せ、hover/focusで強調する。
                className="absolute top-1 right-1 p-0.5 bg-black/70 rounded opacity-40 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-black/90"
                title={t('excludeMenuLabel')}
                aria-label={t('excludeMenuLabel')}
              >
                <Ban className="w-3.5 h-3.5 text-white/60 hover:text-white/90" />
              </button>
              {/* 除外サブメニュー */}
              {activeMenu === img.path && (
                <>
                  {/* #66レビュー3巡目must（OverlayUIと同じ問題の点検で発見）:
                      設定モーダルのパネル（motion.divでanimate={{scale:1}}を
                      持つ）は静止時も`transform: scale(1)`をインラインで
                      保持し続けるため、その子孫の`position:fixed`要素の含有
                      ブロックがパネル自身に限定されてしまう。`createPortal`で
                      `document.body`直下に出す。 */}
                  {createPortal(
                    <div className="fixed inset-0 z-40" onClick={() => setActiveMenu(null)} />,
                    document.body,
                  )}
                  <div className="absolute top-7 right-0 bg-black/90 rounded shadow-xl border border-white/8 p-1.5 space-y-0.5 w-44 z-50 backdrop-blur-sm">
                    <button
                      onClick={() => handleExclude(img.path, 'file')}
                      className="w-full p-1.5 rounded hover:bg-white/8 text-left text-xs text-white/50 hover:text-white/80 transition-colors flex items-center gap-1.5"
                    >
                      <ChevronRight size={10} />
                      {t('excludeThisPhoto')}
                    </button>
                    <button
                      onClick={() => handleExclude(img.path, 'date')}
                      className="w-full p-1.5 rounded hover:bg-white/8 text-left text-xs text-white/50 hover:text-white/80 transition-colors flex items-center gap-1.5"
                    >
                      <ChevronRight size={10} />
                      {t('excludeThisDate')}
                    </button>
                    <button
                      onClick={() => handleExclude(img.path, 'directory')}
                      className="w-full p-1.5 rounded hover:bg-white/8 text-left text-xs text-white/50 hover:text-white/80 transition-colors flex items-center gap-1.5"
                    >
                      <ChevronRight size={10} />
                      {t('excludeThisFolder')}
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
