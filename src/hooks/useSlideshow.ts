import { useState, useEffect, useCallback, useRef } from 'react';
import { getNextImage, getPreviousImage } from '../lib/tauri';
import type { ImageInfo } from '../types';

/**
 * スライドショー管理フック
 * @param interval スライドショーの切り替え間隔（ミリ秒）
 */
export function useSlideshow(interval: number = 10000) {
  const [currentImage, setCurrentImage] = useState<ImageInfo | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<number | undefined>(undefined);

  /**
   * 次の画像を読み込む
   */
  const loadNextImage = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const image = await getNextImage();

      if (image) {
        setCurrentImage(image);
      } else {
        setError('No more images');
      }
    } catch (err) {
      console.error('Failed to load next image:', err);
      setError(err instanceof Error ? err.message : 'Failed to load image');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * 前の画像を読み込む
   */
  const loadPreviousImage = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const image = await getPreviousImage();

      if (image) {
        setCurrentImage(image);
      }
    } catch (err) {
      console.error('Failed to load previous image:', err);
      setError(err instanceof Error ? err.message : 'Failed to load image');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * スライドショーを開始
   */
  const play = useCallback(() => {
    setIsPlaying(true);
  }, []);

  /**
   * スライドショーを一時停止
   */
  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  /**
   * スライドショーを切り替え
   */
  const togglePlayPause = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  /**
   * 自動進行のタイマー
   */
  useEffect(() => {
    if (isPlaying && !isLoading) {
      intervalRef.current = window.setInterval(() => {
        loadNextImage();
      }, interval);

      return () => {
        if (intervalRef.current !== undefined) {
          window.clearInterval(intervalRef.current);
        }
      };
    }
  }, [isPlaying, isLoading, interval, loadNextImage]);

  /**
   * 初回画像読み込み
   */
  const initialize = useCallback(async (autoPlay: boolean = true) => {
    await loadNextImage();
    if (autoPlay) {
      setIsPlaying(true);
    }
  }, [loadNextImage]);

  return {
    currentImage,
    isPlaying,
    isLoading,
    error,
    play,
    pause,
    togglePlayPause,
    loadNextImage,
    loadPreviousImage,
    initialize,
  };
}
