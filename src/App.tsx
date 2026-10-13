import { useState, useEffect, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import type { OverlayUIHandle } from './components/OverlayUI';
import { Settings } from './components/Settings';
import type { TabType } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { useMouseIdle } from './hooks/useMouseIdle';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useWindowMode } from './hooks/useWindowMode';
import { useLocaleSync } from './hooks/useLocaleSync';
import { deriveEmptyStateContent, deriveBottomNotice } from './lib/emptyState';
import {
  getPlaylistInfo,
  getLastDirectoryPath,
  restorePlaylist,
  rescanLastDirectory,
  getSetting,
  getOsLocale,
} from './lib/tauri';
import { runStartupSequence } from './lib/startup';
import { subscribeFailureNotice } from './lib/failureNotice';
import { exit } from '@tauri-apps/plugin-process';
import { X, Settings as SettingsIcon, Minimize2, Maximize2, Keyboard } from 'lucide-react';
import logoBg from './assets/logo-bg.webp';
import { useT, useLocale, initLocale, resolveStartupDirectoryError } from './lib/i18n';
import {
  clampDisplayInterval,
  DEFAULT_DISPLAY_INTERVAL,
  DEFAULT_VIDEO_AUDIO_ENABLED,
  DEFAULT_MAP_THUMBNAIL_ENABLED,
  DEFAULT_VIDEO_MAX_DURATION_SEC,
  idleFadeClassName,
  normalizeVideoMaxDuration,
} from './constants';
import { createButtonFocusGuard } from './lib/keyboardShortcuts';
import { useExcludeRescan } from './components/Settings/useExcludeRescan';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { ConfirmDialogHost } from './components/ConfirmDialog';
import { createClickDebouncer, createWheelNavigator } from './lib/photoGestures';

function App() {
  const t = useT();
  const locale = useLocale();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<TabType>('scan');
  const [settingsKey, setSettingsKey] = useState(0);
  // #66レビュー3巡目should: useFocusTrapへ「マウスクリックで開かれたか」を
  // 伝えるための状態（詳細はuseFocusTrap.tsのJSDoc参照）。
  const [settingsOpenedViaMouse, setSettingsOpenedViaMouse] = useState(false);
  const [shortcutsOpenedViaMouse, setShortcutsOpenedViaMouse] = useState(false);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  // #82レビュー2巡目 nit: initLocale完了前は、モジュール読込時点の暫定推定
  // （navigator.language等）でロケールが確定していることがあり、直後に
  // OSロケール優先の結果へ切り替わって表示言語が一瞬反転して見えることがある。
  // ローディング文言はinitLocale完了（localeReady=true）まで出さないことで防ぐ。
  const [localeReady, setLocaleReady] = useState(false);
  const [displayInterval, setDisplayInterval] = useState<number>(DEFAULT_DISPLAY_INTERVAL);
  // #68: 動画の音声ON/OFFと最大再生時間（秒。0=無制限）。永続化は設定画面が担い、
  // ここは起動時の復元値と設定画面からの変更通知を受けてSlideshowへ渡すだけ。
  const [videoAudioEnabled, setVideoAudioEnabled] = useState<boolean>(DEFAULT_VIDEO_AUDIO_ENABLED);
  const [mapThumbnailEnabled, setMapThumbnailEnabled] = useState<boolean>(
    DEFAULT_MAP_THUMBNAIL_ENABLED,
  );
  const [videoMaxDurationSec, setVideoMaxDurationSec] = useState<number>(
    DEFAULT_VIDEO_MAX_DURATION_SEC,
  );
  const [initStatus, setInitStatus] = useState<string>(''); // 初期化状態メッセージ
  const [realtimeProgress, setRealtimeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [isOverlayHovered, setIsOverlayHovered] = useState(false); // オーバーレイにマウスオーバー中か
  const [isPausedByUser, setIsPausedByUser] = useState(false); // ユーザーが明示的に一時停止したか
  // #66 問題4: ショートカット一覧（`?`キー、または右上のヘルプボタン）の開閉状態。
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  // #65: ディレクトリが一度でも設定されたことがあるか。「本当に未設定」（ようこそ画面）と
  // 「設定済みだが今アクセスできない/スキャン失敗/空」を区別するために使う。
  const [hasDirectory, setHasDirectory] = useState(false);
  // #65: 起動時自動スキャンで前回ディレクトリが拒否された場合の理由（本文コメント由来）。
  // #82レビューshould1: 表示文言に確定させた文字列でなく、raw（バックエンドの
  // エラーコード or 任意の文字列）とディレクトリパスを保持する。表示のたびに
  // `resolveStartupDirectoryError`で現在のロケールへ解決することで、エラー表示中に
  // 言語を切り替えても新旧の言語が混在しない（前の言語のまま固まらない）。
  const [directoryError, setDirectoryError] = useState<{ raw: string; directory: string } | null>(
    null,
  );
  // #103: ウィンドウモード切替の失敗通知（権限不足等で setFullscreen が拒否されても無反応にしない）
  const [windowModeError, setWindowModeError] = useState<{ text: string; seq: number } | null>(
    null,
  );
  // #115: 起動時に続行できない失敗（前回フォルダの取得失敗など）。ようこそ画面に見せず、再試行できる案内にする。
  const [startupFailure, setStartupFailure] = useState<'lastDirectory' | 'initialize' | null>(null);
  // 非同期コールバック/一度だけ登録するリスナーから、常に現在のロケールで文言を引くための参照。
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });
  // 起動時の設定取得失敗。読み込み中画面の間にトーストが消えないよう、表示可能になってから通知する。
  const [startupSettingsFailed, setStartupSettingsFailed] = useState(false);
  const initRef = useRef(false); // 初期化が1回だけ実行されるようにする
  const overlayRef = useRef<OverlayUIHandle>(null);
  const { isIdle, setIsHovering, resetIdle } = useMouseIdle(3000);
  // #78: 写真上のクリック（一時停止/再開）とホイール（前/次）の判定器。状態を持つので
  // 再レンダーをまたいで同じインスタンスを使い続ける。
  const acceptPhotoClick = useRef(createClickDebouncer()).current;
  const navigateByWheel = useRef(createWheelNavigator()).current;
  // #66レビュー3巡目nit: 右上ピル内の各ボタンへ個別に付ける
  // onMouseDownガード（詳細はOverlayUI.tsxの同種のrefと同じ理由）。
  const pillContainerRef = useRef<HTMLDivElement>(null);
  const guardPillButtonMouseDown = useMemo(() => createButtonFocusGuard(pillContainerRef), []);

  // #65 問題4: isPlaying はこのフックの内部状態ではなく、ここで導出した派生値にする。
  // 設定画面を開いている/オーバーレイにホバー中/ユーザーが明示的に一時停止した、の
  // いずれかであれば止まる。initialize()やスキャン完了処理が何を呼ぼうと、この式が
  // 変わらない限り再生は始まらない（「設定画面で再スキャンすると裏で進む」の根絶）。
  const isPlaying = isInitialized && !isPausedByUser && !isOverlayHovered && !isSettingsOpen;

  const {
    currentImage,
    displayToken,
    isLoading,
    notice,
    mediaSkipToast,
    handleMediaFailure,
    resumeAfterFailures,
    progressPercent,
    progressDurationMs,
    loadNextImage,
    loadPreviousImage,
    initialize,
    handleMediaReady,
  } = useSlideshow(displayInterval, isPlaying, totalImages);

  // プレイリスト情報を更新
  const updatePlaylistInfo = async () => {
    try {
      const info = await getPlaylistInfo();
      if (info) {
        const [position, total, canGoBackValue] = info;
        setCurrentPosition(position);
        setTotalImages(total);
        setCanGoBack(canGoBackValue);
      }
    } catch (err) {
      console.error('Failed to get playlist info:', err);
    }
  };

  useLocaleSync(locale, t);

  // #103: ウィンドウモード切替の失敗通知は windowModeError に集約する。
  const { isFullscreen, toggleWindowMode: handleToggleWindowMode } = useWindowMode(
    t,
    (text) => setWindowModeError((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 })),
    () => setWindowModeError(null),
  );

  // 起動シーケンス（前回状態の復元→可能なら即表示、スキャンはバックグラウンド）を走らせる。
  // 初回の起動と、起動失敗の案内画面の「再試行」の両方から呼ぶ（#115）。
  const startSequence = () => {
    runStartupSequence({
      getSetting,
      getLastDirectoryPath,
      restorePlaylist,
      rescanLastDirectory,
      initialize,
      listenScanProgress: (cb) =>
        listen<{ current: number; total: number }>('scan-progress', (event) => cb(event.payload)),
      setInitStatus,
      setRealtimeProgress,
      setIsInitialized,
      setDisplayInterval: (ms) => setDisplayInterval(clampDisplayInterval(ms)),
      setVideoAudioEnabled,
      setMapThumbnailEnabled,
      setVideoMaxDurationSec: (sec) => setVideoMaxDurationSec(normalizeVideoMaxDuration(sec)),
      updatePlaylistInfo,
      setHasDirectory,
      onStartupFailure: (kind) => {
        // #115: 設定の取得失敗は既定値で続行して上部の通知で伝え、前回フォルダの取得失敗など
        // 続行できない失敗は「ようこそ」にせず、再試行できる案内画面にする。
        if (kind === 'settings') {
          setStartupSettingsFailed(true);
        } else {
          setStartupFailure(kind);
        }
      },
      onDirectoryError: (err, directory) => {
        // #82レビューshould1: ここでは文言に確定させず、raw文字列のまま
        // 保持する（表示側で毎レンダー`resolveStartupDirectoryError`にかける）。
        const raw = err instanceof Error ? err.message : String(err);
        setDirectoryError({ raw, directory });
      },
    });
  };

  // 初期化（React Strict Modeで2回実行されるのを防ぐ）
  useEffect(() => {
    if (initRef.current) {
      return; // 既に初期化済み
    }

    // 最初に画面描画を完了させるため、初期化処理を次のイベントループで実行
    const timeoutId = setTimeout(() => {
      initRef.current = true; // 初期化開始をマーク

      // #80: 起動シーケンスより先に言語設定を確定させる（以降の initStatus 表示・
      // 案内画面が最初から正しい言語になるようにするため）。
      // #82レビューmust: `initLocale` 自体が内部で例外を吸収し必ずresolveする
      // （getSetting/getOsLocaleの失敗はどちらも'auto'または既存の解決結果への
      // フォールバックで飲み込まれる）ため、ここに`.catch()`は不要。以前は無く、
      // getSettingがrejectすると起動シーケンスが一生呼ばれず起動画面のまま
      // 止まっていた（テスト担当が発見）。
      void initLocale(getSetting, getOsLocale).then(() => {
        // #82レビュー2巡目 nit: ここでロケールが確定した後にローディング文言を
        // 表示し始める（それまでは何も出さず、暫定推定からの反転を見せない）。
        setLocaleReady(true);
        // #62レビューS1: 起動時の初期化シーケンス（前回状態の復元→可能なら即表示、
        // スキャンはバックグラウンド）は React から切り離した純粋関数に委譲する
        // （src/lib/startup.ts。単体テストしやすくするため）。
        startSequence();
      });
    }, 0);

    // クリーンアップ関数
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!startupSettingsFailed || !isInitialized) return;
    setStartupSettingsFailed(false);
    setWindowModeError((prev) => ({
      text: tRef.current('startupSettingsLoadFailed'),
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, [startupSettingsFailed, isInitialized]);

  // #115: セクションがアンマウントされた後の保存失敗など、画面内に出せない失敗を上部の通知で伝える。
  useEffect(
    () =>
      subscribeFailureNotice((key) =>
        setWindowModeError((prev) => ({ text: tRef.current(key), seq: (prev?.seq ?? 0) + 1 })),
      ),
    [],
  );

  // 既に画像が表示された後に起動シーケンスが失敗した場合（案内カードは画像が無いときだけ出る）は、
  // 見えないままにせず上部の通知で伝える。
  useEffect(() => {
    if (startupFailure !== 'initialize' || !currentImage) return;
    setStartupFailure(null);
    setWindowModeError((prev) => ({
      text: tRef.current('startupInitFailedTitle'),
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, [startupFailure, currentImage]);

  // 画像が変わったらプレイリスト情報を更新。復帰できたので古いディレクトリエラーは消す。
  useEffect(() => {
    if (currentImage) {
      updatePlaylistInfo();
      setDirectoryError(null);
    }
  }, [currentImage]);

  // 起動失敗の案内画面の「再試行」: 失敗を消して、起動シーケンスをもう一度走らせる（#115）。
  const retryStartup = () => {
    setStartupFailure(null);
    setIsInitialized(false);
    startSequence();
  };

  const handlePrevious = async () => {
    await loadPreviousImage();
  };

  const handleNext = async () => {
    await loadNextImage();
  };

  // #65 問題5: 除外成功で即座に次へ進み、プレイリスト情報（位置/総数）も
  // 最新化する（除外済みの画像を表示し続けない）。
  // #65レビューnit: updatePlaylistInfoはここで明示的に呼ばない。loadNextImage が
  // currentImage を更新すれば、下の「画像が変わったら」effectが自動的に呼ぶため
  // （ここでも呼ぶと同じ呼び出しが重複していた）。除外の結果emptyPlaylistになった
  // 場合はcurrentImageがnullのままなのでeffect側は呼ばないが、表示するものが無い
  // 以上position/totalの更新は不要。
  const handleExcluded = async () => {
    await loadNextImage();
  };

  // #65 問題8: `<img>`/`<video>` のonErrorはバックエンドが既に加算した表示回数を
  // 取り消してから即座に次へ進む（「どちらにしたか」は取り消しAPI方式。理由は
  // `undo_display_count` のdocコメント参照）。
  // #65レビュー質問決定: 「前へ」で戻っている途中にonErrorになった場合は
  // loadPreviousImageでさらに戻る、前進中（既定含む）は次へ進む
  // （continueInLastDirectionが直近の方向を引き継ぐ）。
  // #65レビュー2巡目nit: undoDisplayCountの完了を待ってからcontinueInLastDirection
  // を呼ぶ（順序確定）。並行に発火すると、continueInLastDirectionが先に次の
  // get_next_imageを完了させてバックエンドのAppState.last_incremented_displayを
  // 次のpathへ進めてしまい、その後に届くundo_display_count(古いpath)が
  // パス不一致で無視されてしまう競合を避けるため。
  // #120: undo → 失敗の計数 → 次へ（古い失敗の無視・上限での停止を含む）は
  // useSlideshow の handleMediaFailure が担う。
  const handleMediaError = (path: string) => {
    void handleMediaFailure(path);
  };

  // #78: 除外の取り消し後。画像がプレイリストへ戻ったので位置/総数を更新する。
  // 除外で表示するものが無くなっていた（currentImageがnull）場合は表示を再開する。
  const handleExcludeUndone = async () => {
    if (!currentImage) {
      await loadNextImage();
    } else {
      await updatePlaylistInfo();
    }
  };

  // #78: 写真上のマウス操作。写真領域（Slideshow）にだけ付けるため、オーバーレイ・
  // 右上ピル・モーダル（写真の兄弟要素）の操作とは干渉しない。
  const handlePhotoClick = (e: React.MouseEvent) => {
    if (isSettingsOpen || isShortcutsOpen) return;
    if (!acceptPhotoClick(e.timeStamp)) return;
    // 操作の結果（⏸/▶）が見えるよう、オーバーレイを起こす。
    resetIdle();
    setIsPausedByUser((prev) => !prev);
  };

  const handlePhotoWheel = (e: React.WheelEvent) => {
    if (isSettingsOpen || isShortcutsOpen) return;
    // ピンチズーム（ctrl+wheel）等は対象外。
    if (e.ctrlKey || e.metaKey) return;
    const direction = navigateByWheel(e.deltaX, e.deltaY, e.deltaMode, e.timeStamp);
    if (direction === 'next') {
      void handleNext();
    } else if (direction === 'previous' && canGoBack) {
      void handlePrevious();
    }
  };

  // #103: 失敗通知は数秒で自動的に消す
  useEffect(() => {
    if (!windowModeError) return;
    // 全文を読み切れるよう、折り返した長い通知（フォールバックの旨など）の分だけ長めに出す。
    const timer = setTimeout(() => setWindowModeError(null), 8000);
    return () => clearTimeout(timer);
  }, [windowModeError]);

  useKeyboardShortcuts({
    canGoBack,
    isSettingsOpen,
    isShortcutsOpen,
    overlayRef,
    onPrevious: handlePrevious,
    onNext: handleNext,
    onToggleWindowMode: handleToggleWindowMode,
    onCloseSettings: () => setIsSettingsOpen(false),
    onCloseShortcuts: () => setIsShortcutsOpen(false),
    onToggleShortcuts: () => {
      // #66レビュー3巡目should: キーボードで開いた場合として扱う
      // （useFocusTrapが閉じるボタンへ正しくフォーカスリングを出す）。
      setShortcutsOpenedViaMouse(false);
      setIsShortcutsOpen((prev) => !prev);
    },
    onTogglePause: () => setIsPausedByUser((prev) => !prev),
    onExitFailed: () =>
      setWindowModeError((prev) => ({
        text: tRef.current('exitFailed'),
        seq: (prev?.seq ?? 0) + 1,
      })),
  });

  // #66レビュー3巡目should: 設定モーダルを開いた操作がマウスクリックだったか
  // どうかをuseFocusTrapへ伝える（詳細はuseFocusTrap.tsのJSDoc参照）。
  const openSettings = (tab: TabType = 'scan', viaMouse = false) => {
    setSettingsInitialTab(tab);
    setSettingsKey((k) => k + 1);
    setIsSettingsOpen(true);
    setSettingsOpenedViaMouse(viaMouse);
  };

  // `event.detail`は実際のマウスクリックでは1以上（連続クリック数）、
  // キーボードでのEnter/Space起動によるclickイベントでは0になる
  // （ブラウザ標準の挙動、#66レビュー3巡目should）。
  const handleSettings = (e: React.MouseEvent) => openSettings('scan', e.detail > 0);
  const handleOpenPickTab = (viaMouse: boolean) => openSettings('pick', viaMouse);

  const handleOverlayMouseEnter = () => {
    setIsOverlayHovered(true);
    setIsHovering(true);
  };

  const handleOverlayMouseLeave = () => {
    setIsOverlayHovered(false);
    setIsHovering(false);
  };

  const handleTogglePause = () => {
    // タッチデバイス対応：タップで一時停止/再生をトグル
    setIsPausedByUser(!isPausedByUser);
  };

  const handleScanComplete = async () => {
    // 手動スキャンなのでディレクトリは確定済み。
    setHasDirectory(true);
    setDirectoryError(null);
    // 設定でフォルダを選び直してスキャンできたなら、起動失敗の案内は役目を終える。
    // （表示できる画像が0件でも、「前回のフォルダを読み込めませんでした」を出し続けない）
    setStartupFailure(null);
    await initialize();
    setIsInitialized(true);
    // 設定画面は閉じない（ユーザーが結果を確認できるように）
    await updatePlaylistInfo();
  };

  // #111: 除外ルール変更後の再スキャン案内・実行状態。Settings は openSettings のたびに
  // key で再マウントされるため、閉じて開き直しても残るよう App が保持する。
  const excludeRescan = useExcludeRescan(handleScanComplete);

  const handleIntervalChange = (newInterval: number) => {
    setDisplayInterval(clampDisplayInterval(newInterval));
  };

  const handleVideoMaxDurationChange = (sec: number) => {
    setVideoMaxDurationSec(normalizeVideoMaxDuration(sec));
  };

  const emptyStateContent = deriveEmptyStateContent(
    { startupFailure, hasDirectory, notice, hasDirectoryError: directoryError !== null },
    t,
  );

  // #82レビューshould1: `directoryError`はraw文字列のまま保持しているため、
  // 表示文言への変換はレンダーのたびにここで行う（setState時点で固定しない）。
  // こうすることで、エラー表示中に設定画面から言語を切り替えても、次の
  // レンダーで新しい言語の文言に更新される（新旧言語が混在したまま固まらない）。
  const directoryErrorMessage = directoryError
    ? resolveStartupDirectoryError(directoryError.raw, directoryError.directory)
    : null;

  // #65レビュー修正: 復元成功後のバックグラウンドスキャン失敗など、画像表示中に出す
  // 控えめな下部トーストの文言（優先順位は deriveBottomNotice 参照）。
  const bottomNotice = deriveBottomNotice({ notice, mediaSkipToast, directoryErrorMessage }, t);

  // directoryError による下部トーストだけは数秒で自動的に消す（notice由来の通知は
  // 次の正常な画像取得時にnoticeがnullへ戻るため対象外。上の全画面案内側は
  // currentImageが無い間は自動で消さず、ユーザーが設定を開いて解決するまで残す）。
  useEffect(() => {
    if (!directoryError || !currentImage) return;
    const timer = window.setTimeout(() => setDirectoryError(null), 6000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directoryError]);

  // 初期化前（起動シーケンス自体が終わっていない）
  if (!isInitialized && !isSettingsOpen) {
    return (
      <div className="w-screen h-screen bg-black overflow-hidden relative">
        {/* 背景ロゴ */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <img src={logoBg} alt="SSS Logo" className="w-1/3 h-auto opacity-2" />
        </div>

        {/* 終了ボタン（右上）。#66視覚刷新: 通常表示中の右上ピルと統一 */}
        <div className="fixed top-4 right-4 z-50">
          <div className="flex items-center bg-black/75 backdrop-blur-md rounded-full border border-white/10 p-1 shadow-2xl">
            <button
              onClick={() => exit(0)}
              className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
              title={t('exitTooltip')}
              aria-label={t('exitTooltip')}
            >
              <X size={16} />
              <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
                {t('exitTooltip')}
              </span>
            </button>
          </div>
        </div>

        <div className="w-screen h-screen flex items-center justify-center relative z-10">
          <div className="text-white/50 text-center">
            {/* #82レビュー2巡目 nit: localeReady（initLocale完了）までは文言を出さない。
                非表示中もレイアウト高さを保つため空のnon-breaking spaceを置く。 */}
            <div className="text-lg mb-4">
              {localeReady ? initStatus || t('loadingPlaylist') : ' '}
            </div>

            {/* リアルタイム進捗表示 */}
            {realtimeProgress && (
              <div className="text-2xl font-mono text-white/40 mb-4">
                {realtimeProgress.current.toLocaleString()} /{' '}
                {realtimeProgress.total.toLocaleString()}
              </div>
            )}

            <div className="text-white/25 text-xs">{localeReady ? t('pleaseWait') : ' '}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      // #66 問題3: idle（3秒間マウス非操作）中はカーソルも隠す。写真が主役の
      // 鑑賞アプリなので、操作UIだけでなくカーソル自体も消して邪魔しない。
      // 設定モーダル・ショートカット一覧を開いている間はUIを操作中なので対象外
      // にする（#66レビューshould: ショートカット一覧を読んでいる間にカーソルが
      // 消えるのは不自然）。
      className={`w-screen h-screen bg-black overflow-hidden${
        isIdle && !isSettingsOpen && !isShortcutsOpen ? ' cursor-none' : ''
      }`}
    >
      {/* スライドショー。#78: 写真上のクリック=一時停止/再開、ホイール/横スワイプ=前/次。
          `display: contents` のラッパーはレイアウトに影響せず、写真領域だけでイベントを拾う。 */}
      <div className="contents" onClick={handlePhotoClick} onWheel={handlePhotoWheel}>
        <Slideshow
          image={currentImage}
          displayToken={displayToken}
          isPlaying={isPlaying}
          videoAudioEnabled={videoAudioEnabled}
          videoMaxDurationSec={videoMaxDurationSec}
          onMediaReady={handleMediaReady}
          onAdvance={loadNextImage}
          onMediaError={handleMediaError}
        />
      </div>

      {windowModeError && (
        // 下部のトースト・操作バー・その他メニューと重ならないよう画面上部に出す。右上のボタン列
        // （約9rem幅）と重ならないよう、右端を空けた枠の中で中央寄せする（#103）。枠自体は
        // pointer-events-none で写真上のクリック/ホイールを吸わない。長い通知（フォールバックの旨など）は
        // 切り詰めず折り返して全文を見せる（狭幅でも読める）。通知本体だけ pointer-events-auto にする。
        <div className="fixed top-4 left-4 right-[11rem] z-50 flex justify-center pointer-events-none">
          <div
            role="alert"
            title={windowModeError.text}
            className="pointer-events-auto max-w-full whitespace-normal break-words text-center bg-black/80 backdrop-blur-sm text-white/70 text-xs px-4 py-2 rounded-2xl border border-white/10"
          >
            {windowModeError.text}
          </div>
        </div>
      )}

      {/* 右上の常設ボタン（終了・ショートカット・ウィンドウモード・設定）。
          #66視覚刷新: 枠線付き四角ボタン4つの並びから、枠線なしアイコンを1つの
          ガラス調ピル（DESIGN.md「Icon Pill Group」）にまとめた。idle時は
          オーバーレイ同様にフェードアウトする（実際にキーボードでフォーカスして
          いる間は例外的に可視のまま。キーボードでTab移動して見えなくなるのを
          防ぐ）。#66レビューshould: マウスでホバーしている間もidleタイマーを
          止める（オーバーレイと同じ挙動。再生の自動一時停止は伴わない）。
          #66レビュー2巡目must1（案a）: OverlayUIの操作バーと同じ理由で、
          マウスクリックがこのピル内のボタンへフォーカスを残さないように
          `onMouseDown`でpreventDefaultする（Tabでのキーボード操作には影響
          しない）。#66レビュー3巡目nit: OverlayUIと同じ理由で、この
          preventDefaultはコンテナではなく各ボタンへ個別に付ける
          （`guardPillButtonMouseDown`）。 */}
      <div
        ref={pillContainerRef}
        className={`fixed top-4 right-4 z-50 ${idleFadeClassName(isIdle)}`}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <div className="flex items-center gap-0.5 bg-black/75 backdrop-blur-md rounded-full border border-white/10 p-1 shadow-2xl">
          <button
            onClick={(e) => {
              // #66レビュー3巡目should: マウスクリック(detail>0)かキーボードの
              // Enter/Space起動(detail===0)かをuseFocusTrapへ伝える。
              setShortcutsOpenedViaMouse(e.detail > 0);
              setIsShortcutsOpen(true);
            }}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={t('shortcutsButtonTooltip')}
            aria-label={t('shortcutsButtonTooltip')}
          >
            <Keyboard size={16} />
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {t('shortcutsButtonTooltip')}
            </span>
          </button>

          <button
            onClick={handleToggleWindowMode}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={isFullscreen ? t('switchToWindowMode') : t('switchToFullscreen')}
            aria-label={isFullscreen ? t('switchToWindowMode') : t('switchToFullscreen')}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {isFullscreen ? t('windowModeLabel') : t('fullscreenLabel')}
            </span>
          </button>

          <button
            onClick={handleSettings}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={t('settingsTitle')}
            aria-label={t('settingsTitle')}
          >
            <SettingsIcon size={16} />
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {t('settingsTitle')}
            </span>
          </button>

          <button
            onClick={() => exit(0)}
            onMouseDown={guardPillButtonMouseDown}
            className="relative p-2 rounded-full text-white/60 hover:text-white/90 hover:bg-white/10 focus-visible:text-white/90 transition-colors group"
            title={t('exitTooltip')}
            aria-label={t('exitTooltip')}
          >
            <X size={16} />
            <span className="absolute top-full right-0 mt-2 px-2 py-1 bg-black/90 text-white/70 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pointer-events-none">
              {t('exitTooltip')}
            </span>
          </button>
        </div>
      </div>

      {/* 画像がない場合の案内画面（ようこそ/空/接続不可/読込失敗）。#65問題1・5・9
          #66視覚刷新: 角丸のガラスカードに統一し、ようこそ画面だけロゴマーク・
          プライマリボタン・ショートカットヒントを添える。 */}
      {!currentImage && !isLoading && !isSettingsOpen && emptyStateContent && (
        <div className="fixed inset-0 flex items-center justify-center z-40 px-6">
          {/* #66レビューshould: max-w-smは日本語の説明文（特に長い方の文言）が
              不自然な位置で折り返っていた。max-w-mdに広げ、`text-balance`
              （Tailwind `text-wrap: balance`）で行の折返し位置を均等にする。 */}
          <div className="text-center max-w-md w-full bg-black/30 backdrop-blur-md border border-white/10 rounded-2xl px-8 py-10">
            {!hasDirectory && !startupFailure && (
              <img src={logoBg} alt="" aria-hidden="true" className="w-14 h-14 mx-auto mb-5" />
            )}
            <div className="text-white/85 text-xl font-medium mb-2">{emptyStateContent.title}</div>
            {emptyStateContent.subtitle && (
              <div className="text-white/50 text-sm mb-6 text-balance whitespace-pre-line">
                {emptyStateContent.subtitle}
              </div>
            )}
            {directoryErrorMessage && (
              <div
                className="select-text text-red-400/80 font-mono text-xs mb-6 truncate max-w-full mx-auto"
                title={directoryErrorMessage}
              >
                {directoryErrorMessage}
              </div>
            )}
            <div className="flex items-center justify-center gap-3">
              {emptyStateContent.canRetry && (
                <button
                  onClick={retryStartup}
                  className="flex items-center justify-center gap-2 px-6 py-2.5 bg-white/90 hover:bg-white text-black font-medium rounded-lg transition-colors text-sm"
                >
                  {t('retryButton')}
                </button>
              )}
              {emptyStateContent.canContinue && (
                // #120: 失敗で止まった時の主操作は「続ける」（失敗セットを空にして次へ）。
                // 主ボタンは1画面に1つなので、この時の「設定を開く」は標準ボタンにする。
                <button
                  onClick={() => void resumeAfterFailures()}
                  className="flex items-center justify-center gap-2 px-6 py-2.5 bg-white/90 hover:bg-white text-black font-medium rounded-lg transition-colors text-sm"
                >
                  {t('continueSlideshow')}
                </button>
              )}
              <button
                onClick={handleSettings}
                className={
                  emptyStateContent.canContinue || emptyStateContent.canRetry
                    ? 'flex items-center justify-center gap-2 px-6 py-2.5 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded-lg transition-colors text-sm'
                    : 'flex items-center justify-center gap-2 px-6 py-2.5 bg-white/90 hover:bg-white text-black font-medium rounded-lg transition-colors text-sm'
                }
              >
                <SettingsIcon size={16} />
                {startupFailure
                  ? t('chooseAnotherFolder')
                  : hasDirectory
                    ? t('openSettings')
                    : t('selectFolder')}
              </button>
            </div>
            {!hasDirectory && !startupFailure && (
              <button
                type="button"
                onClick={(e) => {
                  // 右上のショートカットボタンと同じ経路（#100）。クリック(detail>0)か
                  // キーボードのEnter/Space起動(detail===0)かをuseFocusTrapへ伝える。
                  setShortcutsOpenedViaMouse(e.detail > 0);
                  setIsShortcutsOpen(true);
                }}
                aria-keyshortcuts="?"
                className="group mx-auto -mb-1 mt-5 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs text-white/50 transition-colors hover:text-white/80 focus-visible:text-white/80"
              >
                <span
                  className="rounded border border-white/10 bg-white/8 px-1.5 py-0.5 font-mono transition-colors group-hover:bg-white/15 group-focus-visible:bg-white/15"
                  aria-hidden="true"
                >
                  ?
                </span>
                <span>{t('shortcutsHintWelcome')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 控えめな通知（鑑賞中の画像は維持したまま）: フォルダ接続不可・連続読込失敗・
          復元後のバックグラウンドスキャン失敗（#65レビュー修正） */}
      {currentImage && bottomNotice && (
        <div
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 bg-black/80 backdrop-blur-sm text-white/70 text-xs px-4 py-2 rounded-full border border-white/10 max-w-[90vw] truncate"
          title={bottomNotice}
        >
          {bottomNotice}
        </div>
      )}

      {/* オーバーレイUI（プログレスラインは常時表示、バー/ステータスはidleで
          フェード。#66レビューshould: idle中に一時停止していても手がかりを
          残すため、フェードの制御はOverlayUI内部に持たせisIdleを直接渡す）。 */}
      <OverlayUI
        ref={overlayRef}
        image={currentImage}
        canGoBack={canGoBack}
        currentPosition={currentPosition}
        totalImages={totalImages}
        progress={progressPercent}
        progressDurationMs={progressDurationMs}
        isPausedByUser={isPausedByUser}
        isIdle={isIdle}
        showMapThumbnail={mapThumbnailEnabled}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onOpenPickTab={handleOpenPickTab}
        onMouseEnter={handleOverlayMouseEnter}
        onMouseLeave={handleOverlayMouseLeave}
        onTogglePause={handleTogglePause}
        onExcluded={handleExcluded}
        onExcludeUndone={handleExcludeUndone}
      />

      {/* ショートカット一覧（#66 問題4） */}
      <ShortcutsOverlay
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
        openedViaMouse={shortcutsOpenedViaMouse}
      />

      {/* 設定画面 */}
      <Settings
        key={settingsKey}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onScanComplete={handleScanComplete}
        excludeRescan={excludeRescan}
        onIntervalChange={handleIntervalChange}
        onVideoAudioChange={setVideoAudioEnabled}
        onMapThumbnailChange={setMapThumbnailEnabled}
        onVideoMaxDurationChange={handleVideoMaxDurationChange}
        initialTab={settingsInitialTab}
        openedViaMouse={settingsOpenedViaMouse}
      />

      {/* #119: アプリ内の確認モーダル（window.confirm の代替） */}
      <ConfirmDialogHost />
    </div>
  );
}

export default App;
