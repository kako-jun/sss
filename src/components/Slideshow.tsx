import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { ImageInfo } from '../types';
import logoBg from '../assets/logo-bg.webp';

interface SlideshowProps {
  image: ImageInfo | null;
  isLoading?: boolean;
  onVideoEnded?: () => void;
}

export function Slideshow({ image, isLoading, onVideoEnded }: SlideshowProps) {
  if (!image) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="text-white text-2xl">
          {isLoading ? 'Loading...' : 'No images to display'}
        </div>
      </div>
    );
  }

  // 表示するファイルのパス（最適化版があればそれを使用）
  const displayPath = image.optimizedPath || image.path;
  const srcUrl = convertFileSrc(displayPath);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* 背景ロゴ */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <img src={logoBg} alt="SSS Logo" className="w-1/3 h-auto opacity-2" />
      </div>

      <AnimatePresence mode="wait">
        {image.isVideo ? (
          // 動画の場合
          <motion.video
            key={image.path}
            src={srcUrl}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="w-full h-full object-contain"
            style={{
              willChange: 'opacity',
            }}
            autoPlay
            muted
            onEnded={onVideoEnded}
            onError={(e) => {
              console.error('Failed to load video:', image.path);
              console.error('Error event:', e);
              // 動画の読み込みに失敗した場合も次に進む
              onVideoEnded?.();
            }}
            onLoadedData={() => {}}
          />
        ) : (
          // 画像の場合
          <motion.img
            key={image.path}
            src={srcUrl}
            alt={image.path}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="w-full h-full object-contain"
            style={{
              willChange: 'opacity',
            }}
            draggable={false}
            onError={(e) => {
              console.error('Failed to load image:', image.path);
              console.error('Error event:', e);
            }}
            onLoad={() => {}}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
