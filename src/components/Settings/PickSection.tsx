import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getPickedImages, deletePickedImage } from '../../lib/tauri';
import { useT } from '../../lib/i18n';

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
    if (!window.confirm(t('confirmDeletePickedPhoto'))) return;
    try {
      await deletePickedImage(path);
      setImages((prev) => prev.filter((p) => p !== path));
    } catch (err) {
      console.error('Failed to delete picked image:', err);
    }
  };

  if (loading) {
    return <div className="text-white/30 text-sm">{t('loadingLabel')}</div>;
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">
        {t('pickListTitle')}
      </h3>

      {images.length === 0 ? (
        <div className="p-4 bg-black/30 rounded text-center text-white/30 text-sm border border-white/5">
          {t('noPickedPhotos')}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {images.map((path) => (
            <div key={path} className="relative group">
              <img
                src={convertFileSrc(path)}
                alt=""
                className="w-full aspect-square object-cover rounded border border-white/5"
                loading="lazy"
              />
              <button
                onClick={() => handleDelete(path)}
                className="absolute top-1 right-1 p-0.5 bg-black/70 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/90"
                title={t('deleteTooltip')}
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
