import { useState, useEffect, useId, useRef } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';
import {
  DEFAULT_MAP_THUMBNAIL_ENABLED,
  SETTING_MAP_THUMBNAIL_ENABLED,
  parseMapThumbnailEnabled,
} from '../../constants';
import { useT } from '../../lib/i18n';
import { useRollbackSave } from '../../hooks/useRollbackSave';
import { InlineError } from './SectionErrors';

interface MapSectionProps {
  /** ON/OFFが変わった時に、操作バーへ即時反映するための通知（#145）。 */
  onChange?: (enabled: boolean) => void;
}

/**
 * 地図サムネイルの設定（#145）。ONのときだけ、操作バーが見えている間に OpenStreetMap の
 * タイルサーバーへ接続する。外部通信の有無と送信内容を説明文で明示する。
 * 保存は既存の `app_settings`、読込時の破損値は `parseMapThumbnailEnabled` が既定（ON）へ丸める。
 */
export function MapSection({ onChange }: MapSectionProps) {
  const t = useT();
  const checkboxId = useId();
  const descId = useId();
  const [enabled, setEnabled] = useState<boolean>(DEFAULT_MAP_THUMBNAIL_ENABLED);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const { saveFailed, save, beginLoad, markLoaded } = useRollbackSave<boolean>(
    (v) => {
      setEnabled(v);
      onChangeRef.current?.(v);
    },
    DEFAULT_MAP_THUMBNAIL_ENABLED,
    'mapSaveFailed',
  );
  // 読込が完了する前にユーザーが操作した場合、遅れて届いた保存値で上書きしない。
  const touchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const token = beginLoad();
    getSetting(SETTING_MAP_THUMBNAIL_ENABLED)
      .then((value) => {
        if (cancelled) return;
        setLoadFailed(false);
        const parsed = parseMapThumbnailEnabled(value);
        if (markLoaded(parsed, token) && !touchedRef.current) setEnabled(parsed);
      })
      .catch((err) => {
        console.error('Failed to load map thumbnail setting:', err);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, beginLoad, markLoaded]);

  const handleChange = async (checked: boolean) => {
    touchedRef.current = true;
    setEnabled(checked);
    onChange?.(checked);
    const ok = await save(checked, (v) =>
      saveSetting(SETTING_MAP_THUMBNAIL_ENABLED, v ? 'true' : 'false'),
    );
    if (ok) setLoadFailed(false);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/70">{t('mapSectionTitle')}</h3>
      <div className="flex items-start gap-3">
        <input
          id={checkboxId}
          type="checkbox"
          checked={enabled}
          onChange={(e) => handleChange(e.target.checked)}
          aria-describedby={descId}
          className="sss-checkbox"
        />
        <div>
          <label
            htmlFor={checkboxId}
            className="block leading-5 text-white/50 text-sm cursor-pointer"
          >
            {t('mapThumbnailLabel')}
          </label>
          <p id={descId} className="text-xs text-white/50 mt-1">
            {t('mapThumbnailDescription')}
          </p>
        </div>
      </div>
      <InlineError
        message={saveFailed ? t('mapSaveFailed') : loadFailed ? t('settingLoadFailed') : null}
        onRetry={!saveFailed && loadFailed ? () => setAttempt((n) => n + 1) : undefined}
        testId="map-error"
      />
    </div>
  );
}
