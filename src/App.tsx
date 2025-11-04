import { useState, useEffect } from 'react';
import { Slideshow } from './components/Slideshow';
import { OverlayUI } from './components/OverlayUI';
import { Settings } from './components/Settings';
import { useSlideshow } from './hooks/useSlideshow';
import { useMouseIdle } from './hooks/useMouseIdle';
import { initPlaylist, getPlaylistInfo } from './lib/tauri';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

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
  } = useSlideshow(10000); // 10秒間隔

  const { isIdle } = useMouseIdle(3000); // 3秒でアイドル判定

  // プレイリスト情報を更新
  const updatePlaylistInfo = async () => {
    try {
      const info = await getPlaylistInfo();
      if (info) {
        const [position, total] = info;
        setCurrentPosition(position);
        setTotalImages(total);
      }
    } catch (err) {
      console.error('Failed to get playlist info:', err);
    }
  };

  // 初期化
  useEffect(() => {
    const init = async () => {
      try {
        // 保存されたプレイリストを復元
        const savedImage = await initPlaylist();

        if (savedImage) {
          // 既存のプレイリストがあれば初期化
          await initialize(true);
          setIsInitialized(true);
          await updatePlaylistInfo();
        } else {
          // プレイリストがなければ設定画面を開く
          setIsSettingsOpen(true);
        }
      } catch (err) {
        console.error('Failed to initialize:', err);
        setIsSettingsOpen(true);
      }
    };

    init();
  }, []);

  // 画像が変わったらプレイリスト情報を更新
  useEffect(() => {
    if (currentImage) {
      updatePlaylistInfo();
    }
  }, [currentImage]);

  // マウス操作で自動一時停止
  useEffect(() => {
    if (!isIdle && isPlaying) {
      pause();
    }
  }, [isIdle, isPlaying, pause]);

  // ESCキーでアプリ終了
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.__TAURI__.process.exit(0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePlay = () => {
    play();
  };

  const handlePrevious = async () => {
    await loadPreviousImage();
  };

  const handleSettings = () => {
    pause();
    setIsSettingsOpen(true);
  };

  const handleScanComplete = async () => {
    // スキャン完了後にプレイリストを初期化
    await initialize(true);
    setIsInitialized(true);
    setIsSettingsOpen(false);
    await updatePlaylistInfo();
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
        isPlaying={isPlaying}
        canGoBack={canGoBack}
        currentPosition={currentPosition}
        totalImages={totalImages}
        onPlay={handlePlay}
        onPrevious={handlePrevious}
        onSettings={handleSettings}
      />

      {/* 設定画面 */}
      <Settings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onScanComplete={handleScanComplete}
      />
    </div>
  );
}

export default App;
