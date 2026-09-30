import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  HandGrab,
  Ban,
  MapPin,
  Pause,
  Play,
  Ellipsis,
} from 'lucide-react';
import type { ImageInfo } from '../types';
import { openInExplorer, pickImage, excludeImage } from '../lib/tauri';
import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { createPortal } from 'react-dom';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useT } from '../lib/i18n';
import { resolvePickErrorMessage } from '../lib/i18n/errors';
import { idleFadeClassName } from '../constants';
import { createButtonFocusGuard } from '../lib/keyboardShortcuts';

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
  /**
   * idle（マウス非操作）中かどうか（#66レビューshould）。フローティングバーと
   * ステータスメッセージはこれに連動してフェードするが、写真下端のプログレス
   * ラインは常時表示する（idle中に一時停止していても、何かが動いている/止まって
   * いることが分かる最低限の手がかりを残すため）。
   */
  isIdle: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /**
   * `viaMouse`: ピック一覧タブを開いた操作がマウスクリックだったか
   * （`event.detail > 0`）。App.tsx側のuseFocusTrap呼び出しへ伝わり、
   * マウスで開いた場合は設定モーダルの閉じるボタンにフォーカスリングを
   * 出さないようにする（#66レビュー3巡目should）。
   */
  onOpenPickTab: (viaMouse: boolean) => void;
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

/**
 * `App.tsx`のグローバルESCハンドラが、オーバーレイの「…」メニュー（または
 * その中の除外サブメニュー）が開いている時はそれを閉じるだけにするための
 * 命令的API（#66レビューshould）。OverlayUIはApp.tsxから見て「開いている」
 * こと自体をReact状態としては公開していない（ローカルUI状態のため）ので、
 * refを介した最小限のインターフェースにする。
 */
export interface OverlayUIHandle {
  isMenuOpen: () => boolean;
  closeMenu: () => void;
}

// #66 視覚刷新: DESIGN.md「Buttons — Icon (Overlay)」トークン。既定から十分な
// コントラストを持たせ（旧text-white/30〜40は暗すぎた）、hoverでさらに強調する。
const ICON_BTN =
  'rounded-lg transition-colors text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90';
const ICON_BTN_DISABLED = 'text-white/20 cursor-not-allowed';

export const OverlayUI = forwardRef<OverlayUIHandle, OverlayUIProps>(function OverlayUI(
  {
    image,
    canGoBack,
    currentPosition,
    totalImages,
    progress,
    progressDurationMs,
    isPausedByUser,
    isIdle,
    onPrevious,
    onNext,
    onOpenPickTab,
    onMouseEnter,
    onMouseLeave,
    onTogglePause,
    onExcluded,
  },
  ref,
) {
  const [isOpeningDirectory, setIsOpeningDirectory] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showExcludeSubmenu, setShowExcludeSubmenu] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const statusTimeoutRef = useRef<number | undefined>(undefined);
  const t = useT();
  // #66レビュー3巡目nit: 操作バー内の各ボタンへ個別に付ける
  // onMouseDownガード（コンテナ一括ではなくボタン単位にすることで、
  // ファイル名テキストのドラッグ選択を妨げないようにする）。
  const barContainerRef = useRef<HTMLDivElement>(null);
  const guardButtonMouseDown = useMemo(() => createButtonFocusGuard(barContainerRef), []);

  // #66レビューshould: App.tsxのグローバルESCハンドラが「…」メニュー（または
  // 除外サブメニュー）を閉じられるようにする命令的API。
  useImperativeHandle(
    ref,
    () => ({
      isMenuOpen: () => showMoreMenu || showExcludeSubmenu,
      closeMenu: () => {
        setShowMoreMenu(false);
        setShowExcludeSubmenu(false);
      },
    }),
    [showMoreMenu, showExcludeSubmenu],
  );

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
      showStatusMessage(resolvePickErrorMessage(String(err)));
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

  const formatDateShort = (dateTimeString: string | null): string => {
    if (!dateTimeString) return '';
    // EXIF DateTimeは "YYYY:MM:DD HH:MM:SS" 形式。コンパクトなバーでは日付だけ
    // 見せる（時刻はファイル名のtitleツールチップに残す）。
    const datePart = dateTimeString.split(' ')[0];
    return datePart ? datePart.replace(/:/g, '-') : '';
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // #66レビューmust4: `split('\\').pop()`はバックスラッシュが無いPOSIXパスでは
  // 「区切りが無いので元の文字列全体」を返してしまい、それが空でないため`||`の
  // 右辺（'/'区切り）に一切フォールバックしなかった（フルパスがそのままファイル名
  // として表示される不具合）。バックスラッシュ・スラッシュのどちらでも1回で
  // 区切れるよう正規表現に統一する。
  const fileName = image ? (image.path.split(/[\\/]/).pop() ?? '') : '';

  const hasGps =
    image?.exif != null && image.exif.gpsLatitude !== null && image.exif.gpsLongitude !== null;

  const dateShort = image?.exif?.dateTime ? formatDateShort(image.exif.dateTime) : '';

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

  // #66 視覚刷新: 見えなくても困らない情報（ファイルサイズ・表示回数・最終表示日時・
  // フルパス）は、本文としては出さずファイル名のtitleツールチップにまとめる
  // （「情報が無いものは出さない」の裏返しで「常に要るわけではない情報は本文を
  // 圧迫しない」。ファイルマネージャーで開けば結局フルパス自体は分かるため、
  // ここでの主目的はホバー時の確認用）。
  const infoTooltip = [
    image.path,
    formatFileSize(image.fileSize),
    t('displayCountTooltip', { count: image.displayCount }),
    image.lastDisplayed ? t('lastDisplayedTooltip', { when: image.lastDisplayed }) : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      {/* プログレスライン（写真下端の極細線）。#66視覚刷新: フローティングバーの
          最大幅に制約されず常に画面幅いっぱいに表示するため、バーとは独立した
          要素にした。#65 問題6: 60fpsのJS setIntervalポーリングを廃止し、CSS
          transition(transform scaleX)にブラウザ側の補間を任せる。
          #66レビュー2巡目should1: 再生中にidleへ入った場合はバー同様にフェード
          する（進行しているのに操作バーだけ消えて進捗線だけ残るのは中途半端）。
          一時停止中にidleへ入った場合だけは、フェードさせずに残す（進捗が動いて
          いないこと自体が「止まっている」手がかりになる。idleFadeClassNameは
          「今フェードして隠すべきか」のboolean一つだけを見るヘルパーなので、
          バーとは別の条件（isIdle && !isPausedByUser）を渡して使い回す）。 */}
      <div
        className={`fixed bottom-0 left-0 right-0 h-0.5 bg-white/10 overflow-hidden z-40 ${idleFadeClassName(isIdle && !isPausedByUser)}`}
      >
        <div
          className="h-full w-full bg-white/50 origin-left"
          style={{
            transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})`,
            transition:
              progressDurationMs > 0 ? `transform ${progressDurationMs}ms linear` : 'none',
          }}
        />
      </div>

      {/* ステータスメッセージ・フローティングの操作バー。idleでフェードする
          （#66レビューshould: プログレスラインの一時停止中の扱いは上で独立
          させている。こちらは再生中/一時停止中のどちらでも、idleになれば
          常にフェードする）。 */}
      <div className={idleFadeClassName(isIdle)}>
        {/* ステータスメッセージ（フローティングバーの上に表示）。#66レビューnit:
            長いパス（ピック完了メッセージ等）が狭い画面幅からはみ出さないよう
            max-w-[90vw]+truncateを付ける。 */}
        {statusMessage && (
          <div
            className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-black/80 backdrop-blur-sm text-white/70 text-xs px-4 py-2 rounded-full border border-white/10 whitespace-nowrap max-w-[90vw] truncate"
            title={statusMessage}
          >
            {statusMessage}
          </div>
        )}

        {/* フローティングの操作バー。#66視覚刷新: 画面幅いっぱいの2段グリッドバーを
            やめ、下中央に浮かぶ角丸のコンパクトなガラス調バー1本にした
            （DESIGN.md「Floating Control Bar」）。左=情報、中央=主要操作、
            右=副次操作の3クラスタ構成。
            #66レビュー2巡目must1（案a・メイン決定）: 実ブラウザではマウス
            クリックでボタンにフォーカスが残り、その後の何らかのキー押下で
            `:focus-visible`が真に反転してしまう（Chromiumの仕様。押されたキー
            自体が「キーボード操作があった」証拠になるため）ことが実機で確認
            された。個々のキー（Space等）だけ特別扱いする対症療法では別のキー
            （矢印キー等）で同じ穴が再現するため、根本的に「マウスクリックでは
            そもそもフォーカスを取らせない」方針に変更した
            （macOSのWKWebViewの既定挙動と同じ）。
            #66レビュー3巡目nit: 当初はこの`mousedown`のpreventDefaultを
            コンテナ1箇所に付けていたが、それだとファイル名テキストの
            ドラッグ選択も巻き込んで無効化してしまっていた。各`<button>`
            要素にのみ`guardButtonMouseDown`（`createButtonFocusGuard`）を
            個別に付ける方式に変更し、ファイル名は通常通り選択できるように
            した。Tabキーによるフォーカス移動は`mousedown`を経由しないため
            影響を受けず、キーボード操作は従来通り機能する。 */}
        <div
          ref={barContainerRef}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-xl"
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <div className="flex items-center gap-1 bg-black/50 backdrop-blur-md rounded-2xl border border-white/10 pl-2 pr-1.5 py-1.5 shadow-2xl">
            {/* 左: 情報クラスタ（GPSサムネ[任意] + ファイル名 · 撮影日 · 位置n/N） */}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {hasGps && (
                <button
                  onClick={async () => {
                    const url = `https://www.google.com/maps?q=${image.exif!.gpsLatitude},${image.exif!.gpsLongitude}`;
                    await openUrl(url);
                  }}
                  onMouseDown={guardButtonMouseDown}
                  className="relative shrink-0 w-8 h-8 rounded-lg overflow-hidden border border-white/10 hover:border-white/20 transition-colors group"
                  title={t('locationMapAlt')}
                  aria-label={t('locationMapAlt')}
                >
                  {/* OpenStreetMap Tile Usage Policy: img タグではカスタム User-Agent を送れないため、
                    高速に写真をスキップするとレート制限を受ける可能性がある */}
                  <img
                    src={tileUrl!}
                    alt={t('locationMapAlt')}
                    className="w-full h-full object-cover grayscale opacity-70 group-hover:opacity-100 group-hover:grayscale-0 transition-all"
                  />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/10">
                    <MapPin size={12} className="text-white drop-shadow" fill="currentColor" />
                  </div>
                </button>
              )}

              <div
                className="min-w-0 flex-1 flex items-baseline gap-1.5 text-xs"
                title={infoTooltip}
              >
                <span className="text-white/75 truncate min-w-0">{fileName}</span>
                {dateShort && (
                  <>
                    <span className="text-white/20 shrink-0">·</span>
                    <span className="text-white/50 font-mono shrink-0">{dateShort}</span>
                  </>
                )}
                <span className="text-white/20 shrink-0">·</span>
                <span className="text-white/50 font-mono shrink-0 tabular-nums">
                  {currentPosition.toLocaleString()} / {totalImages.toLocaleString()}
                </span>
              </div>
            </div>

            {/* 中央: 主要操作（前へ・一時停止・次へ） */}
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={onPrevious}
                onMouseDown={guardButtonMouseDown}
                disabled={!canGoBack}
                className={`p-2 ${canGoBack ? ICON_BTN : ICON_BTN_DISABLED}`}
                title={t('previousTooltip')}
                aria-label={t('previousTooltip')}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={onTogglePause}
                onMouseDown={guardButtonMouseDown}
                className={`p-2 ${ICON_BTN}`}
                title={isPausedByUser ? t('playTooltip') : t('pauseTooltip')}
                aria-label={isPausedByUser ? t('playTooltip') : t('pauseTooltip')}
              >
                {isPausedByUser ? <Play size={20} /> : <Pause size={20} />}
              </button>
              <button
                onClick={onNext}
                onMouseDown={guardButtonMouseDown}
                className={`p-2 ${ICON_BTN}`}
                title={t('nextTooltip')}
                aria-label={t('nextTooltip')}
              >
                <ChevronRight size={18} />
              </button>
            </div>

            {/* 右: 副次操作（ピック・…メニュー） */}
            <div className="flex items-center gap-0.5 shrink-0 relative">
              <button
                onClick={handlePick}
                onMouseDown={guardButtonMouseDown}
                className={`p-2 ${ICON_BTN}`}
                title={t('pickTooltip')}
                aria-label={t('pickTooltip')}
              >
                <HandGrab size={16} />
              </button>

              <button
                onClick={() => {
                  setShowMoreMenu(!showMoreMenu);
                  setShowExcludeSubmenu(false);
                }}
                onMouseDown={guardButtonMouseDown}
                className={`p-2 ${ICON_BTN}`}
                title={t('menuTooltip')}
                aria-label={t('menuTooltip')}
                aria-haspopup="menu"
                aria-expanded={showMoreMenu}
              >
                <Ellipsis size={16} />
              </button>

              {/* サブメニュー。バーが画面右寄りに広がっても収まるよう左側へ展開する */}
              {showMoreMenu && (
                <>
                  {/* #66レビュー3巡目must: この背景幕はクリックでメニューを閉じる
                      ためのもの（写真をクリックしても閉じるべき）。祖先の操作
                      バー（`fixed bottom-6 ... -translate-x-1/2`）が
                      transform（＋その中のガラス調バー本体が持つ
                      backdrop-blur-md）を持つため、CSSの仕様上
                      `position:fixed`な子要素の含有ブロックがそのバー自身の
                      矩形に限定されてしまい、`inset-0`が画面全体ではなく
                      バーの小さな矩形にしかならず、バーの外（写真等）を
                      クリックしても背景幕に当たらずメニューが閉じなかった
                      （1巡目の視覚刷新でバーにtransformを持たせて以来の回帰）。
                      `createPortal`で`document.body`直下に出し、transform/
                      backdrop-filterを持つ祖先の影響を受けないようにする。 */}
                  {createPortal(
                    <div className="fixed inset-0 z-40" onClick={handleMoreMenuBackdropClick} />,
                    document.body,
                  )}
                  <div className="absolute bottom-full right-0 mb-2 bg-black/90 rounded-xl shadow-2xl border border-white/10 p-1.5 space-y-0.5 w-52 z-50 backdrop-blur-md">
                    <button
                      onClick={handleOpenDirectory}
                      onMouseDown={guardButtonMouseDown}
                      disabled={isOpeningDirectory}
                      className="w-full p-2 rounded-lg hover:bg-white/10 text-left text-sm text-white/60 hover:text-white/90 transition-colors flex items-center gap-2"
                    >
                      <FolderOpen size={14} />
                      {t('openInFileManager')}
                    </button>

                    <button
                      onClick={(e) => {
                        // #66レビュー3巡目should: マウスクリック(detail>0)か
                        // キーボードのEnter/Space起動(detail===0)かを
                        // App.tsx側のuseFocusTrap呼び出しへ伝える。
                        onOpenPickTab(e.detail > 0);
                        setShowMoreMenu(false);
                      }}
                      onMouseDown={guardButtonMouseDown}
                      className="w-full p-2 rounded-lg hover:bg-white/10 text-left text-sm text-white/60 hover:text-white/90 transition-colors flex items-center gap-2"
                    >
                      <HandGrab size={14} />
                      {t('viewPicks')}
                    </button>

                    {/* 除外サブメニュー */}
                    <div className="relative">
                      <button
                        onClick={() => setShowExcludeSubmenu(!showExcludeSubmenu)}
                        onMouseDown={guardButtonMouseDown}
                        className="w-full p-2 rounded-lg hover:bg-white/10 text-left text-sm text-white/60 hover:text-white/90 transition-colors flex items-center gap-2"
                        aria-haspopup="menu"
                        aria-expanded={showExcludeSubmenu}
                      >
                        <Ban size={14} />
                        {t('excludeMenuLabel')}
                        <ChevronLeft size={12} className="ml-auto" />
                      </button>
                      {showExcludeSubmenu && (
                        <div className="absolute right-full top-0 mr-1 bg-black/90 rounded-xl shadow-2xl border border-white/10 p-1.5 space-y-0.5 w-48 z-50 backdrop-blur-md">
                          <button
                            onClick={() => handleExclude('date')}
                            onMouseDown={guardButtonMouseDown}
                            className="w-full p-2 rounded-lg hover:bg-white/10 text-left text-sm text-white/60 hover:text-white/90 transition-colors"
                          >
                            {t('excludeByDate')}
                          </button>
                          <button
                            onClick={() => handleExclude('directory')}
                            onMouseDown={guardButtonMouseDown}
                            className="w-full p-2 rounded-lg hover:bg-white/10 text-left text-sm text-white/60 hover:text-white/90 transition-colors"
                          >
                            {t('excludeByDirectory')}
                          </button>
                          <button
                            onClick={() => handleExclude('file')}
                            onMouseDown={guardButtonMouseDown}
                            className="w-full p-2 rounded-lg hover:bg-white/10 text-left text-sm text-white/60 hover:text-white/90 transition-colors"
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
          </div>
        </div>
      </div>
    </>
  );
});
