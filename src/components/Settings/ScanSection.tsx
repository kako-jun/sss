import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { UnlistenFn, listen } from '@tauri-apps/api/event';
import { selectDirectory, scanDirectory, getLastDirectoryPath } from '../../lib/tauri';
import type { ScanProgress } from '../../types';
import { useT, resolveScanErrorMessage } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';

interface ScanSectionProps {
  onScanComplete: () => void;
}

// #82レビューshould1: エラーは確定済みの表示文言でなく、辞書キー or バックエンドの
// 生コードのどちらかで保持する。表示文言への変換はレンダーのたびに行うため、
// エラー表示中に言語を切り替えても新旧の言語が混在したまま固まらない。
type ScanErrorState =
  | { kind: 'key'; key: MessageKey }
  | { kind: 'code'; raw: string; directory: string };

export function ScanSection({ onScanComplete }: ScanSectionProps) {
  const t = useT();
  const [selectedDirectory, setSelectedDirectory] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [realtimeProgress, setRealtimeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<ScanErrorState | null>(null);
  const errorMessage =
    error === null
      ? null
      : error.kind === 'key'
        ? t(error.key)
        : resolveScanErrorMessage(error.raw, error.directory);

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
      if (err instanceof Error) {
        setError({ kind: 'code', raw: err.message, directory: selectedDirectory });
      } else {
        setError({ kind: 'key', key: 'failedToSelectDirectory' });
      }
    }
  };

  const handleScan = async () => {
    if (!selectedDirectory) {
      setError({ kind: 'key', key: 'pleaseSelectDirectoryFirst' });
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
      // #80: Tauri コマンドの Err(String) はエラーコード（例: "directoryNotFound"）で
      // 返る。表示は`errorMessage`（レンダー時に`resolveScanErrorMessage`へかける）
      // に任せ、ここでは生のコード/文字列とselectedDirectoryだけ保持する（#82should1）。
      if (err instanceof Error) {
        setError({ kind: 'code', raw: err.message, directory: selectedDirectory });
      } else if (typeof err === 'string') {
        setError({ kind: 'code', raw: err, directory: selectedDirectory });
      } else {
        setError({ kind: 'key', key: 'failedToScanDirectory' });
      }
    } finally {
      setIsScanning(false);
      if (unlisten) {
        unlisten();
      }
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-white/70">{t('directorySelectionTitle')}</h3>
        <p className="text-xs text-white/50 mt-1">{t('directorySelectionDescription')}</p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={selectedDirectory}
          readOnly
          placeholder=""
          title={selectedDirectory}
          className="flex-1 px-3 py-2 bg-black/40 text-white/60 rounded-lg border border-white/8 focus:outline-none focus:border-white/20 text-sm truncate"
        />
        <button
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 px-4 py-2 text-white/50 hover:text-white/80 hover:bg-white/8 rounded-lg transition-colors shrink-0 text-sm"
        >
          <FolderOpen className="w-4 h-4" />
          {t('selectButtonLabel')}
        </button>
      </div>

      {/* #66視覚刷新: 主要操作（スキャン実行）はDESIGN.md「Buttons — Primary」
          （白塗り）、副次操作（フォルダ選択）は「Buttons — Ghost」にする。 */}
      <button
        onClick={handleScan}
        disabled={!selectedDirectory || isScanning}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white/90 hover:bg-white disabled:bg-white/10 disabled:text-white/30 disabled:cursor-not-allowed text-black font-medium rounded-lg transition-colors text-sm"
      >
        <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
        {isScanning ? t('scanningLabel') : t('scanLabel')}
      </button>

      {errorMessage && <div className="text-sm text-red-400/70">{errorMessage}</div>}

      {realtimeProgress && (
        <div className="text-sm text-white/50 font-mono">
          {realtimeProgress.current.toLocaleString()} / {realtimeProgress.total.toLocaleString()}
        </div>
      )}

      {scanProgress && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-white/70">{t('scanResultTitle')}</h3>
          <div className="space-y-2 p-4 bg-black/30 rounded-lg">
            <div className="text-sm text-white/50">
              {t('fileCountLabel')}{' '}
              <span className="font-mono text-white/70">
                {scanProgress.totalFiles.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-white/50">
              {t('newFilesLabel')}{' '}
              <span className="font-mono text-white/60">
                {scanProgress.newFiles.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-white/50">
              {t('deletedFilesLabel')}{' '}
              <span className="font-mono text-white/60">
                {scanProgress.deletedFiles.toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-white/50">
              {t('durationLabel')}{' '}
              <span className="font-mono">
                {t('secondsUnit', { value: (scanProgress.durationMs / 1000).toFixed(2) })}
              </span>
            </div>
          </div>

          {scanProgress.errorCount > 0 && (
            <div className="space-y-2 p-4 bg-black/30 rounded-lg">
              <div className="text-sm text-white/50">
                {t('readErrorsLabel')}{' '}
                <span className="font-mono text-red-400/80">
                  {t('errorCountValue', { count: scanProgress.errorCount.toLocaleString() })}
                </span>
                <span className="text-white/50 text-xs"> {t('keptAsUnknownNote')}</span>
              </div>
              {scanProgress.errorExamples.length > 0 && (
                <ul className="text-xs text-white/50 font-mono space-y-0.5">
                  {scanProgress.errorExamples.map((example, index) => (
                    <li key={`${index}-${example}`} className="truncate">
                      {example}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
