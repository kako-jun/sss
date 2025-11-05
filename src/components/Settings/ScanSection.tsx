import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { UnlistenFn, listen } from '@tauri-apps/api/event';
import { selectDirectory, scanDirectory, getLastDirectoryPath } from '../../lib/tauri';
import type { ScanProgress } from '../../types';

interface ScanSectionProps {
  onScanComplete: () => void;
}

export function ScanSection({ onScanComplete }: ScanSectionProps) {
  const [selectedDirectory, setSelectedDirectory] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [realtimeProgress, setRealtimeProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 前回のディレクトリパスを読み込む
  useEffect(() => {
    const loadLastDirectory = async () => {
      try {
        const lastDirectory = await getLastDirectoryPath();
        if (lastDirectory) {
          setSelectedDirectory(lastDirectory);
        }
      } catch (err) {
        console.error('Failed to load last directory path:', err);
      }
    };
    loadLastDirectory();
  }, []);

  const handleSelectDirectory = async () => {
    try {
      const directory = await selectDirectory();
      if (directory) {
        setSelectedDirectory(directory);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
      setError(err instanceof Error ? err.message : 'Failed to select directory');
    }
  };

  const handleScan = async () => {
    if (!selectedDirectory) {
      setError('Please select a directory first');
      return;
    }

    let unlisten: UnlistenFn | null = null;

    try {
      setIsScanning(true);
      setError(null);
      setScanProgress(null);
      setRealtimeProgress(null);

      unlisten = await listen<{ current: number; total: number }>('scan-progress', (event) => {
        setRealtimeProgress(event.payload);
      });

      const progress = await scanDirectory(selectedDirectory);
      setScanProgress(progress);
      setRealtimeProgress(null);
      // スキャン完了を通知するが、設定画面は閉じない
      onScanComplete();
    } catch (err) {
      console.error('Failed to scan directory:', err);
      setError(err instanceof Error ? err.message : 'Failed to scan directory');
    } finally {
      setIsScanning(false);
      if (unlisten) {
        unlisten();
      }
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-white">ディレクトリ選択</h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={selectedDirectory}
          readOnly
          placeholder=""
          className="flex-1 px-3 py-2 bg-gray-800 text-gray-300 rounded border border-gray-700 focus:outline-none focus:border-gray-500"
        />
        <button
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition shrink-0"
        >
          <FolderOpen className="w-4 h-4" />
          選択
        </button>
      </div>

      <button
        onClick={handleScan}
        disabled={!selectedDirectory || isScanning}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white rounded transition"
      >
        <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
        {isScanning ? 'スキャン中...' : 'スキャン'}
      </button>

      {error && (
        <div className="text-sm text-red-400">
          {error}
        </div>
      )}

      {realtimeProgress && (
        <div className="text-sm text-gray-400">
          スキャン中: {realtimeProgress.current} / {realtimeProgress.total}
        </div>
      )}

      {scanProgress && (
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-white">スキャン結果</h3>
          <div className="space-y-2 p-4 bg-gray-800 rounded">
            <div className="text-sm text-gray-300">
              ファイル数: {scanProgress.totalFiles}
            </div>
            <div className="text-sm text-green-400">
              新規: {scanProgress.newFiles}
            </div>
            <div className="text-sm text-red-400">
              削除: {scanProgress.deletedFiles}
            </div>
            <div className="text-sm text-gray-400">
              処理時間: {(scanProgress.durationMs / 1000).toFixed(2)}秒
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
