import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useState } from 'react';
import { ScanSection } from './ScanSection';
import { IntervalSection } from './IntervalSection';
import { SettingsSection } from './SettingsSection';
import { ShareDirectorySection } from './ShareDirectorySection';
import { GraphSection } from './GraphSection';
import { InfoSection } from './InfoSection';
import { MODAL_ANIMATION_DURATION } from '../../constants';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: () => void;
  onIntervalChange?: (interval: number) => void;
}

type TabType = 'scan' | 'options' | 'stats' | 'info';

export function Settings({ isOpen, onClose, onScanComplete, onIntervalChange }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('scan');
  const [statsKey, setStatsKey] = useState(0); // 統計グラフの強制再マウント用

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: MODAL_ANIMATION_DURATION }}
      className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-50"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: MODAL_ANIMATION_DURATION }}
        className="bg-neutral-950 rounded-xl shadow-2xl p-7 max-w-2xl w-full mx-8 max-h-[90vh] overflow-hidden border border-white/8 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-medium text-white/70">設定</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-white/8 rounded transition-colors"
          >
            <X className="w-5 h-5 text-white/30 hover:text-white/60" />
          </button>
        </div>

        {/* タブナビゲーション */}
        <div className="flex gap-1 mb-6 border-b border-white/8">
          <button
            onClick={() => setActiveTab('scan')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'scan'
                ? 'text-white/80 border-b border-white/50'
                : 'text-white/30 hover:text-white/50'
            }`}
          >
            入力
          </button>
          <button
            onClick={() => setActiveTab('options')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'options'
                ? 'text-white/80 border-b border-white/50'
                : 'text-white/30 hover:text-white/50'
            }`}
          >
            オプション
          </button>
          <button
            onClick={() => {
              setActiveTab('stats');
              setStatsKey(prev => prev + 1); // タブを開くたびにkeyを変更して再マウント
            }}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'stats'
                ? 'text-white/80 border-b border-white/50'
                : 'text-white/30 hover:text-white/50'
            }`}
          >
            統計グラフ
          </button>
          <button
            onClick={() => setActiveTab('info')}
            className={`px-4 py-2 text-sm transition-colors ${
              activeTab === 'info'
                ? 'text-white/80 border-b border-white/50'
                : 'text-white/30 hover:text-white/50'
            }`}
          >
            情報
          </button>
        </div>

        {/* タブコンテンツ */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'scan' && (
            <ScanSection onScanComplete={onScanComplete} />
          )}
          {activeTab === 'options' && (
            <div className="space-y-8">
              <IntervalSection onIntervalChange={onIntervalChange} />
              <SettingsSection />
              <ShareDirectorySection />
            </div>
          )}
          {activeTab === 'stats' && (
            <div className="space-y-8">
              <GraphSection key={statsKey} />
            </div>
          )}
          {activeTab === 'info' && (
            <div className="space-y-8">
              <InfoSection />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
