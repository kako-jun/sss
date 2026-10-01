import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { UnlistenFn, listen } from '@tauri-apps/api/event';
import { selectAndScan, rescanLastDirectory, getLastDirectoryPath } from '../../lib/tauri';
import type { ScanProgress } from '../../types';
import { useT, resolveScanErrorMessage } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import type { ExcludeRescanController } from './useExcludeRescan';

interface ScanSectionProps {
  onScanComplete: () => void;
  /**
   * #111: スキャン全般の単一ガードと、除外ルール変更の反映待ち管理（`useExcludeRescan`）。
   * 除外ルールタブの再スキャンと並走させず、成功したら開始時点までの反映待ちを外す。
   */
  guard?: Pick<ExcludeRescanController, 'begin' | 'end' | 'clearUpTo'>;
}

// #82レビューshould1: エラーは確定済みの表示文言でなく、辞書キー or バックエンドの
// 生コードのどちらかで保持する。表示文言への変換はレンダーのたびに行うため、
// エラー表示中に言語を切り替えても新旧の言語が混在したまま固まらない。
type ScanErrorState =
  | { kind: 'key'; key: MessageKey }
  | { kind: 'code'; raw: string; directory: string };

export function ScanSection({ onScanComplete, guard }: ScanSectionProps) {
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
        // #115: 前回のフォルダが空欄のまま黙らないよう、失敗を表示する。
        setError({ kind: 'key', key: 'errorLastDirectoryLoadFailed' });
      }
    };
    loadLastDirectory();
  }, []);

  // 選択+スキャン（#93）も再スキャンも、スキャンの進捗購読・結果表示・エラー処理は共通。
  // どちらもパス文字列は渡さない（選択はRust側のダイアログ、再スキャンはDB保存済みの前回フォルダ）。
  const runScan = async (run: () => Promise<ScanProgress | null>) => {
    let unlisten: UnlistenFn | null = null;

    const token = guard ? guard.begin() : 0;
    if (token === null) {
      // 除外ルールタブの再スキャンが実行中。並走させない。
      setError({ kind: 'code', raw: 'scanInProgress', directory: selectedDirectory });
      return;
    }

    try {
      setIsScanning(true);
      setError(null);
      setRealtimeProgress(null);

      unlisten = await listen<{ current: number; total: number }>('scan-progress', (event) => {
        setRealtimeProgress(event.payload);
      });

      const progress = await run();
      setRealtimeProgress(null);
      // ダイアログをキャンセルした場合は null（エラーではない。何も変えない）
      if (progress === null) return;
      setScanProgress(progress);
      // 選択で前回フォルダが変わりうるので、表示を保存値に合わせ直す
      try {
        const lastDirectory = await getLastDirectoryPath();
        if (lastDirectory) setSelectedDirectory(lastDirectory);
      } catch (err) {
        console.error('Failed to load last directory path:', err);
        setError({ kind: 'key', key: 'errorLastDirectoryLoadFailed' });
      }
      // スキャン完了を通知するが、設定画面は閉じない
      guard?.clearUpTo(token);
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
      guard?.end();
      setIsScanning(false);
      if (unlisten) {
        unlisten();
      }
    }
  };

  const handleSelectDirectory = async () => {
    // 「スキャン」ボタンと対称に、前回の結果表示は新しい選択の開始時に消す
    // （キャンセルされたら空表示になるが、前回結果を残したまま別フォルダの結果と誤読させない）。
    setScanProgress(null);
    await runScan(selectAndScan);
  };

  const handleScan = async () => {
    if (!selectedDirectory) {
      setError({ kind: 'key', key: 'pleaseSelectDirectoryFirst' });
      return;
    }
    setScanProgress(null);
    await runScan(rescanLastDirectory);
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
          disabled={isScanning}
          className="flex items-center gap-2 px-4 py-2 text-white/50 hover:text-white/80 hover:bg-white/8 rounded-lg transition-colors shrink-0 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
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

      {errorMessage && (
        <div role="alert" className="select-text text-sm text-red-400/70">
          {errorMessage}
        </div>
      )}

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
                <ul className="select-text text-xs text-white/50 font-mono space-y-0.5">
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
