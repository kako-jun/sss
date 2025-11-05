import { ExternalLink, RotateCcw } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useState } from 'react';
import { resetAllData } from '../../lib/tauri';

export function InfoSection() {
  const [isResetting, setIsResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState('');

  const handleOpenGitHub = async () => {
    try {
      await open('https://github.com/kako-jun/sss');
    } catch (err) {
      console.error('Failed to open GitHub:', err);
    }
  };

  const handleResetSettings = async () => {
    if (!confirm('全ての設定、プレイリスト、表示履歴を完全に削除して初期化しますか？\n\nこの操作は取り消せません。')) {
      return;
    }

    setIsResetting(true);
    setResetMessage('初期化中...');

    try {
      await resetAllData();
      setResetMessage('初期化が完了しました。ページをリロードしてください。');
      setIsResetting(false);
    } catch (err) {
      console.error('Failed to reset settings:', err);
      setResetMessage(`エラー: ${err}`);
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* アプリ情報 */}
      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-white">Smart Slide Show (sss)</h3>
        <div className="text-gray-400 space-y-2">
          <div>バージョン: 1.0.0</div>
          <div>10万枚以上の写真を公平に表示するスライドショーアプリ</div>
        </div>
      </div>

      {/* GitHubリンク */}
      <div>
        <button
          onClick={handleOpenGitHub}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
        >
          <ExternalLink size={18} />
          GitHubで見る
        </button>
      </div>

      {/* 設定の初期化 */}
      <div className="border-t border-gray-700 pt-6">
        <h4 className="text-sm font-semibold text-gray-300 mb-2">危険な操作</h4>
        <button
          onClick={handleResetSettings}
          disabled={isResetting}
          className="flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-600 disabled:bg-gray-600 text-white rounded transition-colors"
        >
          <RotateCcw size={18} />
          {isResetting ? '初期化中...' : '設定を初期化'}
        </button>
        {resetMessage && (
          <div className="mt-2 text-sm text-gray-400 whitespace-pre-line">
            {resetMessage}
          </div>
        )}
      </div>
    </div>
  );
}
