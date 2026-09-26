import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * アプリ起動時の初期化シーケンス（#62レビューS1）。
 *
 * 前回ディレクトリの保存済みプレイリスト状態が復元できれば、スキャン完了を
 * 待たずに即座に画像を表示し、スキャンはバックグラウンドで実行して差分だけ
 * 反映する（10万枚規模だとスキャンに数秒〜数十秒かかりうるため、その間
 * 真っ黒な初期化画面のままにしない）。復元できない場合（保存が無い/
 * ディレクトリ不一致/初回起動）は従来どおりスキャン完了を待ってから
 * 初期化する。
 *
 * `App.tsx` のオーケストレーションから React の状態・フックを注入で切り離した
 * 純粋な非同期関数にすることで、コンポーネントをマウントせずに起動順序を
 * 直接テストできるようにする（`startup.test.ts`）。
 */
export interface StartupDeps {
  getSetting: (key: string) => Promise<string | null>;
  getLastDirectoryPath: () => Promise<string | null>;
  restorePlaylist: (directoryPath: string) => Promise<boolean>;
  scanDirectory: (directoryPath: string) => Promise<{ totalFiles: number }>;
  initialize: (autoPlay?: boolean) => Promise<void>;
  listenScanProgress: (
    cb: (payload: { current: number; total: number }) => void,
  ) => Promise<UnlistenFn>;
  setInitStatus: (status: string) => void;
  setRealtimeProgress: (progress: { current: number; total: number } | null) => void;
  setIsInitialized: (value: boolean) => void;
  setDisplayInterval: (value: number) => void;
  updatePlaylistInfo: () => Promise<void>;
  /** バックグラウンドスキャン失敗時のフック（テスト用）。省略時は何もしない。 */
  onBackgroundScanError?: (err: unknown) => void;
}

/** `scanDirectory` を進捗イベント購読つきで実行するヘルパー（前景/背景どちらでも使う）。 */
async function runScanWithProgress(
  directory: string,
  deps: Pick<StartupDeps, 'scanDirectory' | 'listenScanProgress' | 'setRealtimeProgress'>,
): Promise<{ totalFiles: number }> {
  const { scanDirectory, listenScanProgress, setRealtimeProgress } = deps;
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listenScanProgress((payload) => setRealtimeProgress(payload));
    const progress = await scanDirectory(directory);
    setRealtimeProgress(null);
    return progress;
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
}

export async function runStartupSequence(deps: StartupDeps): Promise<void> {
  const {
    getSetting,
    getLastDirectoryPath,
    restorePlaylist,
    initialize,
    setInitStatus,
    setIsInitialized,
    setDisplayInterval,
    updatePlaylistInfo,
    onBackgroundScanError,
  } = deps;

  try {
    setInitStatus('設定を読み込んでいます...');
    const intervalSetting = await getSetting('display_interval');
    if (intervalSetting) {
      setDisplayInterval(parseInt(intervalSetting, 10));
    }

    setInitStatus('前回フォルダを確認しています...');
    const lastDirectory = await getLastDirectoryPath();

    if (!lastDirectory) {
      // 前回ディレクトリがなければ初回起動として設定画面を開けるようにする
      setInitStatus('');
      setIsInitialized(true);
      return;
    }

    setInitStatus('前回の状態を復元しています...');
    let restored = false;
    try {
      restored = await restorePlaylist(lastDirectory);
    } catch (err) {
      console.error('Failed to restore playlist:', err);
    }

    if (restored) {
      // 復元できたので、スキャン完了を待たずに表示を始める。
      setInitStatus('画像を読み込んでいます...');
      await initialize(true);
      setIsInitialized(true);
      await updatePlaylistInfo();

      // スキャンはバックグラウンドで実行し、完了したら差分をプレイリスト情報に反映する。
      // ここは意図的に await しない（表示をブロックしないのがS1の目的）。
      void runScanWithProgress(lastDirectory, deps)
        .then(() => updatePlaylistInfo())
        .catch((err) => {
          console.error('Background scan failed:', err);
          onBackgroundScanError?.(err);
        });
      return;
    }

    // 復元できない場合は従来どおりスキャン完了を待つ。
    try {
      setInitStatus('ディレクトリをスキャンしています...');
      const progress = await runScanWithProgress(lastDirectory, deps);
      setInitStatus(`スキャン完了: ${progress.totalFiles.toLocaleString()}ファイル検出`);

      setInitStatus('画像を読み込んでいます...');
      await initialize(true);
      setIsInitialized(true);
      await updatePlaylistInfo();
    } catch (scanErr) {
      console.error('Failed to scan last directory:', scanErr);
      // エラーが発生しても初期化を完了させ、設定画面を開けるようにする
      setInitStatus('');
      setIsInitialized(true);
    }
  } catch (err) {
    console.error('Failed to initialize:', err);
    setInitStatus('');
    setIsInitialized(true);
  }
}
