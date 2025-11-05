import { FolderOpen } from 'lucide-react';
import { useState, useEffect } from 'react';
import { selectFolder, getSetting, saveSetting, getDefaultShareFolder } from '../../lib/tauri';

export function ShareFolderSection() {
  const [shareFolderPath, setShareFolderPath] = useState<string>('');
  const [defaultPath, setDefaultPath] = useState<string>('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // デフォルトパスを取得
        const defaultFolder = await getDefaultShareFolder();
        setDefaultPath(defaultFolder);

        // 設定から読み込む
        const saved = await getSetting('share_folder_path');
        setShareFolderPath(saved || defaultFolder);
      } catch (err) {
        console.error('Failed to load share folder setting:', err);
      }
    };

    loadSettings();
  }, []);

  const handleSelectFolder = async () => {
    try {
      const folder = await selectFolder();
      if (folder) {
        setShareFolderPath(folder);
        await saveSetting('share_folder_path', folder);
      }
    } catch (err) {
      console.error('Failed to select share folder:', err);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-white">シェア先フォルダ</h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={shareFolderPath}
          readOnly
          placeholder={defaultPath}
          className="flex-1 px-3 py-2 bg-gray-800 text-gray-300 rounded border border-gray-700 focus:outline-none focus:border-gray-500"
        />
        <button
          onClick={handleSelectFolder}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition shrink-0"
        >
          <FolderOpen className="w-4 h-4" />
          選択
        </button>
      </div>
    </div>
  );
}
