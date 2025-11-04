import { motion } from 'framer-motion';
import { X, FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { selectFolder, scanFolder, getStats } from '../lib/tauri';
import type { ScanProgress, Stats } from '../types';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: () => void;
}

export function Settings({ isOpen, onClose, onScanComplete }: SettingsProps) {
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelectFolder = async () => {
    try {
      const folder = await selectFolder();
      if (folder) {
        setSelectedFolder(folder);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
      setError(err instanceof Error ? err.message : 'Failed to select folder');
    }
  };

  const handleScan = async () => {
    if (!selectedFolder) {
      setError('Please select a folder first');
      return;
    }

    try {
      setIsScanning(true);
      setError(null);
      setScanProgress(null);

      const progress = await scanFolder(selectedFolder);
      setScanProgress(progress);

      // 統計情報を更新
      const updatedStats = await getStats();
      setStats(updatedStats);

      // スキャン完了を通知
      onScanComplete();
    } catch (err) {
      console.error('Failed to scan folder:', err);
      setError(err instanceof Error ? err.message : 'Failed to scan folder');
    } finally {
      setIsScanning(false);
    }
  };

  const loadStats = async () => {
    try {
      const updatedStats = await getStats();
      setStats(updatedStats);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  // 設定画面が開かれたら統計情報をロード
  useState(() => {
    if (isOpen) {
      loadStats();
    }
  });

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center"
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="bg-gray-900 rounded-2xl shadow-2xl p-8 max-w-2xl w-full mx-8 border border-gray-700"
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">設定</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="text-gray-400" size={24} />
          </button>
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="mb-4 p-4 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200">
            {error}
          </div>
        )}

        {/* フォルダ選択 */}
        <div className="mb-6">
          <label className="block text-gray-300 font-medium mb-2">
            画像フォルダ
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={selectedFolder}
              readOnly
              placeholder="フォルダを選択してください"
              className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSelectFolder}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors text-white font-medium"
            >
              <FolderOpen size={18} />
              選択
            </button>
          </div>
        </div>

        {/* スキャンボタン */}
        <div className="mb-6">
          <button
            onClick={handleScan}
            disabled={!selectedFolder || isScanning}
            className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg transition-colors font-medium ${
              selectedFolder && !isScanning
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            <RefreshCw size={18} className={isScanning ? 'animate-spin' : ''} />
            {isScanning ? 'スキャン中...' : 'フォルダをスキャン'}
          </button>
        </div>

        {/* スキャン結果 */}
        {scanProgress && (
          <div className="mb-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
            <h3 className="text-white font-semibold mb-3">スキャン結果</h3>
            <div className="space-y-2 text-gray-300">
              <div className="flex justify-between">
                <span>総ファイル数:</span>
                <span className="font-mono">{scanProgress.totalFiles.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>新規ファイル:</span>
                <span className="font-mono text-green-400">
                  {scanProgress.newFiles.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span>削除ファイル:</span>
                <span className="font-mono text-red-400">
                  {scanProgress.deletedFiles.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span>処理時間:</span>
                <span className="font-mono">
                  {(scanProgress.durationMs / 1000).toFixed(2)}秒
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 統計情報 */}
        {stats && (
          <div className="p-4 bg-gray-800 rounded-lg border border-gray-700">
            <h3 className="text-white font-semibold mb-3">統計</h3>
            <div className="space-y-2 text-gray-300">
              <div className="flex justify-between">
                <span>総画像数:</span>
                <span className="font-mono">{stats.totalImages.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>表示済み:</span>
                <span className="font-mono">{stats.displayedImages.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
