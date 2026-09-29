import { FolderOpen } from 'lucide-react';
import { useState, useEffect } from 'react';
import {
  selectDirectory,
  getSetting,
  saveSetting,
  getDefaultShareDirectory,
} from '../../lib/tauri';
import { useT } from '../../lib/i18n';

export function ShareDirectorySection() {
  const t = useT();
  const [shareDirectoryPath, setShareDirectoryPath] = useState<string>('');
  const [defaultPath, setDefaultPath] = useState<string>('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // デフォルトパスを取得
        const defaultDirectory = await getDefaultShareDirectory();
        setDefaultPath(defaultDirectory);

        // 設定から読み込む
        const saved = await getSetting('share_directory_path');
        setShareDirectoryPath(saved || defaultDirectory);
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
        setShareDirectoryPath(directory);
        await saveSetting('share_directory_path', directory);
      }
    } catch (err) {
      console.error('Failed to select share directory:', err);
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
    </div>
  );
}
