import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Settings,
  HandGrab,
  Ban,
  File,
  Hash,
  MapPin,
  ExternalLink,
  Minimize2,
  Maximize2,
} from 'lucide-react';
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
  isFullscreen: boolean; // フルスクリーン状態
  onPrevious: () => void;
  onNext: () => void;
  onSettings: () => void;
  onToggleWindowMode: () => void; // フルスクリーン⇔ウィンドウモードトグル
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
  isFullscreen,
  onPrevious,
  onNext,
  onSettings,
  onToggleWindowMode,
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
      className="fixed top-0 right-0 bottom-0 bg-black/50 backdrop-blur-md border-l border-white/5 flex flex-col py-4 px-3 gap-4 z-50 transition-opacity duration-300"
      style={{ width: '200px' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={handleBackgroundClick}
    >
      {/* プログレスバー */}
      <div className="absolute top-0 left-0 right-0 h-px bg-white/10">
        <div
          className="h-full bg-white/40 transition-all duration-300"
          style={{
            width: `${progress}%`,
          }}
        />
      </div>

      {/* ステータスメッセージ */}
      {statusMessage && (
        <div className="absolute top-4 left-4 right-4 bg-black/80 text-white/50 text-xs px-3 py-2 rounded border border-white/10">
          {statusMessage}
        </div>
      )}

      {/* 上部：閲覧情報 */}
      <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
        {/* 撮影日時（デジタル時計風） */}
        {image.exif?.dateTime && (
          <div className="text-center border-b border-white/5 pb-4">
            <div
              className="text-white/80 font-mono font-medium whitespace-nowrap overflow-hidden"
              style={{ fontSize: 'clamp(1rem, 4vw, 1.5rem)' }}
            >
              {formatDateTime(image.exif.dateTime).split(' ')[0] || '----/--/--'}
            </div>
            <div
              className="text-white/40 font-mono mt-1 whitespace-nowrap"
              style={{ fontSize: '1.1rem' }}
            >
              {formatDateTime(image.exif.dateTime).split(' ')[1] || '--:--:--'}
            </div>
          </div>
        )}

        {/* その他情報 */}
        <div className="flex flex-col gap-3 text-xs border-b border-white/5 pb-4">
          <div className="flex items-start gap-2">
            <File size={13} className="text-white/25 mt-0.5 shrink-0" />
            <div className="text-white/50 break-all" title={image.path}>
              {image.path.split('\\').pop() || image.path.split('/').pop()}
            </div>
          </div>
          <div className="text-white/30 space-y-2">
            <div className="flex items-center gap-2 group relative">
              <Hash size={13} className="text-white/20" />
              <span>
                {currentPosition.toLocaleString()} / {totalImages.toLocaleString()}
              </span>
              <span className="absolute left-0 bottom-full mb-1 px-2 py-1 bg-black/90 text-white/70 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                プレイリスト位置
              </span>
            </div>
            <div className="flex items-center gap-2 group relative">
              <File size={13} className="text-white/20" />
              <span>×{image.displayCount}</span>
              <span className="absolute left-0 bottom-full mb-1 px-2 py-1 bg-black/90 text-white/70 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
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
                  className="w-full bg-black/30 hover:bg-black/50 rounded border border-white/5 overflow-hidden transition-colors group"
                >
                  {/* 実際の地図表示（OpenStreetMap） */}
                  <div className="relative h-20 bg-black/40 overflow-hidden">
                    {/* 地図画像（Static Map） */}
                    <img
                      src={(() => {
                        const lat = image.exif.gpsLatitude;
                        const lon = image.exif.gpsLongitude;
                        const zoom = 13;
                        const x = Math.floor(((lon! + 180) / 360) * Math.pow(2, zoom));
                        const y = Math.floor(
                          ((1 -
                            Math.log(
                              Math.tan((lat! * Math.PI) / 180) +
                                1 / Math.cos((lat! * Math.PI) / 180),
                            ) /
                              Math.PI) /
                            2) *
                            Math.pow(2, zoom),
                        );
                        return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
                      })()}
                      alt="Location Map"
                      className="w-full h-full object-cover grayscale opacity-60 group-hover:opacity-80 group-hover:grayscale-0 transition-all"
                      onError={(e) => {
                        // フォールバック: OpenStreetMapタイル
                        const zoom = 13;
                        const lat = image.exif!.gpsLatitude!;
                        const lon = image.exif!.gpsLongitude!;
                        const x = Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
                        const y = Math.floor(
                          ((1 -
                            Math.log(
                              Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180),
                            ) /
                              Math.PI) /
                            2) *
                            Math.pow(2, zoom),
                        );
                        (e.target as HTMLImageElement).src =
                          `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
                      }}
                    />
                    {/* マップピンオーバーレイ */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <MapPin
                        size={20}
                        className="text-white/40 group-hover:text-white/70 drop-shadow-lg transition-colors"
                        fill="currentColor"
                      />
                    </div>
                    {/* 外部リンクアイコン（右下） */}
                    <div className="absolute bottom-1 right-1 bg-black/50 rounded p-0.5">
                      <ExternalLink size={10} className="text-white/40" />
                    </div>
                  </div>
                  {/* 座標情報 */}
                  <div className="p-2 text-center">
                    <div className="text-white/25 text-xs font-mono">
                      {image.exif.gpsLatitude.toFixed(4)}, {image.exif.gpsLongitude.toFixed(4)}
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 下部：操作アイコン（2列レイアウト） */}
      <div className="grid grid-cols-2 gap-1 shrink-0 border-t border-white/5 pt-4">
        {/* 1行目：前へ、次へ */}
        <button
          onClick={onPrevious}
          disabled={!canGoBack}
          className={`relative p-3 rounded transition-colors flex items-center justify-center group ${
            canGoBack
              ? 'text-white/40 hover:text-white/70 hover:bg-white/5'
              : 'text-white/15 cursor-not-allowed'
          }`}
          title="前へ (←)"
        >
          <ChevronLeft size={18} />
          {canGoBack && (
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/90 text-white/70 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              ←で前へ
            </span>
          )}
        </button>
        <button
          onClick={onNext}
          className="relative p-3 rounded transition-colors text-white/40 hover:text-white/70 hover:bg-white/5 flex items-center justify-center group"
          title="次へ (→)"
        >
          <ChevronRight size={18} />
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/90 text-white/70 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            →で次へ
          </span>
        </button>

        {/* 2行目：開く、シェア */}
        <button
          onClick={handleOpenDirectory}
          disabled={isOpeningDirectory}
          className="p-3 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5 flex items-center justify-center"
          title="ファイルマネージャーで開く"
        >
          <FolderOpen size={16} />
        </button>
        <button
          onClick={handleShare}
          className="p-3 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5 flex items-center justify-center"
          title="ピック（コピー）"
        >
          <HandGrab size={16} />
        </button>

        {/* 3行目：除外、設定 */}
        <div className="relative">
          <button
            onClick={handleExcludeClick}
            className="w-full p-3 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5 flex items-center justify-center"
            title="除外"
          >
            <Ban size={16} />
          </button>

          {/* 除外メニュー（背景付き） */}
          {showExcludeMenu && (
            <>
              {/* 背景オーバーレイ */}
              <div className="fixed inset-0 z-40" onClick={handleExcludeMenuBackdropClick} />
              {/* メニュー本体 */}
              <div className="absolute bottom-full right-0 mb-2 bg-black/90 rounded shadow-xl border border-white/8 p-2 space-y-1 w-48 z-50 backdrop-blur-sm">
                <button
                  onClick={() => handleExclude('date')}
                  className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                >
                  撮影日付で除外
                </button>
                <button
                  onClick={() => handleExclude('directory')}
                  className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                >
                  このディレクトリを除外
                </button>
                <button
                  onClick={() => handleExclude('file')}
                  className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                >
                  このファイルを除外
                </button>
              </div>
            </>
          )}
        </div>
        <button
          onClick={onSettings}
          className="p-3 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5 flex items-center justify-center"
          title="設定"
        >
          <Settings size={16} />
        </button>

        {/* 4行目：ウィンドウモードトグル（全幅） */}
        <button
          onClick={onToggleWindowMode}
          className="col-span-2 p-3 rounded transition-colors text-white/20 hover:text-white/50 hover:bg-white/5 flex items-center justify-center gap-2"
          title={isFullscreen ? 'ウィンドウモードに切り替え' : 'フルスクリーンに戻す'}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span className="text-xs">{isFullscreen ? 'ウィンドウ' : 'フルスクリーン'}</span>
        </button>
      </div>
    </div>
  );
}
