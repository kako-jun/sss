import { motion, AnimatePresence } from 'framer-motion';
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

  // base64エンコードされた画像データを直接使用
  console.log('Displaying image:', {
    originalPath: image.path,
    optimizedPath: image.optimizedPath,
    hasImageData: !!image.imageData,
    imageDataLength: image.imageData?.length || 0
  });

  return (
    <div className="w-screen h-screen bg-black overflow-hidden">
      <AnimatePresence mode="wait">
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
      </AnimatePresence>
    </div>
  );
}
