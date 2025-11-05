import { ChevronLeft, ChevronRight, FolderOpen, Settings, Share2, Ban, File, Image as ImageIcon, Calendar, Hash, Clock } from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer, shareImage, excludeImage } from '../lib/tauri';
import { useState } from 'react';

interface OverlayUIProps {
  image: ImageInfo | null;
  canGoBack: boolean;
  currentPosition: number;
  totalImages: number;
  onPrevious: () => void;
  onNext: () => void;
  onSettings: () => void;
  onMouseEnter: () => void; // スライドショー一時停止
  onMouseLeave: () => void; // スライドショー再開
  onTogglePause: () => void; // タップで一時停止トグル
}

export function OverlayUI({
  image,
  canGoBack,
  currentPosition,
  totalImages,
  onPrevious,
  onNext,
  onSettings,
  onMouseEnter,
  onMouseLeave,
  onTogglePause,
}: OverlayUIProps) {
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [showExcludeMenu, setShowExcludeMenu] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');

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

  const handleShare = async () => {
    if (!image) return;

    try {
      const destPath = await shareImage(image.path);
      setStatusMessage(`コピー完了: ${destPath}`);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) {
      console.error('Failed to share image:', err);
      setStatusMessage('エラー: コピー失敗');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const handleExcludeClick = () => {
    setShowExcludeMenu(!showExcludeMenu);
  };

  const handleExclude = async (type: 'date' | 'file' | 'folder') => {
    if (!image) return;

    try {
      const pattern = await excludeImage(image.path, type);
      setStatusMessage(`除外パターン追加: ${pattern}`);
      setShowExcludeMenu(false);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) {
      console.error('Failed to exclude image:', err);
      setStatusMessage('エラー: 除外失敗');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDateTime = (dateTimeString: string | null): string => {
    if (!dateTimeString) return '';

    // EXIF DateTimeは "YYYY:MM:DD HH:MM:SS" 形式
    const parts = dateTimeString.split(' ');
    if (parts.length !== 2) return dateTimeString;

    const datePart = parts[0].replace(/:/g, '-');
    const timePart = parts[1];

    return `${datePart} ${timePart}`;
  };

  if (!image) return null;

  // タッチデバイス対応：オーバーレイ背景をクリック/タップで一時停止トグル
  const handleBackgroundClick = (e: React.MouseEvent) => {
    // ボタンやインタラクティブな要素のクリックは無視
    if (e.target === e.currentTarget) {
      onTogglePause();
    }
  };

  return (
    <div
      className="fixed top-0 right-0 bottom-0 w-64 bg-black/60 backdrop-blur-sm border-l border-white/10 flex flex-col py-4 px-3 gap-4 z-50"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={handleBackgroundClick}
    >
      {/* ステータスメッセージ */}
      {statusMessage && (
        <div className="absolute top-4 left-4 right-4 bg-blue-600/90 text-white text-sm px-3 py-2 rounded">
          {statusMessage}
        </div>
      )}

      {/* 上部：閲覧情報 */}
      <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
        {/* 地図（GPS情報がある場合のみ表示） */}
        {image.exif && image.exif.gpsLatitude !== null && image.exif.gpsLongitude !== null && (
          <div className="w-full bg-gray-800 rounded border border-gray-700 p-3">
            <div className="text-gray-400 text-xs mb-2 flex items-center gap-2">
              <span>📍 撮影位置</span>
            </div>
            <div className="text-gray-300 text-sm mb-2 font-mono">
              {image.exif.gpsLatitude.toFixed(6)}, {image.exif.gpsLongitude.toFixed(6)}
            </div>
            <button
              onClick={() => {
                const url = `https://www.google.com/maps?q=${image.exif!.gpsLatitude},${image.exif!.gpsLongitude}`;
                window.open(url, '_blank');
              }}
              className="w-full p-2 bg-blue-600 hover:bg-blue-700 rounded text-white text-sm transition-colors"
            >
              Google Mapsで開く
            </button>
          </div>
        )}

        {/* 撮影日時（デジタル時計風） */}
        {image.exif?.dateTime && (
          <div className="text-center border-b border-white/10 pb-4">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Clock size={16} className="text-gray-400" />
            </div>
            <div className="text-white text-3xl font-mono font-bold">
              {formatDateTime(image.exif.dateTime).split(' ')[1] || '--:--:--'}
            </div>
            <div className="text-gray-400 text-sm font-mono mt-1">
              {formatDateTime(image.exif.dateTime).split(' ')[0] || '----/--/--'}
            </div>
          </div>
        )}

        {/* その他情報 */}
        <div className="flex flex-col gap-3 text-xs border-b border-white/10 pb-4">
          <div className="flex items-start gap-2">
            <File size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <div className="text-gray-300 break-all" title={image.path}>
              {image.path.split('\\').pop() || image.path.split('/').pop()}
            </div>
          </div>
          <div className="text-gray-500 space-y-2">
            {!image.isVideo && image.width > 0 && (
              <div className="flex items-center gap-2">
                <ImageIcon size={14} className="text-gray-400" />
                <span>{image.width} × {image.height}</span>
              </div>
            )}
            {image.isVideo && (
              <div className="flex items-center gap-2">
                <ImageIcon size={14} className="text-gray-400" />
                <span>Video</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <File size={14} className="text-gray-400" />
              <span>{formatFileSize(image.fileSize)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Hash size={14} className="text-gray-400" />
              <span>{currentPosition.toLocaleString()} / {totalImages.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2">
              <Calendar size={14} className="text-gray-400" />
              <span>×{image.displayCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 下部：操作アイコン（縦に並べる） */}
      <div className="flex flex-col gap-2 shrink-0 border-t border-white/10 pt-4">
        {/* 前へ */}
        <button
          onClick={onPrevious}
          disabled={!canGoBack}
          className={`w-full p-3 rounded hover:bg-white/10 transition-colors flex items-center justify-center gap-2 ${
            canGoBack ? 'text-gray-300' : 'text-gray-600 cursor-not-allowed'
          }`}
          title="前へ"
        >
          <ChevronLeft size={20} />
          <span className="text-sm">前へ</span>
        </button>

        {/* 次へ */}
        <button
          onClick={onNext}
          className="w-full p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center gap-2"
          title="次へ"
        >
          <span className="text-sm">次へ</span>
          <ChevronRight size={20} />
        </button>

        {/* 開く */}
        <button
          onClick={handleOpenFolder}
          disabled={isOpeningFolder}
          className="w-full p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center gap-2"
          title="ファイルマネージャーで開く"
        >
          <FolderOpen size={18} />
          <span className="text-sm">開く</span>
        </button>

        {/* シェア */}
        <button
          onClick={handleShare}
          className="w-full p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center gap-2"
          title="シェア用にコピー"
        >
          <Share2 size={18} />
          <span className="text-sm">シェア</span>
        </button>

        {/* 除外 */}
        <div className="relative">
          <button
            onClick={handleExcludeClick}
            className="w-full p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center gap-2"
            title="除外"
          >
            <Ban size={18} />
            <span className="text-sm">除外</span>
          </button>

          {/* 除外メニュー */}
          {showExcludeMenu && (
            <div className="absolute bottom-full right-0 mb-2 bg-gray-900 rounded shadow-lg border border-white/10 p-2 space-y-1 w-48">
              <button
                onClick={() => handleExclude('date')}
                className="w-full p-2 rounded hover:bg-white/10 text-left text-sm text-gray-300"
              >
                撮影日付で除外
              </button>
              <button
                onClick={() => handleExclude('folder')}
                className="w-full p-2 rounded hover:bg-white/10 text-left text-sm text-gray-300"
              >
                このディレクトリを除外
              </button>
              <button
                onClick={() => handleExclude('file')}
                className="w-full p-2 rounded hover:bg-white/10 text-left text-sm text-gray-300"
              >
                このファイルを除外
              </button>
            </div>
          )}
        </div>

        {/* 設定 */}
        <button
          onClick={onSettings}
          className="w-full p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center gap-2"
          title="設定"
        >
          <Settings size={18} />
          <span className="text-sm">設定</span>
        </button>
      </div>
    </div>
  );
}
