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
        <div className="text-white/50 text-sm space-y-1">
          <div>{t('versionLabel', { version: version || '…' })}</div>
          <div>{t('appDescription')}</div>
        </div>
      </div>

      {/* GitHubリンク。#66視覚刷新: 副次操作なのでDESIGN.md「Buttons — Ghost」。
          #66レビューnit: px-4のパディングのせいで、上の見出し/説明文（左パディング
          無し）とボタン内のアイコンの左端が揃っていなかった。ボタンの当たり判定は
          保ったまま`-ml-4`で見た目の左端だけ引き戻す。 */}
      <div>
        {/* #66レビュー2巡目nit: /40→/50（他の説明/補助テキストと同じ濃さに統一）。 */}
        <button
          onClick={handleOpenGitHub}
          className="flex items-center gap-2 px-4 py-2 -ml-4 text-white/50 hover:text-white/70 hover:bg-white/8 rounded-lg transition-colors text-sm"
        >
          <ExternalLink size={16} />
          {t('viewOnGitHub')}
        </button>
      </div>

      {/* 設定の初期化。#66視覚刷新: 罫線区切りをやめ、カード背景で危険な操作の
          領域を視覚的に分ける。#66レビューnit: bg-black/20は`bg-neutral-950`の
          モーダル背景とほぼ差が無く沈んで見えたため、境界線を添えて視認性を
          上げる。 */}
      <div className="bg-black/30 border border-white/8 rounded-lg p-4">
        <h4 className="text-sm font-medium text-white/70">{t('dangerZoneTitle')}</h4>
        <p className="text-xs text-white/50 mt-1 mb-3">{t('dangerZoneDescription')}</p>
        <button
          onClick={handleResetSettings}
          disabled={isResetting}
          className="flex items-center gap-2 px-4 py-2 bg-red-950/60 hover:bg-red-900/60 disabled:bg-black/20 disabled:text-white/20 disabled:cursor-not-allowed text-red-400/70 hover:text-red-400/90 rounded-lg transition-colors text-sm"
        >
          <RotateCcw size={16} />
          {isResetting ? t('resettingSettingsLabel') : t('resetSettingsButton')}
        </button>
        {resetMessage && (
          <div className="mt-2 text-xs text-white/50 whitespace-pre-line">{resetMessageText}</div>
        )}
      </div>
    </div>
  );
}
