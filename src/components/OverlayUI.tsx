import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, FolderOpen, Settings } from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer } from '../lib/tauri';
import { useState } from 'react';

interface OverlayUIProps {
  image: ImageInfo | null;
  isVisible: boolean;
  canGoBack: boolean;
  currentPosition: number;
  totalImages: number;
  onPrevious: () => void;
  onNext: () => void;
  onSettings: () => void;
  onHide: () => void;
}

export function OverlayUI({
  image,
  isVisible,
  canGoBack,
  currentPosition,
  totalImages,
  onPrevious,
  onNext,
  onSettings,
  onHide,
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
    return path;
  };

  const formatDateTime = (isoString: string | null): string => {
    if (!isoString) return '';

    try {
      const date = new Date(isoString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');

      return `${year}年${month}月${day}日 ${hours}時${minutes}分${seconds}秒`;
    } catch {
      return isoString;
    }
  };

  return (
    <AnimatePresence>
      {isVisible && image && (
        <>
          {/* バックドロップ（クリックで閉じる） */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-40 pointer-events-auto cursor-pointer"
            onClick={(e) => {
              console.log('Backdrop clicked');
              e.stopPropagation();
              onHide();
            }}
          />

          {/* オーバーレイコンテンツ */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="fixed inset-0 pointer-events-none flex items-end justify-center pb-16 z-50"
          >
            <div
              className="pointer-events-auto bg-black/30 backdrop-blur-xl rounded-2xl shadow-2xl p-6 max-w-3xl w-full mx-8"
              style={{
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
            {/* 画像情報 */}
            <div className="mb-6 space-y-2">
              <div className="text-gray-300 text-sm">
                📁 {formatPath(image.path)}
              </div>
              <div className="flex items-center gap-4 text-gray-400 text-sm">
                <span>
                  {image.width} × {image.height}
                </span>
                <span>{formatFileSize(image.fileSize)}</span>
              </div>
              {image.exif?.dateTime && (
                <div className="text-gray-400 text-sm">
                  📅 撮影日時: {image.exif.dateTime}
                </div>
              )}
              {image.exif && (image.exif.cameraMake || image.exif.cameraModel) && (
                <div className="text-gray-400 text-sm">
                  📸 {image.exif.cameraMake} {image.exif.cameraModel}
                  {image.exif.focalLength && ` • ${image.exif.focalLength}`}
                  {image.exif.fNumber && ` • ${image.exif.fNumber}`}
                  {image.exif.iso && ` • ISO ${image.exif.iso}`}
                </div>
              )}
              <div className="text-gray-400 text-sm">
                📊 プレイリスト位置: {currentPosition.toLocaleString()} / {totalImages.toLocaleString()}
              </div>
              <div className="text-gray-400 text-sm">
                🔢 表示回数: {image.displayCount}回
              </div>
              {image.lastDisplayed && (
                <div className="text-gray-400 text-sm">
                  🕒 最終表示: {formatDateTime(image.lastDisplayed)}
                </div>
              )}
            </div>

            {/* コントロールボタン */}
            <div className="flex items-center gap-3">
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

              {/* 次へボタン */}
              <button
                onClick={(e) => {
                  console.log('Next button clicked');
                  e.stopPropagation();
                  onNext();
                }}
                className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors text-white font-medium"
              >
                次へ
                <ChevronRight size={18} />
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
        </>
      )}
    </AnimatePresence>
  );
}
