import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { ScanSection } from './ScanSection';
import { StatsSection } from './StatsSection';
import { IntervalSection } from './IntervalSection';
import { SettingsSection } from './SettingsSection';
import { GraphSection } from './GraphSection';
import { MODAL_ANIMATION_DURATION } from '../../constants';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: () => void;
  onIntervalChange?: (interval: number) => void;
}

export function Settings({ isOpen, onClose, onScanComplete, onIntervalChange }: SettingsProps) {
  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: MODAL_ANIMATION_DURATION }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: MODAL_ANIMATION_DURATION }}
        className="bg-gray-900 rounded-2xl shadow-2xl p-8 max-w-2xl w-full mx-8 max-h-[90vh] overflow-y-auto border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">設定</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-6 h-6 text-gray-400" />
          </button>
        </div>

        <div className="space-y-8">
          <ScanSection onScanComplete={onScanComplete} />
          <StatsSection isOpen={isOpen} />
          <IntervalSection onIntervalChange={onIntervalChange} />
          <SettingsSection />
          <GraphSection />
        </div>
      </motion.div>
    </motion.div>
  );
}
