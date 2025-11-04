import { useState, useEffect, useRef } from 'react';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import { Settings } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { useMouseIdle } from './hooks/useMouseIdle';
import { initPlaylist, getPlaylistInfo, getLastFolderPath, scanFolder, getSetting } from './lib/tauri';
import { invoke } from '@tauri-apps/api/tauri';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [displayInterval, setDisplayInterval] = useState<number>(10000); // デフォルト10秒
  const initRef = useRef(false); // 初期化が1回だけ実行されるようにする

  const {
    currentImage,
    isPlaying,
    isLoading,
    error,
    play,
    pause,
    loadNextImage,
    loadPreviousImage,
    initialize,
  } = useSlideshow(displayInterval); // 設定値を使用

  const { isIdle, forceIdle } = useMouseIdle(3000); // 3秒でアイドル判定

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

    const init = async () => {
      try {
        initRef.current = true; // 初期化開始をマーク

        // 表示間隔を読み込む
        const intervalSetting = await getSetting('display_interval');
        if (intervalSetting) {
          setDisplayInterval(parseInt(intervalSetting, 10));
        }

        // 保存されたプレイリストを復元
        const savedImagePath = await initPlaylist();

        if (savedImagePath) {
          // 既存のプレイリストがあれば初期化
          await initialize(true);
          setIsInitialized(true);
          await updatePlaylistInfo();
        } else {
          // プレイリストがない場合、最後のフォルダがあれば自動スキャン
          const lastFolder = await getLastFolderPath();
          if (lastFolder) {
            try {
              await scanFolder(lastFolder);
              await initialize(true);
              setIsInitialized(true);
              await updatePlaylistInfo();
            } catch (scanErr) {
              console.error('Failed to scan last folder:', scanErr);
              setIsSettingsOpen(true);
            }
          } else {
            // 最後のフォルダもなければ設定画面を開く
            setIsSettingsOpen(true);
          }
        }
      } catch (err) {
        console.error('Failed to initialize:', err);
        setIsSettingsOpen(true);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画像が変わったらプレイリスト情報を更新
  useEffect(() => {
    if (currentImage) {
      updatePlaylistInfo();
    }
  }, [currentImage]);

  // マウス操作で自動一時停止/再開
  useEffect(() => {
    if (!isIdle) {
      // マウスが動いた（オーバーレイ表示）→ 一時停止
      if (isPlaying) {
        console.log('Mouse active, pausing slideshow');
        pause();
      }
    } else {
      // マウスがアイドル（オーバーレイ非表示）→ 自動再開
      if (!isPlaying && isInitialized) {
        console.log('Mouse idle, resuming slideshow');
        play();
      }
    }
  }, [isIdle, isPlaying, isInitialized, pause, play]);

  const handlePrevious = async () => {
    await loadPreviousImage();
  };

  const handleNext = async () => {
    console.log('handleNext called');
    // すぐに次の画像を読み込む
    await loadNextImage();
    // オーバーレイを非表示
    forceIdle();
  };

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // ESCキーでアプリ終了
      if (e.key === 'Escape') {
        console.log('ESC key pressed, exiting app...');
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
        console.log('Left arrow key pressed, going to previous image');
        e.preventDefault();
        await handlePrevious();
      }

      // 右矢印キーで次の画像へ
      if (e.key === 'ArrowRight' && !isSettingsOpen) {
        console.log('Right arrow key pressed, going to next image');
        e.preventDefault();
        handleNext();
      }
    };

    // captureフェーズで最優先でキャッチ
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [canGoBack, isSettingsOpen, isPlaying, play]);

  const handleSettings = () => {
    pause();
    setIsSettingsOpen(true);
  };

  const handleHideOverlay = () => {
    forceIdle();
  };

  const handleScanComplete = async () => {
    // スキャン完了後にプレイリストを初期化
    await initialize(true);
    setIsInitialized(true);
    setIsSettingsOpen(false);
    await updatePlaylistInfo();
  };

  const handleIntervalChange = (newInterval: number) => {
    setDisplayInterval(newInterval);
  };

  // エラー表示
  if (error && !isSettingsOpen) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="text-white text-xl">
          <div className="mb-4">エラーが発生しました</div>
          <div className="text-red-400 mb-4">{error}</div>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
          >
            設定を開く
          </button>
        </div>
      </div>
    );
  }

  // 初期化前
  if (!isInitialized && !isSettingsOpen) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="text-white text-center">
          <div className="text-2xl mb-4">プレイリストを読み込んでいます...</div>
          <div className="text-gray-400 text-sm">
            しばらくお待ちください
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-black overflow-hidden">
      {/* スライドショー */}
      <Slideshow image={currentImage} isLoading={isLoading} />

      {/* オーバーレイUI */}
      <OverlayUI
        image={currentImage}
        isVisible={!isIdle}
        canGoBack={canGoBack}
        currentPosition={currentPosition}
        totalImages={totalImages}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onSettings={handleSettings}
        onHide={handleHideOverlay}
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
