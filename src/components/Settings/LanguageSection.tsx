import { useState } from 'react';
import { useT, getLanguageSetting, setLanguageSetting } from '../../lib/i18n';
import type { LanguageSetting } from '../../lib/i18n';
import { saveSetting } from '../../lib/tauri';
import { useRollbackSave } from '../../hooks/useRollbackSave';
import { InlineError } from './SectionErrors';

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
  // #115: 保存に失敗したら、画面の言語も保存済みの設定へ巻き戻して失敗を伝える
  // （次回起動で元の言語に戻って初めて気づく、を防ぐ）。
  const { saveFailed, save } = useRollbackSave<LanguageSetting>(
    (previous) => {
      setLanguageSetting(previous);
      setSetting(previous);
    },
    getLanguageSetting(),
    'languageSaveFailed',
  );

  const handleChange = async (next: LanguageSetting) => {
    setLanguageSetting(next);
    setSetting(next);
    await save(next, (v) => saveSetting('language', v));
  };

  const labelFor = (option: LanguageSetting): string => {
    if (option === 'auto') return t('languageAuto');
    if (option === 'ja') return t('languageJa');
    return t('languageEn');
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/70">{t('languageLabel')}</h3>
      <div className="inline-flex bg-black/40 rounded-lg p-0.5 gap-0.5">
        {OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => handleChange(option)}
            // #66レビュー2巡目nit: 非選択の文字色を/40→/50に（設定タブ行の
            // 非選択スタイルと揃える。DESIGN.mdのテキスト階層に合わせて統一）。
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              setting === option
                ? 'bg-white/15 text-white/80'
                : 'text-white/50 hover:text-white/70 hover:bg-white/5'
            }`}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
      <InlineError message={saveFailed ? t('languageSaveFailed') : null} testId="language-error" />
    </div>
  );
}
