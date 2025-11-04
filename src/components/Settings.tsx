import { motion } from 'framer-motion';
import { X, FolderOpen, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { selectFolder, scanFolder, getStats, getLastFolderPath, getSetting, saveSetting } from '../lib/tauri';
import type { ScanProgress, Stats } from '../types';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: () => void;
  onIntervalChange?: (interval: number) => void;
}

export function Settings({ isOpen, onClose, onScanComplete, onIntervalChange }: SettingsProps) {
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [realtimeProgress, setRealtimeProgress] = useState<{ current: number; total: number } | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayInterval, setDisplayInterval] = useState<number>(10000); // ミリ秒単位

  const handleSelectFolder = async () => {
    console.log('handleSelectFolder called');
    try {
      console.log('Calling selectFolder...');
      const folder = await selectFolder();
      console.log('Selected folder:', folder);
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

    let unlisten: UnlistenFn | null = null;

    try {
      setIsScanning(true);
      setError(null);
      setScanProgress(null);
      setRealtimeProgress(null);

      // リアルタイム進捗イベントをリッスン
      unlisten = await listen<{ current: number; total: number }>('scan-progress', (event) => {
        console.log('Received scan progress:', event.payload);
        setRealtimeProgress(event.payload);
      });

      const progress = await scanFolder(selectedFolder);
      setScanProgress(progress);
      setRealtimeProgress(null); // スキャン完了後はリアルタイム進捗をクリア

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
      // リスナーをクリーンアップ
      if (unlisten) {
        unlisten();
      }
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

  // 表示間隔を保存
  const handleIntervalChange = async (value: number) => {
    setDisplayInterval(value);
    try {
      await saveSetting('display_interval', value.toString());
      // 親コンポーネントに通知
      if (onIntervalChange) {
        onIntervalChange(value);
      }
    } catch (err) {
      console.error('Failed to save display interval:', err);
    }
  };

  // 設定画面が開かれたら統計情報と最後のフォルダ、表示間隔をロード
  useEffect(() => {
    if (isOpen) {
      console.log('Settings opened, loading data...');
      loadStats();

      // 最後に選択したフォルダを読み込む
      console.log('Calling getLastFolderPath...');
      getLastFolderPath().then((path) => {
        console.log('Last folder path:', path);
        if (path) {
          setSelectedFolder(path);
        }
      }).catch((err) => {
        console.error('Failed to load last folder:', err);
      });

      // 表示間隔を読み込む
      getSetting('display_interval').then((value) => {
        if (value) {
          setDisplayInterval(parseInt(value, 10));
        }
      }).catch((err) => {
        console.error('Failed to load display interval:', err);
      });
    }
  }, [isOpen]);

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

          {/* スキャン中のメッセージ */}
          {isScanning && (
            <div className="mt-4 p-4 bg-blue-900/30 border border-blue-500/50 rounded-lg">
              <div className="text-blue-200 space-y-2">
                <div className="font-semibold flex items-center gap-2">
                  <RefreshCw size={16} className="animate-spin" />
                  ファイルをスキャンしています...
                </div>

                {/* リアルタイム進捗表示 */}
                {realtimeProgress && (
                  <div className="text-lg font-mono text-blue-100 bg-blue-800/40 px-4 py-2 rounded-lg">
                    {realtimeProgress.current.toLocaleString()} / {realtimeProgress.total.toLocaleString()} ファイル処理中
                  </div>
                )}

                <div className="text-sm text-blue-300/80">
                  • 初回スキャンは時間がかかりますが、次回以降は差分のみスキャンするため高速です
                </div>
                <div className="text-sm text-blue-300/80 mt-3">
                  画面はそのままお待ちください。完了すると結果が表示されます。
                </div>
              </div>
            </div>
          )}
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
          <div className="mb-6 p-4 bg-gray-800 rounded-lg border border-gray-700">
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

        {/* 表示間隔設定 */}
        <div className="p-4 bg-gray-800 rounded-lg border border-gray-700">
          <label className="block text-white font-semibold mb-3">
            表示間隔
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="5"
              max="60"
              value={displayInterval / 1000}
              onChange={(e) => handleIntervalChange(parseInt(e.target.value) * 1000)}
              className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="5"
                max="60"
                value={displayInterval / 1000}
                onChange={(e) => {
                  const value = Math.max(5, Math.min(60, parseInt(e.target.value) || 5));
                  handleIntervalChange(value * 1000);
                }}
                className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:outline-none focus:border-blue-500"
              />
              <span className="text-gray-400 text-sm">秒</span>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
