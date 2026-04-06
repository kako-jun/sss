import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  HandGrab,
  Ban,
  File,
  Hash,
  MapPin,
  ExternalLink,
  Minimize2,
  Maximize2,
  Pause,
  Play,
  Ellipsis,
  Settings,
} from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer, shareImage, excludeImage } from '../lib/tauri';
import { useState, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-shell';

interface OverlayUIProps {
  image: ImageInfo | null;
  canGoBack: boolean;
  currentPosition: number;
  totalImages: number;
  progress: number; // 0-100のプログレス値
  isFullscreen: boolean; // フルスクリーン状態
  isPlaying: boolean; // 再生中かどうか
  onPrevious: () => void;
  onNext: () => void;
  onSettings: () => void;
  onToggleWindowMode: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onTogglePause: () => void;
}

export function OverlayUI({
  image,
  canGoBack,
  currentPosition,
  totalImages,
  progress,
  isFullscreen,
  isPlaying,
  onPrevious,
  onNext,
  onSettings,
  onToggleWindowMode,
  onMouseEnter,
  onMouseLeave,
  onTogglePause,
}: OverlayUIProps) {
  const [isOpeningDirectory, setIsOpeningDirectory] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showExcludeSubmenu, setShowExcludeSubmenu] = useState(false);
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
      setShowMoreMenu(false);
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
    setShowMoreMenu(false);
  };

  const handleExclude = async (type: 'date' | 'file' | 'directory') => {
    if (!image) return;

    try {
      const pattern = await excludeImage(image.path, type);
      setStatusMessage(`除外パターン追加: ${pattern}`);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch (err) {
      console.error('Failed to exclude image:', err);
      setStatusMessage('エラー: 除外失敗');
      setTimeout(() => setStatusMessage(''), 3000);
    }
    setShowExcludeSubmenu(false);
    setShowMoreMenu(false);
  };

  const handleMoreMenuBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setShowMoreMenu(false);
      setShowExcludeSubmenu(false);
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

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fileName = image ? image.path.split('\\').pop() || image.path.split('/').pop() || '' : '';

  const hasGps =
    image?.exif != null && image.exif.gpsLatitude !== null && image.exif.gpsLongitude !== null;

  const formattedDate = image?.exif?.dateTime ? formatDateTime(image.exif.dateTime) : '';

  const tileUrl = useMemo(() => {
    if (!hasGps || !image?.exif?.gpsLatitude || !image?.exif?.gpsLongitude) return null;
    const lat = image.exif.gpsLatitude;
    const lon = image.exif.gpsLongitude;
    const zoom = 13;
    const x = Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
    const y = Math.floor(
      ((1 -
        Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
        2) *
        Math.pow(2, zoom),
    );
    return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  }, [hasGps, image?.exif?.gpsLatitude, image?.exif?.gpsLongitude]);

  if (!image) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* ステータスメッセージ（バーの上に表示） */}
      {statusMessage && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black/80 text-white/50 text-xs px-3 py-2 rounded border border-white/10 whitespace-nowrap">
          {statusMessage}
        </div>
      )}

      {/* プログレスバー（バーの上端） */}
      <div className="h-px bg-white/10">
        <div
          className="h-full bg-white/40 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* メインバー */}
      <div className="bg-black/50 backdrop-blur-md border-t border-white/5">
        {/* 4列×2行グリッド */}
        <div className="grid grid-cols-4 gap-px">
          {/* === 上行: 情報 === */}

          {/* 地図セル */}
          <div className="p-2 flex items-center justify-center">
            {hasGps ? (
              <button
                onClick={async () => {
                  const url = `https://www.google.com/maps?q=${image.exif!.gpsLatitude},${image.exif!.gpsLongitude}`;
                  await open(url);
                }}
                className="relative w-full h-14 bg-black/30 hover:bg-black/50 rounded border border-white/5 overflow-hidden transition-colors group"
              >
                {/* OpenStreetMap Tile Usage Policy: img タグではカスタム User-Agent を送れないため、
                    高速に写真をスキップするとレート制限を受ける可能性がある */}
                <img
                  src={tileUrl!}
                  alt="Location Map"
                  className="w-full h-full object-cover grayscale opacity-60 group-hover:opacity-80 group-hover:grayscale-0 transition-all"
                />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <MapPin
                    size={16}
                    className="text-white/40 group-hover:text-white/70 drop-shadow-lg transition-colors"
                    fill="currentColor"
                  />
                </div>
                <div className="absolute bottom-0.5 right-0.5 bg-black/50 rounded p-0.5">
                  <ExternalLink size={8} className="text-white/40" />
                </div>
              </button>
            ) : (
              <div className="w-full h-14 bg-black/20 rounded border border-white/5 flex items-center justify-center">
                <span className="text-white/15 text-xs">位置情報なし</span>
              </div>
            )}
          </div>

          {/* 撮影日時 */}
          <div className="p-2 flex flex-col items-center justify-center">
            {formattedDate ? (
              <>
                <div className="text-white/70 font-mono text-sm whitespace-nowrap">
                  {formattedDate.split(' ')[0] || ''}
                </div>
                <div className="text-white/35 font-mono text-xs mt-0.5">
                  {formattedDate.split(' ')[1] || ''}
                </div>
              </>
            ) : (
              <div className="text-white/15 text-xs">日時不明</div>
            )}
          </div>

          {/* ファイル名・サイズ */}
          <div className="p-2 flex flex-col items-center justify-center overflow-hidden">
            <div className="text-white/45 text-xs truncate max-w-full" title={image.path}>
              {fileName}
            </div>
            <div className="text-white/20 text-xs mt-0.5">{formatFileSize(image.fileSize)}</div>
          </div>

          {/* 位置/回数 */}
          <div className="p-2 flex flex-col items-center justify-center">
            <div className="flex items-center gap-1 text-white/30 text-xs">
              <Hash size={11} className="text-white/20" />
              <span>
                {currentPosition.toLocaleString()} / {totalImages.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1 text-white/20 text-xs mt-0.5">
              <File size={11} className="text-white/15" />
              <span>×{image.displayCount}</span>
            </div>
          </div>

          {/* === 下行: 操作 === */}

          {/* … メニューボタン */}
          <div className="p-1 flex items-center justify-center relative">
            <button
              onClick={() => {
                setShowMoreMenu(!showMoreMenu);
                setShowExcludeSubmenu(false);
              }}
              className="p-2 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5"
              title="メニュー"
            >
              <Ellipsis size={18} />
            </button>

            {/* サブメニュー */}
            {showMoreMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={handleMoreMenuBackdropClick} />
                <div className="absolute bottom-full left-0 mb-2 bg-black/90 rounded shadow-xl border border-white/8 p-2 space-y-1 w-52 z-50 backdrop-blur-sm">
                  <button
                    onClick={handleOpenDirectory}
                    disabled={isOpeningDirectory}
                    className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                  >
                    <FolderOpen size={14} />
                    ファイルマネージャーで開く
                  </button>
                  <button
                    onClick={handleShare}
                    className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                  >
                    <HandGrab size={14} />
                    ピック（コピー）
                  </button>

                  {/* 除外サブメニュー */}
                  <div className="relative">
                    <button
                      onClick={() => setShowExcludeSubmenu(!showExcludeSubmenu)}
                      className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                    >
                      <Ban size={14} />
                      除外
                      <ChevronRight size={12} className="ml-auto" />
                    </button>
                    {showExcludeSubmenu && (
                      <div className="absolute left-full top-0 ml-1 bg-black/90 rounded shadow-xl border border-white/8 p-2 space-y-1 w-48 z-50 backdrop-blur-sm">
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
                          ディレクトリを除外
                        </button>
                        <button
                          onClick={() => handleExclude('file')}
                          className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                        >
                          ファイルを除外
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-white/5 my-1" />

                  {/* ウィンドウモード切り替え */}
                  <button
                    onClick={() => {
                      onToggleWindowMode();
                      setShowMoreMenu(false);
                    }}
                    className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                  >
                    {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    {isFullscreen ? 'ウィンドウモード' : 'フルスクリーン'}
                  </button>

                  {/* 設定 */}
                  <button
                    onClick={() => {
                      onSettings();
                      setShowMoreMenu(false);
                    }}
                    className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                  >
                    <Settings size={14} />
                    設定
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ⏸/▶ ボタン */}
          <div className="p-1 flex items-center justify-center">
            <button
              onClick={onTogglePause}
              className="p-2 rounded transition-colors text-white/40 hover:text-white/70 hover:bg-white/5"
              title={isPlaying ? '一時停止' : '再生'}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
          </div>

          {/* 前へ */}
          <div className="p-1 flex items-center justify-center">
            <button
              onClick={onPrevious}
              disabled={!canGoBack}
              className={`p-2 rounded transition-colors ${
                canGoBack
                  ? 'text-white/40 hover:text-white/70 hover:bg-white/5'
                  : 'text-white/15 cursor-not-allowed'
              }`}
              title="前へ (←)"
            >
              <ChevronLeft size={18} />
            </button>
          </div>

          {/* 次へ */}
          <div className="p-1 flex items-center justify-center">
            <button
              onClick={onNext}
              className="p-2 rounded transition-colors text-white/40 hover:text-white/70 hover:bg-white/5"
              title="次へ (→)"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
