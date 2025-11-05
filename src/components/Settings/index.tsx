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
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: MODAL_ANIMATION_DURATION }}
        className="bg-gray-900 rounded-2xl shadow-2xl p-8 max-w-2xl w-full mx-8 max-h-[90vh] overflow-hidden border border-gray-700 flex flex-col"
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

        {/* タブナビゲーション */}
        <div className="flex gap-2 mb-6 border-b border-gray-700">
          <button
            onClick={() => setActiveTab('scan')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'scan'
                ? 'text-white border-b-2 border-white'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            入力
          </button>
          <button
            onClick={() => setActiveTab('options')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'options'
                ? 'text-white border-b-2 border-white'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            オプション
          </button>
          <button
            onClick={() => {
              setActiveTab('stats');
              setStatsKey(prev => prev + 1); // タブを開くたびにkeyを変更して再マウント
            }}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'stats'
                ? 'text-white border-b-2 border-white'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            統計グラフ
          </button>
          <button
            onClick={() => setActiveTab('info')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'info'
                ? 'text-white border-b-2 border-white'
                : 'text-gray-400 hover:text-gray-300'
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
