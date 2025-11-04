import { motion, AnimatePresence } from 'framer-motion';
import { Play, ChevronLeft, FolderOpen, Settings } from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer } from '../lib/tauri';
import { useState } from 'react';

interface OverlayUIProps {
  image: ImageInfo | null;
  isVisible: boolean;
  isPlaying: boolean;
  canGoBack: boolean;
  currentPosition: number;
  totalImages: number;
  onPlay: () => void;
  onPrevious: () => void;
  onSettings: () => void;
}

export function OverlayUI({
  image,
  isVisible,
  isPlaying,
  canGoBack,
  currentPosition,
  totalImages,
  onPlay,
  onPrevious,
  onSettings,
}: OverlayUIProps) {
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);

  const handleOpenFolder = async () => {
    if (!image) return;

    try {
      setIsOpeningFolder(true);
      await openInExplorer(image.path);
    } catch (err) {
      console.error('Failed to open folder:', err);
    } finally {
      setIsOpeningFolder(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatPath = (path: string): string => {
    const parts = path.split(/[\\/]/);
    return parts.slice(-3).join(' / ');
  };

  return (
    <AnimatePresence>
      {isVisible && image && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="fixed inset-0 pointer-events-none flex items-end justify-center pb-16"
        >
          <div
            className="pointer-events-auto bg-black/30 backdrop-blur-xl rounded-2xl shadow-2xl p-6 max-w-3xl w-full mx-8"
            style={{
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            {/* 画像情報 */}
            <div className="mb-6 space-y-2">
              <div className="flex items-center gap-2 text-white text-lg font-semibold">
                <span className="truncate">
                  {image.path.split(/[\\/]/).pop()}
                </span>
              </div>
              <div className="text-gray-300 text-sm">
                📁 {formatPath(image.path)}
              </div>
              <div className="flex items-center gap-4 text-gray-400 text-sm">
                <span>
                  {image.width} × {image.height}
                </span>
                <span>{formatFileSize(image.fileSize)}</span>
                {image.exif?.dateTime && <span>📅 {image.exif.dateTime}</span>}
              </div>
              {image.exif && (image.exif.cameraMake || image.exif.cameraModel) && (
                <div className="text-gray-400 text-sm">
                  📸 {image.exif.cameraMake} {image.exif.cameraModel}
                  {image.exif.focalLength && ` • ${image.exif.focalLength}`}
                  {image.exif.fNumber && ` • ${image.exif.fNumber}`}
                  {image.exif.iso && ` • ISO ${image.exif.iso}`}
                </div>
              )}
              <div className="text-gray-400 text-sm">
                📊 {currentPosition.toLocaleString()} / {totalImages.toLocaleString()}
              </div>
            </div>

            {/* コントロールボタン */}
            <div className="flex items-center gap-3">
              {/* 再開ボタン */}
              {!isPlaying && (
                <button
                  onClick={onPlay}
                  className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors text-white font-medium"
                >
                  <Play size={18} />
                  再開
                </button>
              )}

              {/* 前へボタン */}
              <button
                onClick={onPrevious}
                disabled={!canGoBack}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-white font-medium ${
                  canGoBack
                    ? 'bg-white/20 hover:bg-white/30'
                    : 'bg-white/10 opacity-50 cursor-not-allowed'
                }`}
              >
                <ChevronLeft size={18} />
                前へ
              </button>

              {/* 開くボタン */}
              <button
                onClick={handleOpenFolder}
                disabled={isOpeningFolder}
                className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors text-white font-medium"
              >
                <FolderOpen size={18} />
                開く
              </button>

              {/* 設定ボタン */}
              <button
                onClick={onSettings}
                className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors text-white font-medium ml-auto"
              >
                <Settings size={18} />
                設定
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
