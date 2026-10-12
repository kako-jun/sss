import { useState, useEffect } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';
import { useT } from '../../lib/i18n';
import { useRollbackSave } from '../../hooks/useRollbackSave';
import { SETTING_APPLY_EXIF_ROTATION, parseBoolSetting } from '../../constants';
import { InlineError } from './SectionErrors';

export function SettingsSection() {
  const t = useT();
  const [applyExifRotation, setApplyExifRotation] = useState(true);
  // #115: 取得失敗（既定値表示）と保存失敗（巻き戻し）を利用者に伝える。
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { saveFailed, save, beginLoad, markLoaded } = useRollbackSave<boolean>(
    setApplyExifRotation,
    true,
    'exifSaveFailed',
  );

  useEffect(() => {
    let cancelled = false;
    const token = beginLoad();
    // apply_exif_rotation設定を読み込む
    getSetting(SETTING_APPLY_EXIF_ROTATION)
      .then((value) => {
        if (cancelled) return;
        setLoadFailed(false);
        // 未設定・破損値は Rust 側と同じく既定（ON）に倒す（#148）
        const parsed = parseBoolSetting(SETTING_APPLY_EXIF_ROTATION, value);
        if (markLoaded(parsed, token)) setApplyExifRotation(parsed);
      })
      .catch((err) => {
        console.error('Failed to load setting:', err);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, beginLoad, markLoaded]);

  const handleExifRotationChange = async (checked: boolean) => {
    setApplyExifRotation(checked);
    const ok = await save(checked, (v) =>
      saveSetting(SETTING_APPLY_EXIF_ROTATION, v ? 'true' : 'false'),
    );
    if (ok) setLoadFailed(false);
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
      <InlineError
        message={saveFailed ? t('exifSaveFailed') : loadFailed ? t('settingLoadFailed') : null}
        onRetry={!saveFailed && loadFailed ? () => setAttempt((n) => n + 1) : undefined}
        testId="exif-error"
      />
    </div>
  );
}
