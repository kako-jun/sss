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
  Pause,
  Play,
  Ellipsis,
} from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer, pickImage, excludeImage } from '../lib/tauri';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useT } from '../lib/i18n';

interface OverlayUIProps {
  image: ImageInfo | null;
  canGoBack: boolean;
  currentPosition: number;
  totalImages: number;
  progress: number; // 0-100のプログレス値（アンカー%。durationが0ならこの位置で静止）
  /**
   * `progress` からのCSS transition時間(ms)。0なら即座にその位置へ固定表示する
   * （一時停止/新規メディア読込直後）、>0なら「アンカー→100%」への遷移をブラウザに
   * 補間させる（#65 問題6: 60fpsのJSポーリングを撤去し、setState回数を削る）。
   */
  progressDurationMs: number;
  /**
   * ユーザーが明示的に一時停止したか（#66 問題2）。旧実装は「実際に再生中かどうか
   * (isPlaying)」を渡していたが、`isPlaying` はオーバーレイにマウスオーバー中は
   * 常にfalse（App.tsx側で自動一時停止するため）になる。オーバーレイの
   * ⏸/▶ボタンはオーバーレイにホバーしないと見えない位置にあるため、
   * 「ボタンが見えている間は常にisPlaying=false」となり、アイコンが常に▶に
   * 固定されて見える不具合があった。ユーザーが選んだ意思（トグル前の状態）を
   * 独立して渡すことで、ホバーによる自動一時停止と混同しないようにする。
   */
  isPausedByUser: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onOpenPickTab: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onTogglePause: () => void;
  /**
   * 除外が成功した後に呼ぶ（#65 問題5: 除外後も除外画像を表示し続け、
   * 位置/総数が古いままになる不具合の修正）。呼び出し側で「次へ進む」と
   * 「プレイリスト情報の再取得」の両方を行う想定。
   */
  onExcluded?: () => void;
}

export function OverlayUI({
  image,
  canGoBack,
  currentPosition,
  totalImages,
  progress,
  progressDurationMs,
  isPausedByUser,
  onPrevious,
  onNext,
  onOpenPickTab,
  onMouseEnter,
  onMouseLeave,
  onTogglePause,
  onExcluded,
}: OverlayUIProps) {
  const [isOpeningDirectory, setIsOpeningDirectory] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showExcludeSubmenu, setShowExcludeSubmenu] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const statusTimeoutRef = useRef<number | undefined>(undefined);
  const t = useT();

  // #66 問題6: 複数の操作（ピック/除外等）が短時間に連続すると、先に張った
  // setTimeoutが後から表示した新しいメッセージを消してしまう（＝タイマーが
  // 干渉する）不具合があった。常に「直前のタイマーを破棄してから新しく張る」
  // ことで、表示中のメッセージが常にその表示から3秒後に消えることを保証する。
  const showStatusMessage = useCallback((message: string) => {
    if (statusTimeoutRef.current !== undefined) {
      window.clearTimeout(statusTimeoutRef.current);
    }
    setStatusMessage(message);
    statusTimeoutRef.current = window.setTimeout(() => {
      statusTimeoutRef.current = undefined;
      setStatusMessage('');
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current !== undefined) {
        window.clearTimeout(statusTimeoutRef.current);
      }
    };
  }, []);

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

  const handlePick = async () => {
    if (!image) return;

    try {
      const destPath = await pickImage(image.path);
      showStatusMessage(t('pickCopyDone', { path: destPath }));
    } catch (err) {
      console.error('Failed to share image:', err);
      showStatusMessage(t('pickCopyFailed'));
    }
    setShowMoreMenu(false);
  };

  const handleExclude = async (type: 'date' | 'file' | 'directory') => {
    if (!image) return;

    try {
      // #80: excludeImage は構造化データ（pattern/needsRescan）を返す。文言は
      // フロント辞書側で組み立てる（旧実装はバックエンドが組み立て済みの日本語
      // 文字列をそのまま表示しており、言語切替に追従できなかった）。
      const { pattern, needsRescan } = await excludeImage(image.path, type);
      showStatusMessage(
        needsRescan
          ? t('excludeAddedNeedsRescan', { pattern })
          : t('excludeAddedFile', { pattern }),
      );
      // #65 問題5: 除外した画像を表示し続けず、即座に次へ進んでプレイリスト
      // 情報（位置/総数）も最新化する。
      onExcluded?.();
    } catch (err) {
      console.error('Failed to exclude image:', err);
      showStatusMessage(t('excludeFailed'));
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

      {/* プログレスバー（バーの上端）。#65 問題6: 60fpsのJS setIntervalポーリングを
          廃止し、CSS transition(transform scaleX)にブラウザ側の補間を任せる。 */}
      <div className="h-px bg-white/10 overflow-hidden">
        <div
          className="h-full w-full bg-white/40 origin-left"
          style={{
            transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})`,
            transition:
              progressDurationMs > 0 ? `transform ${progressDurationMs}ms linear` : 'none',
          }}
        />
      </div>

      {/* メインバー */}
      <div className="bg-black/50 backdrop-blur-md border-t border-white/5">
        {/* 上行: 情報（4列） */}
        <div className="grid grid-cols-4 gap-px">
          {/* === 上行: 情報 === */}

          {/* 地図セル */}
          <div className="p-2 flex items-center justify-center">
            {hasGps ? (
              <button
                onClick={async () => {
                  const url = `https://www.google.com/maps?q=${image.exif!.gpsLatitude},${image.exif!.gpsLongitude}`;
                  await openUrl(url);
                }}
                className="relative w-full h-14 bg-black/30 hover:bg-black/50 rounded border border-white/5 overflow-hidden transition-colors group"
              >
                {/* OpenStreetMap Tile Usage Policy: img タグではカスタム User-Agent を送れないため、
                    高速に写真をスキップするとレート制限を受ける可能性がある */}
                <img
                  src={tileUrl!}
                  alt={t('locationMapAlt')}
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
                <span className="text-white/15 text-xs">{t('noLocationInfo')}</span>
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
              <div className="text-white/15 text-xs">{t('noDateTime')}</div>
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
        </div>

        {/* 下行: 操作（5列） */}
        <div className="grid grid-cols-5 gap-px">
          {/* … メニューボタン（除外 + ファイルマネージャー） */}
          <div className="p-1 flex items-center justify-center relative">
            <button
              onClick={() => {
                setShowMoreMenu(!showMoreMenu);
                setShowExcludeSubmenu(false);
              }}
              className="p-2 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5"
              title={t('menuTooltip')}
              aria-label={t('menuTooltip')}
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
                    {t('openInFileManager')}
                  </button>

                  <button
                    onClick={() => {
                      onOpenPickTab();
                      setShowMoreMenu(false);
                    }}
                    className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                  >
                    <HandGrab size={14} />
                    {t('viewPicks')}
                  </button>

                  {/* 除外サブメニュー */}
                  <div className="relative">
                    <button
                      onClick={() => setShowExcludeSubmenu(!showExcludeSubmenu)}
                      className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors flex items-center gap-2"
                    >
                      <Ban size={14} />
                      {t('excludeMenuLabel')}
                      <ChevronRight size={12} className="ml-auto" />
                    </button>
                    {showExcludeSubmenu && (
                      <div className="absolute left-full top-0 ml-1 bg-black/90 rounded shadow-xl border border-white/8 p-2 space-y-1 w-48 z-50 backdrop-blur-sm">
                        <button
                          onClick={() => handleExclude('date')}
                          className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                        >
                          {t('excludeByDate')}
                        </button>
                        <button
                          onClick={() => handleExclude('directory')}
                          className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                        >
                          {t('excludeByDirectory')}
                        </button>
                        <button
                          onClick={() => handleExclude('file')}
                          className="w-full p-2 rounded hover:bg-white/8 text-left text-sm text-white/50 hover:text-white/80 transition-colors"
                        >
                          {t('excludeByFile')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ピックボタン（直接） */}
          <div className="p-1 flex items-center justify-center">
            <button
              onClick={handlePick}
              className="p-2 rounded transition-colors text-white/30 hover:text-white/60 hover:bg-white/5"
              title={t('pickTooltip')}
              aria-label={t('pickTooltip')}
            >
              <HandGrab size={18} />
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
              title={t('previousTooltip')}
              aria-label={t('previousTooltip')}
            >
              <ChevronLeft size={18} />
            </button>
          </div>

          {/* ⏸/▶ ボタン */}
          <div className="p-1 flex items-center justify-center">
            <button
              onClick={onTogglePause}
              className="p-2 rounded transition-colors text-white/40 hover:text-white/70 hover:bg-white/5"
              title={isPausedByUser ? t('playTooltip') : t('pauseTooltip')}
              aria-label={isPausedByUser ? t('playTooltip') : t('pauseTooltip')}
            >
              {isPausedByUser ? <Play size={18} /> : <Pause size={18} />}
            </button>
          </div>

          {/* 次へ */}
          <div className="p-1 flex items-center justify-center">
            <button
              onClick={onNext}
              className="p-2 rounded transition-colors text-white/40 hover:text-white/70 hover:bg-white/5"
              title={t('nextTooltip')}
              aria-label={t('nextTooltip')}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
