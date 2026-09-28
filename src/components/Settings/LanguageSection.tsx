import { useState } from 'react';
import { useT, getLanguageSetting, setLanguageSetting } from '../../lib/i18n';
import type { LanguageSetting } from '../../lib/i18n';
import { saveSetting } from '../../lib/tauri';

const OPTIONS: LanguageSetting[] = ['auto', 'ja', 'en'];

/**
 * 言語切替UI（#80）。オプションタブに控えめなセグメントボタンで置く
 * （DESIGN.md準拠: モノクロ・タブと同系統のトーンで、装飾を増やさない）。
 * 切替は `setLanguageSetting` で即座にストアへ反映（=画面へ即時反映）してから
 * `app_settings` へ永続化する。
 */
export function LanguageSection() {
  // #82レビューnit: `useT()`自体が内部で`useLocale()`を呼びロケール変更を購読して
  // 再レンダーを起こすため、ここで別途`useLocale()`を呼ぶのは冗長だった（返り値も
  // 使っていない）。このボタン群自身の表示言語追従は`t`経由で引き続き効く。
  const t = useT();
  const [setting, setSetting] = useState<LanguageSetting>(getLanguageSetting());

  const handleChange = async (next: LanguageSetting) => {
    setLanguageSetting(next);
    setSetting(next);
    try {
      await saveSetting('language', next);
    } catch (err) {
      console.error('Failed to save language setting:', err);
    }
  };

  const labelFor = (option: LanguageSetting): string => {
    if (option === 'auto') return t('languageAuto');
    if (option === 'ja') return t('languageJa');
    return t('languageEn');
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">
        {t('languageLabel')}
      </h3>
      <div className="inline-flex bg-black/40 rounded border border-white/8 p-0.5 gap-0.5">
        {OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => handleChange(option)}
            className={`px-3 py-1.5 rounded text-sm transition-colors ${
              setting === option
                ? 'bg-white/15 text-white/80'
                : 'text-white/40 hover:text-white/60 hover:bg-white/5'
            }`}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </div>
  );
}
