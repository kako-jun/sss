import { ChevronLeft, ChevronRight, FolderOpen, Settings, Share2, Ban, File, Hash, MapPin } from 'lucide-react';
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

  const handleExcludeMenuBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setShowExcludeMenu(false);
    }
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
      className="fixed top-0 right-0 bottom-0 bg-black/60 backdrop-blur-sm border-l border-white/10 flex flex-col py-4 px-3 gap-4 z-50"
      style={{ width: '200px' }}
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
        {/* 撮影日時（デジタル時計風） */}
        {image.exif?.dateTime && (
          <div className="text-center border-b border-white/10 pb-4">
            <div className="text-white font-mono font-bold" style={{ fontSize: '1.6rem' }}>
              {formatDateTime(image.exif.dateTime).split(' ')[0] || '----/--/--'}
            </div>
            <div className="text-gray-400 font-mono mt-1" style={{ fontSize: '0.8rem' }}>
              {formatDateTime(image.exif.dateTime).split(' ')[1] || '--:--:--'}
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
            <div className="flex items-center gap-2">
              <Hash size={14} className="text-gray-400" />
              <span>{currentPosition.toLocaleString()} / {totalImages.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2">
              <File size={14} className="text-gray-400" />
              <span>×{image.displayCount}</span>
            </div>
            {/* 撮影位置（GPS情報がある場合のみ表示） */}
            {image.exif && image.exif.gpsLatitude !== null && image.exif.gpsLongitude !== null && (
              <div className="flex items-start gap-2">
                <MapPin size={14} className="text-gray-400 mt-0.5 shrink-0" />
                <button
                  onClick={() => {
                    const url = `https://www.google.com/maps?q=${image.exif!.gpsLatitude},${image.exif!.gpsLongitude}`;
                    window.open(url, '_blank');
                  }}
                  className="text-blue-400 hover:text-blue-300 text-left underline"
                >
                  {image.exif.gpsLatitude.toFixed(6)}, {image.exif.gpsLongitude.toFixed(6)}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 下部：操作アイコン（2列レイアウト） */}
      <div className="grid grid-cols-2 gap-2 shrink-0 border-t border-white/10 pt-4">
        {/* 1行目：前へ、次へ */}
        <button
          onClick={onPrevious}
          disabled={!canGoBack}
          className={`p-3 rounded hover:bg-white/10 transition-colors flex items-center justify-center ${
            canGoBack ? 'text-gray-300' : 'text-gray-600 cursor-not-allowed'
          }`}
          title="前へ"
        >
          <ChevronLeft size={20} />
        </button>
        <button
          onClick={onNext}
          className="p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center"
          title="次へ"
        >
          <ChevronRight size={20} />
        </button>

        {/* 2行目：開く、シェア */}
        <button
          onClick={handleOpenFolder}
          disabled={isOpeningFolder}
          className="p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center"
          title="ファイルマネージャーで開く"
        >
          <FolderOpen size={18} />
        </button>
        <button
          onClick={handleShare}
          className="p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center"
          title="シェア用にコピー"
        >
          <Share2 size={18} />
        </button>

        {/* 3行目：除外、設定 */}
        <div className="relative">
          <button
            onClick={handleExcludeClick}
            className="w-full p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center"
            title="除外"
          >
            <Ban size={18} />
          </button>

          {/* 除外メニュー（背景付き） */}
          {showExcludeMenu && (
            <>
              {/* 背景オーバーレイ */}
              <div
                className="fixed inset-0 z-40"
                onClick={handleExcludeMenuBackdropClick}
              />
              {/* メニュー本体 */}
              <div className="absolute bottom-full right-0 mb-2 bg-gray-900 rounded shadow-lg border border-white/10 p-2 space-y-1 w-48 z-50">
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
            </>
          )}
        </div>
        <button
          onClick={onSettings}
          className="p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center"
          title="設定"
        >
          <Settings size={18} />
        </button>
      </div>
    </div>
  );
}
