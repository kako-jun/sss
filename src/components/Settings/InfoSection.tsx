import { ExternalLink, RotateCcw } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { useState, useEffect } from 'react';
import { resetAllData } from '../../lib/tauri';
import { useT, resolveResetAllDataErrorMessage } from '../../lib/i18n';

// #82レビューshould1: 確定済みの文言でなく状態種別＋生のエラーコードを保持し、
// レンダーのたびに現在のロケールへ変換する（言語切替中の新旧混在防止）。
type ResetMessageState = { kind: 'resetting' } | { kind: 'error'; raw: string };

export function InfoSection() {
  const t = useT();
  const [isResetting, setIsResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<ResetMessageState | null>(null);
  // #66 問題7: バージョンを「1.0.0」でハードコードしていたのを、Tauriの
  // `getVersion()`（`tauri.conf.json`のバージョンを返す）から取得するようにする。
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((err) => {
        console.error('Failed to get app version:', err);
      });
  }, []);
  const resetMessageText =
    resetMessage === null
      ? ''
      : resetMessage.kind === 'resetting'
        ? t('resettingMessage')
        : t('resetErrorPrefix', { detail: resolveResetAllDataErrorMessage(resetMessage.raw) });

  const handleOpenGitHub = async () => {
    try {
      await openUrl('https://github.com/kako-jun/sss');
    } catch (err) {
      console.error('Failed to open GitHub:', err);
    }
  };

  const handleResetSettings = async () => {
    if (!confirm(t('confirmResetAllData'))) {
      return;
    }

    setIsResetting(true);
    setResetMessage({ kind: 'resetting' });

    try {
      // バックエンド（reset_all_data）は初期化が成功すると最後にアプリのプロセス
      // 自体を再起動する（asset scope・メモリ状態を新規プロセスとして確実に
      // 作り直すため。以前はプロセスは再起動せず、ここで window.location.reload()
      // を呼んでいたが、asset scope の取り消し方法を forbid_directory から
      // プロセス再起動に変更したため不要になった）。そのため成功時、この
      // invoke 呼び出しはプロセスごと終了して戻ってこない想定で、以降の処理は
      // 書かない。失敗した場合のみ catch に落ちてエラーを表示する。
      await resetAllData();
    } catch (err) {
      console.error('Failed to reset settings:', err);
      setResetMessage({ kind: 'error', raw: typeof err === 'string' ? err : String(err) });
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* アプリ情報 */}
      <div className="space-y-3">
        <h3 className="text-base font-medium text-white/70">Smart Slide Show (sss)</h3>
        <div className="text-white/30 text-sm space-y-1">
          <div>{t('versionLabel', { version: version || '…' })}</div>
          <div>{t('appDescription')}</div>
        </div>
      </div>

      {/* GitHubリンク */}
      <div>
        <button
          onClick={handleOpenGitHub}
          className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/60 rounded border border-white/8 transition-colors text-sm"
        >
          <ExternalLink size={16} />
          {t('viewOnGitHub')}
        </button>
      </div>

      {/* 設定の初期化 */}
      <div className="border-t border-white/8 pt-6">
        <h4 className="text-xs font-medium text-white/25 uppercase tracking-wider mb-3">
          {t('dangerZoneTitle')}
        </h4>
        <button
          onClick={handleResetSettings}
          disabled={isResetting}
          className="flex items-center gap-2 px-4 py-2 bg-red-950/50 hover:bg-red-900/50 disabled:bg-black/20 disabled:text-white/20 text-red-400/60 hover:text-red-400/80 rounded border border-red-900/30 transition-colors text-sm"
        >
          <RotateCcw size={16} />
          {isResetting ? t('resettingSettingsLabel') : t('resetSettingsButton')}
        </button>
        {resetMessage && (
          <div className="mt-2 text-xs text-white/30 whitespace-pre-line">{resetMessageText}</div>
        )}
      </div>
    </div>
  );
}
