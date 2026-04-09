import { useState, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import { Settings } from './components/Settings';
import type { TabType } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { useMouseIdle } from './hooks/useMouseIdle';
import { getPlaylistInfo, getLastDirectoryPath, scanDirectory, getSetting } from './lib/tauri';
import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';
import { X, Settings as SettingsIcon, Minimize2, Maximize2 } from 'lucide-react';
import logoBg from './assets/logo-bg.webp';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<TabType>('scan');
  const [settingsKey, setSettingsKey] = useState(0);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [displayInterval, setDisplayInterval] = useState<number>(10000); // デフォルト10秒
  const [initStatus, setInitStatus] = useState<string>(''); // 初期化状態メッセージ
  const [realtimeProgress, setRealtimeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [isOverlayHovered, setIsOverlayHovered] = useState(false); // オーバーレイにマウスオーバー中か
  const [isPausedByUser, setIsPausedByUser] = useState(false); // ユーザーが明示的に一時停止したか
  const [isFullscreen, setIsFullscreen] = useState(true); // フルスクリーン状態（起動時の設定値に合わせた初期値）
  const initRef = useRef(false); // 初期化が1回だけ実行されるようにする
  const { isIdle, setIsHovering } = useMouseIdle(3000);

  const {
    currentImage,
    isPlaying,
    isLoading,
    error,
    progress,
    play,
    pause,
    loadNextImage,
    loadPreviousImage,
    initialize,
    handleVideoEnded,
  } = useSlideshow(displayInterval); // 設定値を使用

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
      const init = async () => {
        try {
          initRef.current = true; // 初期化開始をマーク

          setInitStatus('設定を読み込んでいます...');
          // 表示間隔を読み込む
          const intervalSetting = await getSetting('display_interval');
          if (intervalSetting) {
            setDisplayInterval(parseInt(intervalSetting, 10));
          }

          setInitStatus('前回フォルダを確認しています...');
          // 前回ディレクトリがあれば差分スキャンして最新ファイル一覧を取得
          const lastDirectory = await getLastDirectoryPath();
          if (lastDirectory) {
            let unlisten: UnlistenFn | null = null;
            try {
              setInitStatus('ディレクトリをスキャンしています...');

              // リアルタイム進捗イベントをリッスン
              unlisten = await listen<{ current: number; total: number }>(
                'scan-progress',
                (event) => {
                  setRealtimeProgress(event.payload);
                },
              );

              const progress = await scanDirectory(lastDirectory);
              setRealtimeProgress(null); // スキャン完了後はリアルタイム進捗をクリア
              setInitStatus(`スキャン完了: ${progress.totalFiles.toLocaleString()}ファイル検出`);

              setInitStatus('画像を読み込んでいます...');
              await initialize(true);
              setIsInitialized(true);
              await updatePlaylistInfo();
            } catch (scanErr) {
              console.error('Failed to scan last directory:', scanErr);
              // エラーが発生しても初期化を完了させ、設定画面を開けるようにする
              setInitStatus('');
              setIsInitialized(true);
            } finally {
              // リスナーをクリーンアップ
              if (unlisten) {
                unlisten();
              }
            }
          } else {
            // 前回ディレクトリがなければ初回起動として設定画面を開けるようにする
            setInitStatus('');
            setIsInitialized(true);
          }
        } catch (err) {
          console.error('Failed to initialize:', err);
          // エラーが発生しても初期化を完了させ、設定画面を開けるようにする
          setInitStatus('');
          setIsInitialized(true);
        }
      };

      init();
    }, 0);

    // クリーンアップ関数
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画像が変わったらプレイリスト情報を更新
  useEffect(() => {
    if (currentImage) {
      updatePlaylistInfo();
    }
  }, [currentImage]);

  // オーバーレイホバーと設定画面で自動一時停止/再開
  // isPlaying を deps に含めない（play/pause が isPlaying を変更するため無限ループになる）
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  useEffect(() => {
    if (isPausedByUser) {
      // ユーザーが明示的に一時停止 → 何もしない
      if (isPlayingRef.current) {
        pause();
      }
    } else if (isOverlayHovered || isSettingsOpen) {
      // オーバーレイにマウスオーバーまたは設定画面表示 → 一時停止
      if (isPlayingRef.current) {
        pause();
      }
    } else {
      // オーバーレイから離れた かつ 設定画面が閉じている → 自動再開
      if (!isPlayingRef.current && isInitialized) {
        play();
      }
    }
  }, [isOverlayHovered, isSettingsOpen, isPausedByUser, isInitialized, pause, play]);

  const handlePrevious = async () => {
    await loadPreviousImage();
  };

  const handleNext = async () => {
    // すぐに次の画像を読み込む
    await loadNextImage();
  };

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
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
    pause();
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
    // スキャン完了後にプレイリストを初期化
    await initialize(true);
    setIsInitialized(true);
    // 設定画面は閉じない（ユーザーが結果を確認できるように）
    await updatePlaylistInfo();
  };

  const handleIntervalChange = (newInterval: number) => {
    setDisplayInterval(newInterval);
  };

  // エラー表示
  if (error && !isSettingsOpen) {
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
          title="ESCで終了"
        >
          <X size={18} />
          <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            ESCで終了
          </span>
        </button>

        <div className="w-screen h-screen flex items-center justify-center relative z-10">
          <div className="text-white/70 text-lg text-center">
            {error === 'No more images' ? (
              <>
                <div className="text-white/60 text-xl mb-2">ようこそ SSS へ</div>
                <div className="text-white/30 text-sm mb-6">
                  写真フォルダを選択してスライドショーを始めましょう
                </div>
              </>
            ) : (
              <>
                <div className="mb-4">エラーが発生しました</div>
                <div className="text-red-400/80 mb-6 text-sm">{error}</div>
              </>
            )}
            <button
              onClick={handleSettings}
              className="px-5 py-2 bg-white/8 hover:bg-white/15 border border-white/10 rounded text-white/60 hover:text-white/80 transition-colors text-sm"
            >
              {error === 'No more images' ? 'フォルダを選択' : '設定を開く'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 初期化前
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
          title="ESCで終了"
        >
          <X size={18} />
          <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            ESCで終了
          </span>
        </button>

        <div className="w-screen h-screen flex items-center justify-center relative z-10">
          <div className="text-white/50 text-center">
            <div className="text-lg mb-4">{initStatus || 'プレイリストを読み込んでいます...'}</div>

            {/* リアルタイム進捗表示 */}
            {realtimeProgress && (
              <div className="text-2xl font-mono text-white/40 mb-4">
                {realtimeProgress.current.toLocaleString()} /{' '}
                {realtimeProgress.total.toLocaleString()}
              </div>
            )}

            <div className="text-white/25 text-xs">しばらくお待ちください</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-black overflow-hidden">
      {/* スライドショー */}
      <Slideshow image={currentImage} isLoading={isLoading} onVideoEnded={handleVideoEnded} />

      {/* 終了ボタン（右上） */}
      <button
        onClick={() => exit(0)}
        className="fixed top-4 right-4 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/30 hover:text-white/60 transition-colors group"
        title="ESCで終了"
      >
        <X size={18} />
        <span className="absolute top-full right-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          ESCで終了
        </span>
      </button>

      {/* 画像がない場合のウェルカム画面 */}
      {!currentImage && !isLoading && !isSettingsOpen && (
        <div className="fixed inset-0 flex items-center justify-center z-40">
          <div className="text-center">
            <div className="text-white/60 text-xl mb-2">ようこそ SSS へ</div>
            <div className="text-white/30 text-sm mb-6">
              写真フォルダを選択してスライドショーを始めましょう
            </div>
            <button
              onClick={handleSettings}
              className="flex items-center gap-2 px-5 py-2 bg-white/8 hover:bg-white/15 border border-white/10 text-white/50 hover:text-white/80 rounded transition-colors mx-auto text-sm"
            >
              <SettingsIcon size={16} />
              フォルダを選択
            </button>
          </div>
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
          progress={progress}
          isPlaying={isPlaying}
          onPrevious={handlePrevious}
          onNext={handleNext}
          onOpenPickTab={handleOpenPickTab}
          onMouseEnter={handleOverlayMouseEnter}
          onMouseLeave={handleOverlayMouseLeave}
          onTogglePause={handleTogglePause}
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
