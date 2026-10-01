import { useState, useEffect } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';
import { useT } from '../../lib/i18n';

export function SettingsSection() {
  const t = useT();
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
          className="sss-checkbox"
        />
        {/* #66レビュー2巡目nit: /55→/50（他の説明/補助テキストと同じ濃さに統一）。 */}
        <div className="text-white/50 text-sm group-hover:text-white/75 transition-colors">
          {t('exifRotationLabel')}
        </div>
      </label>
    </div>
  );
}
