import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import type { ImageInfo } from '../types';

interface SlideshowProps {
  image: ImageInfo | null;
  isLoading?: boolean;
}

export function Slideshow({ image, isLoading }: SlideshowProps) {
  if (!image) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="text-white text-2xl">
          {isLoading ? 'Loading...' : 'No images to display'}
        </div>
      </div>
    );
  }

  console.log('Displaying:', {
    path: image.path,
    isVideo: image.isVideo,
    hasImageData: !!image.imageData,
  });

  return (
    <div className="w-screen h-screen bg-black overflow-hidden">
      <AnimatePresence mode="wait">
        {image.isVideo ? (
          // 動画の場合
          <motion.video
            key={image.path}
            src={convertFileSrc(image.path)}
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
            loop
            onError={(e) => {
              console.error('Failed to load video:', image.path);
              console.error('Error event:', e);
            }}
            onLoadedData={() => {
              console.log('Video loaded successfully:', image.path);
            }}
          />
        ) : (
          // 画像の場合
          <motion.img
            key={image.path}
            src={image.imageData}
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
            onLoad={() => {
              console.log('Image loaded successfully:', image.path);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
