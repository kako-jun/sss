import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getPickedImages, deletePickedImage } from '../../lib/tauri';
import { useT } from '../../lib/i18n';
import { confirmDialog } from '../../lib/confirmDialog';
import { Thumbnail } from './Thumbnail';

export function PickSection() {
  const t = useT();
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPickedImages()
      .then((result) => {
        setImages(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load picked images:', err);
        setLoading(false);
      });
  }, []);

  const handleDelete = async (path: string) => {
    const ok = await confirmDialog({
      message: t('confirmDeletePickedPhoto'),
      confirmLabel: t('deleteTooltip'),
    });
    if (!ok) return;
    try {
      await deletePickedImage(path);
      setImages((prev) => prev.filter((p) => p !== path));
    } catch (err) {
      console.error('Failed to delete picked image:', err);
    }
  };

  if (loading) {
    // #66レビュー2巡目nit: /30→/50（他の説明/補助テキストと同じ濃さに統一）。
    return <div className="text-white/50 text-sm">{t('loadingLabel')}</div>;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/70">{t('pickListTitle')}</h3>

      {images.length === 0 ? (
        <div className="p-4 bg-black/30 rounded-lg text-center text-white/50 text-sm">
          {t('noPickedPhotos')}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {images.map((path) => (
            <div key={path} className="relative group">
              <Thumbnail path={path} />
              <button
                onClick={() => handleDelete(path)}
                // #66 問題9: hoverのみで表示されるとキーボード/タッチで見えなかった。
                // 既定でも薄く見せ、hover/focusで強調する。
                className="absolute top-1 right-1 p-0.5 bg-black/70 rounded opacity-40 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-black/90"
                title={t('deleteTooltip')}
                aria-label={t('deleteTooltip')}
              >
                <X className="w-3.5 h-3.5 text-white/60 hover:text-white/90" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
