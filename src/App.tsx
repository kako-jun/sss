import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import { Settings } from './components/Settings';
import type { TabType } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { useMouseIdle } from './hooks/useMouseIdle';
import {
  getPlaylistInfo,
  getLastDirectoryPath,
  restorePlaylist,
  scanDirectory,
  getSetting,
  undoDisplayCount,
} from './lib/tauri';
import { runStartupSequence } from './lib/startup';
import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';
import { X, Settings as SettingsIcon, Minimize2, Maximize2 } from 'lucide-react';
import logoBg from './assets/logo-bg.webp';
import { uiText, noticeMessages } from './lib/messages';
import { clampDisplayInterval, DEFAULT_DISPLAY_INTERVAL } from './constants';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<TabType>('scan');
  const [settingsKey, setSettingsKey] = useState(0);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [displayInterval, setDisplayInterval] = useState<number>(DEFAULT_DISPLAY_INTERVAL);
  const [initStatus, setInitStatus] = useState<string>(''); // 初期化状態メッセージ
  const [realtimeProgress, setRealtimeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [isOverlayHovered, setIsOverlayHovered] = useState(false); // オーバーレイにマウスオーバー中か
  const [isPausedByUser, setIsPausedByUser] = useState(false); // ユーザーが明示的に一時停止したか
  const [isFullscreen, setIsFullscreen] = useState(true); // フルスクリーン状態（起動時の設定値に合わせた初期値）
  // #65: ディレクトリが一度でも設定されたことがあるか。「本当に未設定」（ようこそ画面）と
  // 「設定済みだが今アクセスできない/スキャン失敗/空」を区別するために使う。
  const [hasDirectory, setHasDirectory] = useState(false);
  // #65: 起動時自動スキャンで前回ディレクトリが拒否された場合の理由（本文コメント由来）。
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const initRef = useRef(false); // 初期化が1回だけ実行されるようにする
  const { isIdle, setIsHovering } = useMouseIdle(3000);

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
    progressPercent,
    progressDurationMs,
    loadNextImage,
    loadPreviousImage,
    continueInLastDirection,
    initialize,
    handleMediaReady,
  } = useSlideshow(displayInterval, isPlaying);

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

  // フルスクリーン状態をOSの実態と同期
  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();
    // 初期値を実態から取得
    win
      .isFullscreen()
      .then((v) => {
        if (!cancelled) setIsFullscreen(v);
      })
      .catch(() => {});
    // OSによるフルスクリーン変化を検知して同期
    // （Tauri v2 にフルスクリーン専用イベントがないため onResized で近似）
    let cleanup: (() => void) | null = null;
    const listenerPromise = win
      .onResized(() => {
        win
          .isFullscreen()
          .then((v) => {
            if (!cancelled) setIsFullscreen(v);
          })
          .catch(() => {});
      })
      .then((fn) => {
        cleanup = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // 非同期登録が完了してからクリーンアップ（Strict Mode での漏れを防ぐ）
      listenerPromise.finally(() => cleanup?.());
    };
  }, []);

  // 初期化（React Strict Modeで2回実行されるのを防ぐ）
  useEffect(() => {
    if (initRef.current) {
      return; // 既に初期化済み
    }

    // 最初に画面描画を完了させるため、初期化処理を次のイベントループで実行
    const timeoutId = setTimeout(() => {
      initRef.current = true; // 初期化開始をマーク

      // #62レビューS1: 起動時の初期化シーケンス（前回状態の復元→可能なら即表示、
      // スキャンはバックグラウンド）は React から切り離した純粋関数に委譲する
      // （src/lib/startup.ts。単体テストしやすくするため）。
      runStartupSequence({
        getSetting,
        getLastDirectoryPath,
        restorePlaylist,
        scanDirectory,
        initialize,
        listenScanProgress: (cb) =>
          listen<{ current: number; total: number }>('scan-progress', (event) => cb(event.payload)),
        setInitStatus,
        setRealtimeProgress,
        setIsInitialized,
        setDisplayInterval: (ms) => setDisplayInterval(clampDisplayInterval(ms)),
        updatePlaylistInfo,
        setHasDirectory,
        onDirectoryError: (err) => {
          setDirectoryError(err instanceof Error ? err.message : String(err));
        },
      });
    }, 0);

    // クリーンアップ関数
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画像が変わったらプレイリスト情報を更新。復帰できたので古いディレクトリエラーは消す。
  useEffect(() => {
    if (currentImage) {
      updatePlaylistInfo();
      setDirectoryError(null);
    }
  }, [currentImage]);

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
  const handleMediaError = (path: string) => {
    void (async () => {
      try {
        await undoDisplayCount(path);
      } catch (err) {
        console.error('Failed to undo display count:', err);
      }
      await continueInLastDirection();
    })();
  };

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // #65: キーリピート(押しっぱなし)による多重発火を無視する（問題3関連）。
      if (e.repeat) return;

      // ESCキーでアプリ終了
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try {
          await invoke('exit_app');
        } catch (err) {
          console.error('Failed to exit app:', err);
        }
      }

      // 左矢印キーで前の画像へ
      if (e.key === 'ArrowLeft' && canGoBack && !isSettingsOpen) {
        e.preventDefault();
        await handlePrevious();
      }

      // 右矢印キーで次の画像へ
      if (e.key === 'ArrowRight' && !isSettingsOpen) {
        e.preventDefault();
        handleNext();
      }
    };

    // captureフェーズで最優先でキャッチ
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
    // handleNext/handlePrevious は毎レンダーで再生成されるが deps に含めると
    // リスナーが毎回張り直されるため意図的に除外
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canGoBack, isSettingsOpen]);

  const openSettings = (tab: TabType = 'scan') => {
    setSettingsInitialTab(tab);
    setSettingsKey((k) => k + 1);
    setIsSettingsOpen(true);
  };

  const handleSettings = () => openSettings('scan');
  const handleOpenPickTab = () => openSettings('pick');

  const handleToggleWindowMode = async () => {
    try {
      const win = getCurrentWindow();
      const next = !isFullscreen;
      await win.setFullscreen(next);
      // ウィンドウモード時はタイトルバーを表示してウィンドウを掴めるようにする
      // フルスクリーン時は decorations を非表示に戻す
      await win.setDecorations(!next);
      setIsFullscreen(next);
    } catch (err) {
      console.error('Failed to toggle window mode:', err);
    }
  };

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
    await initialize();
    setIsInitialized(true);
    // 設定画面は閉じない（ユーザーが結果を確認できるように）
    await updatePlaylistInfo();
  };

  const handleIntervalChange = (newInterval: number) => {
    setDisplayInterval(clampDisplayInterval(newInterval));
  };

  // #65: 「ようこそ」画面は本当に未設定（ディレクトリが一度も設定されていない）の
  // 時だけ出す。設定済みだが空/接続不可/読込失敗の場合は専用の案内にする
  // （問題1: 消えたファイル1枚でようこそ画面に落ちる、の根絶）。
  const emptyStateContent = (() => {
    if (!hasDirectory) {
      return { title: uiText.welcomeTitle, subtitle: uiText.welcomeSubtitle };
    }
    if (notice?.kind === 'emptyPlaylist') {
      return { title: uiText.emptyPlaylistTitle, subtitle: uiText.emptyPlaylistSubtitle };
    }
    if (notice?.kind === 'rootUnavailable') {
      return { title: noticeMessages.rootUnavailable, subtitle: '' };
    }
    if (notice?.kind === 'loadFailedGaveUp') {
      return { title: noticeMessages.loadFailedGaveUp, subtitle: '' };
    }
    if (notice?.kind === 'error') {
      return { title: 'エラーが発生しました', subtitle: notice.message };
    }
    // #65レビュー修正: restorePlaylist失敗→前景scanDirectory自体が失敗した場合、
    // initialize()（＝useSlideshowの最初のgetNextImage）が一度も呼ばれないため
    // notice はずっと null のまま。旧実装はこの分岐が無く emptyStateContent が
    // null になり、案内画面自体が描画されず directoryError も表示されなかった
    // （テスト担当が発見）。hasDirectory は既に true（前回ディレクトリはあった）
    // なので「ようこそ」ではなく専用の案内にする。
    if (directoryError) {
      return {
        title: uiText.directoryUnreachableTitle,
        subtitle: uiText.directoryUnreachableSubtitle,
      };
    }
    return null; // 読込中（初回表示待ち）。ローディング画面はisInitializedの分岐が別途担当。
  })();

  // #65レビュー修正: 復元成功後のバックグラウンドスキャン失敗は、既に最初の画像を
  // 表示できている（currentImage != null）ため上の全画面案内は出さない。写真を
  // 邪魔しない控えめな通知（下部トースト、数秒で自動的に消える）で理由を出す。
  // notice（rootUnavailable/loadFailedGaveUp/error）優先度を最優先にし、無ければ
  // directoryError を出す（同時に出て重なるのを防ぐ）。
  // #65レビューS3: 鑑賞中に invoke の reject（error通知）が起きた場合も同じ
  // トーストで見せる（useSlideshow側が表示間隔ごとに自動再試行する）。
  const bottomNotice: string | null =
    notice?.kind === 'rootUnavailable'
      ? noticeMessages.rootUnavailable
      : notice?.kind === 'loadFailedGaveUp'
        ? noticeMessages.loadFailedGaveUp
        : notice?.kind === 'error'
          ? notice.message
          : directoryError
            ? noticeMessages.startupDirectoryRejected(directoryError)
            : null;

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

        {/* 終了ボタン（右上） */}
        <button
          onClick={() => exit(0)}
          className="fixed top-4 right-4 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/30 hover:text-white/60 transition-colors group"
          title={uiText.exitTooltip}
        >
          <X size={18} />
          <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            {uiText.exitTooltip}
          </span>
        </button>

        <div className="w-screen h-screen flex items-center justify-center relative z-10">
          <div className="text-white/50 text-center">
            <div className="text-lg mb-4">{initStatus || uiText.loadingPlaylist}</div>

            {/* リアルタイム進捗表示 */}
            {realtimeProgress && (
              <div className="text-2xl font-mono text-white/40 mb-4">
                {realtimeProgress.current.toLocaleString()} /{' '}
                {realtimeProgress.total.toLocaleString()}
              </div>
            )}

            <div className="text-white/25 text-xs">{uiText.pleaseWait}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-black overflow-hidden">
      {/* スライドショー */}
      <Slideshow
        image={currentImage}
        displayToken={displayToken}
        isPlaying={isPlaying}
        onMediaReady={handleMediaReady}
        onAdvance={loadNextImage}
        onMediaError={handleMediaError}
      />

      {/* 終了ボタン（右上） */}
      <button
        onClick={() => exit(0)}
        className="fixed top-4 right-4 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/30 hover:text-white/60 transition-colors group"
        title={uiText.exitTooltip}
      >
        <X size={18} />
        <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          {uiText.exitTooltip}
        </span>
      </button>

      {/* 画像がない場合の案内画面（ようこそ/空/接続不可/読込失敗）。#65問題1・5・9 */}
      {!currentImage && !isLoading && !isSettingsOpen && emptyStateContent && (
        <div className="fixed inset-0 flex items-center justify-center z-40">
          <div className="text-center max-w-md px-6">
            <div className="text-white/60 text-xl mb-2">{emptyStateContent.title}</div>
            {emptyStateContent.subtitle && (
              <div className="text-white/30 text-sm mb-6">{emptyStateContent.subtitle}</div>
            )}
            {directoryError && (
              <div
                className="text-red-400/80 font-mono text-xs mb-6 truncate max-w-[90vw] mx-auto"
                title={noticeMessages.startupDirectoryRejected(directoryError)}
              >
                {noticeMessages.startupDirectoryRejected(directoryError)}
              </div>
            )}
            <button
              onClick={handleSettings}
              className="flex items-center gap-2 px-5 py-2 bg-white/8 hover:bg-white/15 border border-white/10 text-white/50 hover:text-white/80 rounded transition-colors mx-auto text-sm"
            >
              <SettingsIcon size={16} />
              {hasDirectory ? uiText.openSettings : uiText.selectFolder}
            </button>
          </div>
        </div>
      )}

      {/* 控えめな通知（鑑賞中の画像は維持したまま）: フォルダ接続不可・連続読込失敗・
          復元後のバックグラウンドスキャン失敗（#65レビュー修正） */}
      {currentImage && bottomNotice && (
        <div
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 bg-black/80 text-white/50 text-xs px-3 py-2 rounded border border-white/10 max-w-[90vw] truncate"
          title={bottomNotice}
        >
          {bottomNotice}
        </div>
      )}

      {/* ウィンドウモード切り替え（右上） */}
      <button
        onClick={handleToggleWindowMode}
        className="fixed top-4 right-24 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/20 hover:text-white/50 transition-colors group"
        title={isFullscreen ? 'ウィンドウモードに切り替え' : 'フルスクリーンに戻す'}
      >
        {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          {isFullscreen ? 'ウィンドウモード' : 'フルスクリーン'}
        </span>
      </button>

      {/* 設定ボタン（右上、×ボタンの左隣） */}
      <button
        onClick={handleSettings}
        className="fixed top-4 right-14 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/20 hover:text-white/50 transition-colors group"
        title="設定"
      >
        <SettingsIcon size={16} />
        <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          設定
        </span>
      </button>

      {/* オーバーレイUI（フェードイン/アウト） */}
      <div
        className="transition-opacity duration-300"
        style={{
          opacity: isIdle ? 0 : 1,
          pointerEvents: isIdle ? 'none' : 'auto',
        }}
      >
        <OverlayUI
          image={currentImage}
          canGoBack={canGoBack}
          currentPosition={currentPosition}
          totalImages={totalImages}
          progress={progressPercent}
          progressDurationMs={progressDurationMs}
          isPlaying={isPlaying}
          onPrevious={handlePrevious}
          onNext={handleNext}
          onOpenPickTab={handleOpenPickTab}
          onMouseEnter={handleOverlayMouseEnter}
          onMouseLeave={handleOverlayMouseLeave}
          onTogglePause={handleTogglePause}
          onExcluded={handleExcluded}
        />
      </div>

      {/* 設定画面 */}
      <Settings
        key={settingsKey}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onScanComplete={handleScanComplete}
        onIntervalChange={handleIntervalChange}
        initialTab={settingsInitialTab}
      />
    </div>
  );
}

export default App;
