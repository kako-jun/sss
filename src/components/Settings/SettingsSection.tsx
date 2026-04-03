import { useState, useEffect } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';

export function SettingsSection() {
  const [applyExifRotation, setApplyExifRotation] = useState(true);

  useEffect(() => {
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
      {/* EXIF回転設定 */}
      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={applyExifRotation}
          onChange={(e) => handleExifRotationChange(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-white/20 bg-white/5 text-white/50 focus:ring-0 focus:ring-offset-0 accent-white/50"
        />
        <div className="text-white/55 text-sm group-hover:text-white/75 transition-colors">EXIF回転情報に従って画像を自動回転</div>
      </label>
    </div>
  );
}
