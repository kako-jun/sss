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
  const [progress, setProgress] = useState(0); // 0-100のプログレス値

  const intervalRef = useRef<number | undefined>(undefined);
  const progressIntervalRef = useRef<number | undefined>(undefined);
  const startTimeRef = useRef<number>(0);

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
   * 自動進行のタイマーとプログレスバー
   */
  useEffect(() => {
    if (isPlaying && !isLoading) {
      // プログレスバーをリセット
      setProgress(0);
      startTimeRef.current = Date.now();

      // プログレスバーの更新（60FPS）
      progressIntervalRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        const newProgress = Math.min((elapsed / interval) * 100, 100);
        setProgress(newProgress);
      }, 16); // 約60FPS

      // 画像切り替えタイマー
      intervalRef.current = window.setInterval(() => {
        loadNextImage();
      }, interval);

      return () => {
        if (intervalRef.current !== undefined) {
          window.clearInterval(intervalRef.current);
        }
        if (progressIntervalRef.current !== undefined) {
          window.clearInterval(progressIntervalRef.current);
        }
      };
    } else {
      // 一時停止時はプログレスをリセット
      setProgress(0);
      if (progressIntervalRef.current !== undefined) {
        window.clearInterval(progressIntervalRef.current);
      }
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
    progress,
    play,
    pause,
    togglePlayPause,
    loadNextImage,
    loadPreviousImage,
    initialize,
  };
}
