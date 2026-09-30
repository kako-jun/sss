import { FolderOpen } from 'lucide-react';
import { useState, useEffect } from 'react';
import {
  selectDirectory,
  saveSetting,
  getDefaultShareDirectory,
  getShareDirectory,
} from '../../lib/tauri';
import { useT } from '../../lib/i18n';
import { resolveShareDirectoryErrorMessage } from '../../lib/i18n/errors';

export function ShareDirectorySection() {
  const t = useT();
  const [shareDirectoryPath, setShareDirectoryPath] = useState<string>('');
  const [defaultPath, setDefaultPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // デフォルトパスを取得
        const defaultDirectory = await getDefaultShareDirectory();
        setDefaultPath(defaultDirectory);

        // 実際に使われる解決済みパスを表示する（保存値が不正なら既定にフォールバック済み）
        setShareDirectoryPath(await getShareDirectory());
      } catch (err) {
        console.error('Failed to load share directory setting:', err);
      }
    };

    loadSettings();
  }, []);

  const handleSelectDirectory = async () => {
    try {
      const directory = await selectDirectory();
      if (directory) {
        // #87: バックエンドが不正なピック先（ルート・ホーム等）を拒否することがあるため、
        // 保存に成功してから表示を更新する。
        await saveSetting('share_directory_path', directory);
        setShareDirectoryPath(await getShareDirectory());
        setError(null);
      }
    } catch (err) {
      console.error('Failed to select share directory:', err);
      setError(resolveShareDirectoryErrorMessage(String(err)));
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/70">{t('pickDestinationTitle')}</h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={shareDirectoryPath}
          readOnly
          placeholder={defaultPath}
          title={shareDirectoryPath || defaultPath}
          className="flex-1 px-3 py-2 bg-black/40 text-white/50 rounded-lg border border-white/8 focus:outline-none focus:border-white/20 text-sm truncate"
        />
        <button
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 px-4 py-2 text-white/50 hover:text-white/80 hover:bg-white/8 rounded-lg transition-colors shrink-0 text-sm"
        >
          <FolderOpen className="w-4 h-4" />
          {t('selectButtonLabel')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300/80">
          {error}
        </p>
      )}
    </div>
  );
}
