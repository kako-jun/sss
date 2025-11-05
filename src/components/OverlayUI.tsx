import { ChevronLeft, ChevronRight, FolderOpen, Settings, Share2, Ban, File, Hash, MapPin, ExternalLink } from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer, shareImage, excludeImage } from '../lib/tauri';
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';

interface OverlayUIProps {
  image: ImageInfo | null;
  canGoBack: boolean;
  currentPosition: number;
  totalImages: number;
  progress: number; // 0-100のプログレス値
  isResetting: boolean; // リセット中かどうか
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
  progress,
  isResetting,
  onPrevious,
  onNext,
  onSettings,
  onMouseEnter,
  onMouseLeave,
  onTogglePause,
}: OverlayUIProps) {
  const [isOpeningDirectory, setIsOpeningDirectory] = useState(false);
  const [showExcludeMenu, setShowExcludeMenu] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const handleOpenDirectory = async () => {
    if (!image) return;

    try {
      setIsOpeningDirectory(true);
      await openInExplorer(image.path);
    } catch (err) {
      console.error('Failed to open directory:', err);
    } finally {
      setIsOpeningDirectory(false);
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

  const handleExclude = async (type: 'date' | 'file' | 'directory') => {
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

  const handleOpenSssignore = async () => {
    try {
      // ホームディレクトリの.sssignoreファイルパスを取得して開く
      await openInExplorer('~/.sssignore');
      setShowExcludeMenu(false);
    } catch (err) {
      console.error('Failed to open .sssignore:', err);
      setStatusMessage('エラー: .sssignoreを開けませんでした');
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
      {/* プログレスバー */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gray-700">
        <div
          className="h-full bg-white"
          style={{
            width: `${progress}%`,
            transition: isResetting ? 'none' : 'width 0.1s linear'
          }}
        />
      </div>

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
            <div className="text-white font-mono font-bold whitespace-nowrap overflow-hidden" style={{ fontSize: 'clamp(1.2rem, 5vw, 2rem)' }}>
              {formatDateTime(image.exif.dateTime).split(' ')[0] || '----/--/--'}
            </div>
            <div className="text-gray-400 font-mono mt-1 whitespace-nowrap" style={{ fontSize: '1.5rem' }}>
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
            <div className="flex items-center gap-2 group relative">
              <Hash size={14} className="text-gray-400" />
              <span>{currentPosition.toLocaleString()} / {totalImages.toLocaleString()}</span>
              <span className="absolute left-0 bottom-full mb-1 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                プレイリスト位置
              </span>
            </div>
            <div className="flex items-center gap-2 group relative">
              <File size={14} className="text-gray-400" />
              <span>×{image.displayCount}</span>
              <span className="absolute left-0 bottom-full mb-1 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                表示回数
              </span>
            </div>
            {/* 撮影位置（GPS情報がある場合のみ表示） */}
            {image.exif && image.exif.gpsLatitude !== null && image.exif.gpsLongitude !== null && (
              <div className="mt-2">
                <button
                  onClick={async () => {
                    const url = `https://www.google.com/maps?q=${image.exif!.gpsLatitude},${image.exif!.gpsLongitude}`;
                    await open(url);
                  }}
                  className="w-full bg-gray-800 hover:bg-gray-700 rounded border border-gray-600 overflow-hidden transition-colors group"
                >
                  {/* 実際の地図表示（OpenStreetMap） */}
                  <div className="relative h-20 bg-gray-900 overflow-hidden">
                    {/* 地図画像（Static Map） */}
                    <img
                      src={`https://api.mapbox.com/styles/v1/mapbox/light-v11/static/pin-s+555555(${image.exif.gpsLongitude},${image.exif.gpsLatitude})/${image.exif.gpsLongitude},${image.exif.gpsLatitude},13,0/200x80@2x?access_token=pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw`}
                      alt="Location Map"
                      className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all"
                      onError={(e) => {
                        // フォールバック: OpenStreetMapタイル
                        const zoom = 13;
                        const lat = image.exif!.gpsLatitude!;
                        const lon = image.exif!.gpsLongitude!;
                        const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
                        const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
                        (e.target as HTMLImageElement).src = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
                      }}
                    />
                    {/* マップピンオーバーレイ */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <MapPin size={24} className="text-gray-400 group-hover:text-red-500 drop-shadow-lg transition-colors" fill="currentColor" />
                    </div>
                    {/* 外部リンクアイコン（右下） */}
                    <div className="absolute bottom-1 right-1 bg-black/60 rounded p-1">
                      <ExternalLink size={12} className="text-white" />
                    </div>
                  </div>
                  {/* 座標情報 */}
                  <div className="p-2 text-center">
                    <div className="text-gray-400 text-xs font-mono">
                      {image.exif.gpsLatitude.toFixed(6)}, {image.exif.gpsLongitude.toFixed(6)}
                    </div>
                  </div>
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
          className={`relative p-3 rounded hover:bg-white/10 transition-colors flex items-center justify-center group ${
            canGoBack ? 'text-gray-300' : 'text-gray-600 cursor-not-allowed'
          }`}
          title="前へ (←)"
        >
          <ChevronLeft size={20} />
          {canGoBack && (
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              ←で前へ
            </span>
          )}
        </button>
        <button
          onClick={onNext}
          className="relative p-3 rounded hover:bg-white/10 transition-colors text-gray-300 flex items-center justify-center group"
          title="次へ (→)"
        >
          <ChevronRight size={20} />
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            →で次へ
          </span>
        </button>

        {/* 2行目：開く、シェア */}
        <button
          onClick={handleOpenDirectory}
          disabled={isOpeningDirectory}
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
                  onClick={() => handleExclude('directory')}
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
                {/* セパレータ */}
                <div className="border-t border-white/10 my-1" />
                <button
                  onClick={handleOpenSssignore}
                  className="w-full p-2 rounded hover:bg-white/10 text-left text-sm text-gray-300"
                >
                  .sssignoreを開く
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
