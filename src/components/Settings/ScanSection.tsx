import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { UnlistenFn, listen } from '@tauri-apps/api/event';
import { selectFolder, scanFolder } from '../../lib/tauri';
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

  const handleSelectDirectory = async () => {
    try {
      const directory = await selectFolder();
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

      const progress = await scanFolder(selectedDirectory);
      setScanProgress(progress);
      setRealtimeProgress(null);
      onScanComplete();
    } catch (err) {
      console.error('Failed to scan folder:', err);
      setError(err instanceof Error ? err.message : 'Failed to scan folder');
    } finally {
      setIsScanning(false);
      if (unlisten) {
        unlisten();
      }
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-white">フォルダ選択</h3>

      <div className="flex gap-2">
        <button
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition"
        >
          <FolderOpen className="w-4 h-4" />
          フォルダ選択
        </button>

        <button
          onClick={handleScan}
          disabled={!selectedDirectory || isScanning}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded transition"
        >
          <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
          {isScanning ? 'スキャン中...' : 'フォルダをスキャン'}
        </button>
      </div>

      {selectedDirectory && (
        <div className="text-sm text-gray-400">
          選択中: {selectedDirectory}
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400">
          {error}
        </div>
      )}

      {realtimeProgress && (
        <div className="text-sm text-blue-400">
          スキャン中: {realtimeProgress.current} / {realtimeProgress.total}
        </div>
      )}

      {scanProgress && (
        <div className="space-y-2 p-4 bg-gray-800 rounded">
          <div className="text-sm text-gray-300">
            総ファイル数: {scanProgress.totalFiles}
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
      )}
    </div>
  );
}
