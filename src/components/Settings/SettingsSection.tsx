import { useState, useEffect } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';

export function SettingsSection() {
  const [resetOnDirectoryChange, setResetOnDirectoryChange] = useState(true);
  const [applyExifRotation, setApplyExifRotation] = useState(true);

  useEffect(() => {
    // reset_on_directory_change設定を読み込む
    getSetting('reset_on_directory_change')
      .then((value) => {
        if (value !== null) {
          setResetOnDirectoryChange(value === 'true');
        }
      })
      .catch((err) => {
        console.error('Failed to load reset_on_directory_change:', err);
      });

    // apply_exif_rotation設定を読み込む
    getSetting('apply_exif_rotation')
      .then((value) => {
        if (value !== null) {
          setApplyExifRotation(value === 'true');
        }
      })
      .catch((err) => {
        console.error('Failed to load apply_exif_rotation:', err);
      });
  }, []);

  const handleResetChange = async (checked: boolean) => {
    setResetOnDirectoryChange(checked);
    try {
      await saveSetting('reset_on_directory_change', checked ? 'true' : 'false');
    } catch (err) {
      console.error('Failed to save reset_on_directory_change:', err);
    }
  };

  const handleExifRotationChange = async (checked: boolean) => {
    setApplyExifRotation(checked);
    try {
      await saveSetting('apply_exif_rotation', checked ? 'true' : 'false');
    } catch (err) {
      console.error('Failed to save apply_exif_rotation:', err);
    }
  };

  return (
    <div className="space-y-4">
      {/* 表示回数リセット設定 */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={resetOnDirectoryChange}
          onChange={(e) => handleResetChange(e.target.checked)}
          className="mt-1 w-5 h-5 rounded border-gray-600 text-gray-600 focus:ring-gray-500"
        />
        <div className="text-white font-medium">ディレクトリ変更時に表示回数をリセット</div>
      </label>

      {/* EXIF回転設定 */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={applyExifRotation}
          onChange={(e) => handleExifRotationChange(e.target.checked)}
          className="mt-1 w-5 h-5 rounded border-gray-600 text-gray-600 focus:ring-gray-500"
        />
        <div className="text-white font-medium">EXIF回転情報に従って画像を自動回転</div>
      </label>
    </div>
  );
}
