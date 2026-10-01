import type { UnlistenFn } from '@tauri-apps/api/event';
import { t } from './i18n';
import {
  SETTING_VIDEO_AUDIO_ENABLED,
  SETTING_VIDEO_MAX_DURATION_SEC,
  parseVideoAudioEnabled,
  parseVideoMaxDuration,
} from '../constants';

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
  /** #93: 復元・再スキャンの対象は DB 保存済みの前回フォルダ。パスは引数で渡さない。 */
  restorePlaylist: () => Promise<boolean>;
  rescanLastDirectory: () => Promise<{ totalFiles: number }>;
  /**
   * #65: `isPlaying` はApp側の派生値になったため、ここでは単に最初の画像を
   * 読み込むだけでよい（`autoPlay` 引数は廃止。再生開始の可否は呼び出し元の
   * フラグが担う。問題4の根本修正）。
   */
  initialize: () => Promise<void>;
  listenScanProgress: (
    cb: (payload: { current: number; total: number }) => void,
  ) => Promise<UnlistenFn>;
  setInitStatus: (status: string) => void;
  setRealtimeProgress: (progress: { current: number; total: number } | null) => void;
  setIsInitialized: (value: boolean) => void;
  setDisplayInterval: (value: number) => void;
  /** #68: 動画の音声ON/OFF（保存済みの値。未設定・破損時は既定のOFFで呼ぶ）。省略時は復元しない。 */
  setVideoAudioEnabled?: (value: boolean) => void;
  /** #68: 動画の最大再生時間（秒、0=無制限）。未設定・破損時は既定（0）で呼ぶ。省略時は復元しない。 */
  setVideoMaxDurationSec?: (value: number) => void;
  updatePlaylistInfo: () => Promise<void>;
  /**
   * 前回ディレクトリが確認できた時点で呼ぶ（#65: 「本当に未設定」（ようこそ画面）と
   * 「設定済みだが今アクセスできない/スキャン失敗」を区別するため）。
   */
  setHasDirectory?: (value: boolean) => void;
  /**
   * 前回ディレクトリへのスキャンが失敗した（起動時の前景スキャン待ち・復元後の
   * バックグラウンドスキャンのどちらも含む）ときに理由を伝える（#65本文コメント:
   * 「起動時自動スキャンで前回ディレクトリが拒否された際の理由表示」）。
   * 省略時は何もしない（従来どおりconsole.errorのみ）。
   *
   * #80: `directory` も一緒に渡す。バックエンドのエラーはエラーコード（例:
   * "directoryNotFound"）で返るため、呼び出し元（App.tsx）が
   * `resolveScanErrorMessage(err, directory)` でロケールに応じた文言へ変換する
   * 際にパスを補う必要がある。
   */
  onDirectoryError?: (err: unknown, directory: string) => void;
  /**
   * 起動シーケンス自体の失敗を利用者に伝える（#115。以前は console.error のみで、
   * 前回フォルダの取得失敗が「ようこそ（初回）」画面に、設定の取得失敗が既定値の動作に見えていた）。
   * - `lastDirectory`: 前回フォルダを取得できなかった（フォルダ有無が不明。ようこそ画面にしない）
   * - `settings`: 表示間隔・動画設定を取得できず既定値で続行する
   * - `initialize`: 上記以外の想定外の失敗で最初の表示まで進めなかった
   * 省略時は何もしない（従来どおり console.error のみ）。
   */
  onStartupFailure?: (kind: StartupFailureKind, err: unknown) => void;
}

export type StartupFailureKind = 'lastDirectory' | 'settings' | 'initialize';

/** `rescanLastDirectory` を進捗イベント購読つきで実行するヘルパー（前景/背景どちらでも使う）。 */
async function runScanWithProgress(
  deps: Pick<StartupDeps, 'rescanLastDirectory' | 'listenScanProgress' | 'setRealtimeProgress'>,
): Promise<{ totalFiles: number }> {
  const { rescanLastDirectory, listenScanProgress, setRealtimeProgress } = deps;
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listenScanProgress((payload) => setRealtimeProgress(payload));
    const progress = await rescanLastDirectory();
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
    setVideoAudioEnabled,
    setVideoMaxDurationSec,
    updatePlaylistInfo,
    setHasDirectory,
    onDirectoryError,
    onStartupFailure,
  } = deps;

  try {
    setInitStatus(t('statusLoadingSettings'));
    // 設定の取得失敗で起動全体を止めない（既定値で続行し、失敗は利用者に伝える）。
    let settingsFailure: unknown = null;
    try {
      const intervalSetting = await getSetting('display_interval');
      if (intervalSetting) {
        setDisplayInterval(parseInt(intervalSetting, 10));
      }
    } catch (err) {
      console.error('Failed to load display interval:', err);
      settingsFailure = err;
    }

    // #68: 動画設定。読込失敗でも起動全体は止めない（既定のまま続行）。
    if (setVideoAudioEnabled || setVideoMaxDurationSec) {
      try {
        const [audioSetting, maxDurationSetting] = await Promise.all([
          getSetting(SETTING_VIDEO_AUDIO_ENABLED),
          getSetting(SETTING_VIDEO_MAX_DURATION_SEC),
        ]);
        setVideoAudioEnabled?.(parseVideoAudioEnabled(audioSetting));
        setVideoMaxDurationSec?.(parseVideoMaxDuration(maxDurationSetting));
      } catch (err) {
        console.error('Failed to load video settings:', err);
        settingsFailure = err;
      }
    }
    if (settingsFailure !== null) onStartupFailure?.('settings', settingsFailure);

    setInitStatus(t('statusCheckingLastFolder'));
    let lastDirectory: string | null;
    try {
      lastDirectory = await getLastDirectoryPath();
    } catch (err) {
      // フォルダが設定済みかどうかが分からない。「ようこそ（初回）」画面に見せず、失敗として伝える。
      console.error('Failed to load last directory path:', err);
      onStartupFailure?.('lastDirectory', err);
      setInitStatus('');
      setIsInitialized(true);
      return;
    }

    if (!lastDirectory) {
      // 前回ディレクトリがなければ初回起動として設定画面を開けるようにする
      setInitStatus('');
      setIsInitialized(true);
      return;
    }

    // #65: ディレクトリ自体は設定済みと確定した。以降どんな結果になっても
    // 「ようこそ（未設定）」画面には戻らない。
    setHasDirectory?.(true);

    setInitStatus(t('statusRestoringState'));
    let restored = false;
    try {
      restored = await restorePlaylist();
    } catch (err) {
      console.error('Failed to restore playlist:', err);
    }

    if (restored) {
      // 復元できたので、スキャン完了を待たずに表示を始める。
      setInitStatus(t('statusLoadingImages'));
      await initialize();
      setIsInitialized(true);
      await updatePlaylistInfo();

      // スキャンはバックグラウンドで実行し、完了したら差分をプレイリスト情報に反映する。
      // ここは意図的に await しない（表示をブロックしないのがS1の目的）。
      //
      // #62レビュー2巡目 nit: 失敗時、スライドショー鑑賞中のユーザーへ割り込む専用UIは
      // 今は用意していない（console.errorのみ）。手動で「スキャン」を再実行すれば
      // Settings画面のScanSectionが日本語のエラーメッセージを表示する（ScanGuardの
      // 「スキャン実行中です。完了までお待ちください。」等も同経路で既に表示される）。
      // バックグラウンド失敗を鑑賞画面自体に通知する専用UIは、エラー表示の本格整理
      // （#65）でまとめて設計する。
      void runScanWithProgress(deps)
        .then(() => updatePlaylistInfo())
        .catch((err) => {
          console.error('Background scan failed:', err);
          onDirectoryError?.(err, lastDirectory);
        });
      return;
    }

    // 復元できない場合は従来どおりスキャン完了を待つ。
    try {
      setInitStatus(t('statusScanningDirectory'));
      const progress = await runScanWithProgress(deps);
      setInitStatus(t('statusScanComplete', { count: progress.totalFiles.toLocaleString() }));

      setInitStatus(t('statusLoadingImages'));
      await initialize();
      setIsInitialized(true);
      await updatePlaylistInfo();
    } catch (scanErr) {
      console.error('Failed to scan last directory:', scanErr);
      // #65: 以前はここで理由を握りつぶしていた（「起動時自動スキャンで前回
      // ディレクトリが拒否された際の理由表示」が本文コメントで要求されていた）。
      // 初期化自体は完了させ、設定画面を開けるようにしつつ理由を呼び出し元へ渡す。
      onDirectoryError?.(scanErr, lastDirectory);
      setInitStatus('');
      setIsInitialized(true);
    }
  } catch (err) {
    console.error('Failed to initialize:', err);
    // 防御的な経路: 通常 `initialize`/`updatePlaylistInfo` は内部で失敗を吸収するので到達しにくいが、
    // 想定外の例外で画像表示の前後どちらに失敗しても、黙って「ようこそ」/空画面に見せないために報告する
    // （画像が出ていれば App が上部トースト、出ていなければ再試行できる案内画面にする）。
    onStartupFailure?.('initialize', err);
    setInitStatus('');
    setIsInitialized(true);
  }
}
