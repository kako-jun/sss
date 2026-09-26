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
          />
        ) : (
          // 画像の場合
          <motion.img
            key={image.path}
            src={srcUrl}
            alt={image.path}
            // #60 レビュー方針転換: 回転はバックエンドで焼き込まず、フロントの
            // image-orientation CSS で行う（apply_exif_rotation設定に連動して
            // from-image/noneを切替）。ただし asset プロトコルはWebViewから見て
            // 別オリジンであり、crossOrigin無しのクロスオリジン画像は
            // image-orientation自体が無視される（Edgeで実測確認済み）。
            // tauri 2.10.3 の asset protocol ハンドラ（src/protocol/asset.rs）は
            // Access-Control-Allow-Origin にwindow_originをそのまま返す
            // （ワイルドカードではなく実オリジンを反映）ため、crossOrigin="anonymous"
            // （認証情報なしのCORSリクエスト）でCORSチェックを通過できる。
            crossOrigin="anonymous"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="w-full h-full object-contain"
            style={{
              willChange: 'opacity',
              // apply_exif_rotation設定に連動: ONならWebView既定の
              // from-image（EXIF Orientationに従って自動回転）に任せ、
              // OFFならnoneで原本の生ピクセルのまま表示する。
              // なお4K超/TIFF等で結局バックエンドがキャッシュを焼く場合は
              // そのキャッシュがapply_rotationに従って既に回転済み・EXIF無しで
              // 書き出されるため、from-imageを当てても二重回転はしない。
              imageOrientation: image.applyRotation ? 'from-image' : 'none',
            }}
            draggable={false}
            onError={(e) => {
              console.error('Failed to load image:', image.path);
              console.error('Error event:', e);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
