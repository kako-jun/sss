import { useState, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import { Settings } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { getPlaylistInfo, getLastDirectoryPath, scanDirectory, getSetting } from './lib/tauri';
import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';
import { X, Settings as SettingsIcon } from 'lucide-react';
import logoBg from './assets/logo-bg.webp';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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
  const initRef = useRef(false); // 初期化が1回だけ実行されるようにする

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
  useEffect(() => {
    if (isOverlayHovered || isSettingsOpen) {
      // オーバーレイにマウスオーバーまたは設定画面表示 → 一時停止
      if (isPlaying) {
        pause();
      }
    } else {
      // オーバーレイから離れた かつ 設定画面が閉じている → 自動再開
      if (!isPlaying && isInitialized) {
        play();
      }
    }
  }, [isOverlayHovered, isSettingsOpen, isPlaying, isInitialized, pause, play]);

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
  }, [canGoBack, isSettingsOpen]);

  const handleSettings = () => {
    pause();
    setIsSettingsOpen(true);
  };

  const handleOverlayMouseEnter = () => {
    setIsOverlayHovered(true);
  };

  const handleOverlayMouseLeave = () => {
    setIsOverlayHovered(false);
  };

  const handleTogglePause = () => {
    // タッチデバイス対応：タップで一時停止/再生をトグル
    setIsOverlayHovered(!isOverlayHovered);
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
          <img src={logoBg} alt="SSS Logo" className="w-1/3 h-auto opacity-3" />
        </div>

        {/* 終了ボタン（左上） */}
        <button
          onClick={() => exit(0)}
          className="fixed top-4 left-4 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/30 hover:text-white/60 transition-colors group"
          title="ESCで終了"
        >
          <X size={18} />
          <span className="absolute top-full left-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            ESCで終了
          </span>
        </button>

        <div className="w-screen h-screen flex items-center justify-center relative z-10">
          <div className="text-white/70 text-lg text-center">
            <div className="mb-4">エラーが発生しました</div>
            <div className="text-red-400/80 mb-6 text-sm">{error}</div>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="px-5 py-2 bg-white/8 hover:bg-white/15 border border-white/10 rounded text-white/60 hover:text-white/80 transition-colors text-sm"
            >
              設定を開く
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
          <img src={logoBg} alt="SSS Logo" className="w-1/3 h-auto opacity-3" />
        </div>

        {/* 終了ボタン（左上） */}
        <button
          onClick={() => exit(0)}
          className="fixed top-4 left-4 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/30 hover:text-white/60 transition-colors group"
          title="ESCで終了"
        >
          <X size={18} />
          <span className="absolute top-full left-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
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
      <Slideshow image={currentImage} isLoading={isLoading} />

      {/* 終了ボタン（左上） */}
      <button
        onClick={() => exit(0)}
        className="fixed top-4 left-4 z-50 p-2 bg-black/40 hover:bg-black/70 backdrop-blur-sm rounded border border-white/8 text-white/30 hover:text-white/60 transition-colors group"
        title="ESCで終了"
      >
        <X size={18} />
        <span className="absolute top-full left-0 mt-1 px-2 py-1 bg-black/90 text-white/60 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          ESCで終了
        </span>
      </button>

      {/* 画像がない場合の案内 */}
      {!currentImage && !isLoading && !isSettingsOpen && (
        <div className="fixed inset-0 flex items-center justify-center z-40">
          <div className="text-center">
            <div className="text-white/50 text-lg mb-5">画像が読み込まれていません</div>
            <button
              onClick={handleSettings}
              className="flex items-center gap-2 px-5 py-2 bg-white/8 hover:bg-white/15 border border-white/10 text-white/50 hover:text-white/80 rounded transition-colors mx-auto text-sm"
            >
              <SettingsIcon size={16} />
              設定を開く
            </button>
          </div>
        </div>
      )}

      {/* オーバーレイUI（常時表示） */}
      <OverlayUI
        image={currentImage}
        canGoBack={canGoBack}
        currentPosition={currentPosition}
        totalImages={totalImages}
        progress={progress}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onSettings={handleSettings}
        onMouseEnter={handleOverlayMouseEnter}
        onMouseLeave={handleOverlayMouseLeave}
        onTogglePause={handleTogglePause}
      />

      {/* 設定画面 */}
      <Settings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onScanComplete={handleScanComplete}
        onIntervalChange={handleIntervalChange}
      />
    </div>
  );
}

export default App;
