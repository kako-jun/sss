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
  const [realtimeProgress, setRealtimeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
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
      <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">
        ディレクトリ選択
      </h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={selectedDirectory}
          readOnly
          placeholder=""
          className="flex-1 px-3 py-2 bg-black/40 text-white/60 rounded border border-white/8 focus:outline-none focus:border-white/20 text-sm"
        />
        <button
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 px-4 py-2 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded border border-white/8 transition shrink-0 text-sm"
        >
          <FolderOpen className="w-4 h-4" />
          選択
        </button>
      </div>

      <button
        onClick={handleScan}
        disabled={!selectedDirectory || isScanning}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-white/8 hover:bg-white/15 disabled:bg-black/20 disabled:text-white/20 text-white/60 hover:text-white/80 rounded border border-white/8 disabled:border-white/5 transition text-sm"
      >
        <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
        {isScanning ? 'スキャン中...' : 'スキャン'}
      </button>

      {error && <div className="text-sm text-red-400/70">{error}</div>}

      {realtimeProgress && (
        <div className="text-sm text-white/30 font-mono">
          {realtimeProgress.current.toLocaleString()} / {realtimeProgress.total.toLocaleString()}
        </div>
      )}

      {scanProgress && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">
            スキャン結果
          </h3>
          <div className="space-y-2 p-4 bg-black/30 rounded border border-white/5">
            <div className="text-sm text-white/50">
              ファイル数:{' '}
              <span className="font-mono text-white/70">
                {scanProgress.totalFiles.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-white/40">
              新規:{' '}
              <span className="font-mono text-white/60">
                {scanProgress.newFiles.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-white/40">
              削除:{' '}
              <span className="font-mono text-white/60">
                {scanProgress.deletedFiles.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-white/30">
              処理時間:{' '}
              <span className="font-mono">{(scanProgress.durationMs / 1000).toFixed(2)}秒</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
