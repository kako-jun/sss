import { motion, AnimatePresence } from 'framer-motion';
import { getImageUrl } from '../lib/tauri';
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

  const imageUrl = getImageUrl(image.path);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.img
          key={image.path}
          src={imageUrl}
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
        />
      </AnimatePresence>
    </div>
  );
}
