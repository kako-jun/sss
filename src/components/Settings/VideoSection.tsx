import { useState, useEffect, useId, useRef } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';
import {
  DEFAULT_VIDEO_AUDIO_ENABLED,
  DEFAULT_VIDEO_MAX_DURATION_SEC,
  SETTING_VIDEO_AUDIO_ENABLED,
  SETTING_VIDEO_MAX_DURATION_SEC,
  VIDEO_MAX_DURATION_OPTIONS_SEC,
  normalizeVideoMaxDuration,
  parseVideoAudioEnabled,
  parseVideoMaxDuration,
} from '../../constants';
import { useT } from '../../lib/i18n';

interface VideoSectionProps {
  /** 音声ON/OFFが変わった時に、再生中のスライドショーへ即時反映するための通知（#68）。 */
  onAudioChange?: (enabled: boolean) => void;
  /** 最大再生時間（秒、0=無制限）が変わった時の通知（#68）。 */
  onMaxDurationChange?: (sec: number) => void;
}

/**
 * 動画の設定（#68）: 音声ON/OFFと最大再生時間。
 * 保存は既存の `app_settings`（`saveSetting`/`getSetting`）に乗せ、読込時の破損値は
 * `constants.ts` の `parseVideo*` で既定へ丸める。ラベルは `htmlFor`/`id` で明示的に
 * 関連付け、チェックボックスもセレクトもネイティブ要素のままなのでキーボード
 * （Tab/Space/矢印）でそのまま操作できる。
 */
export function VideoSection({ onAudioChange, onMaxDurationChange }: VideoSectionProps) {
  const t = useT();
  const audioId = useId();
  const audioDescId = useId();
  const maxDurationId = useId();
  const maxDurationDescId = useId();
  const [audioEnabled, setAudioEnabled] = useState<boolean>(DEFAULT_VIDEO_AUDIO_ENABLED);
  const [maxDurationSec, setMaxDurationSec] = useState<number>(DEFAULT_VIDEO_MAX_DURATION_SEC);

  // 読込が完了する前にユーザーが操作した場合、遅れて届いた保存値で上書きしない。
  const audioTouchedRef = useRef(false);
  const maxDurationTouchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getSetting(SETTING_VIDEO_AUDIO_ENABLED)
      .then((value) => {
        if (!cancelled && !audioTouchedRef.current) setAudioEnabled(parseVideoAudioEnabled(value));
      })
      .catch((err) => console.error('Failed to load video audio setting:', err));
    getSetting(SETTING_VIDEO_MAX_DURATION_SEC)
      .then((value) => {
        if (!cancelled && !maxDurationTouchedRef.current)
          setMaxDurationSec(parseVideoMaxDuration(value));
      })
      .catch((err) => console.error('Failed to load video max duration setting:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAudioChange = async (checked: boolean) => {
    audioTouchedRef.current = true;
    setAudioEnabled(checked);
    onAudioChange?.(checked);
    try {
      await saveSetting(SETTING_VIDEO_AUDIO_ENABLED, checked ? 'true' : 'false');
    } catch (err) {
      console.error('Failed to save video audio setting:', err);
    }
  };

  const handleMaxDurationChange = async (raw: string) => {
    maxDurationTouchedRef.current = true;
    const sec = normalizeVideoMaxDuration(parseInt(raw, 10));
    setMaxDurationSec(sec);
    onMaxDurationChange?.(sec);
    try {
      await saveSetting(SETTING_VIDEO_MAX_DURATION_SEC, sec.toString());
    } catch (err) {
      console.error('Failed to save video max duration setting:', err);
    }
  };

  const optionLabel = (sec: number): string => {
    if (sec === 0) return t('videoMaxDurationUnlimited');
    if (sec % 60 === 0) return t('videoMaxDurationMinutes', { count: String(sec / 60) });
    return t('videoMaxDurationSeconds', { count: String(sec) });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-white/70">{t('videoSectionTitle')}</h3>

      <div className="flex items-start gap-3">
        <input
          id={audioId}
          type="checkbox"
          checked={audioEnabled}
          onChange={(e) => handleAudioChange(e.target.checked)}
          aria-describedby={audioDescId}
          className="mt-0.5 w-4 h-4 rounded border-white/20 bg-white/5 text-white/50 focus:ring-0 focus:ring-offset-0 accent-white/50 cursor-pointer"
        />
        <div>
          <label htmlFor={audioId} className="text-white/50 text-sm cursor-pointer">
            {t('videoAudioLabel')}
          </label>
          <p id={audioDescId} className="text-xs text-white/50 mt-1">
            {t('videoAudioDescription')}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor={maxDurationId} className="block text-sm text-white/50">
          {t('videoMaxDurationLabel')}
        </label>
        <select
          id={maxDurationId}
          value={maxDurationSec}
          onChange={(e) => handleMaxDurationChange(e.target.value)}
          aria-describedby={maxDurationDescId}
          className="px-2 py-1 bg-black/40 text-white/60 rounded border border-white/8 text-sm focus:outline-none focus:border-white/20"
        >
          {VIDEO_MAX_DURATION_OPTIONS_SEC.map((sec) => (
            <option key={sec} value={sec}>
              {optionLabel(sec)}
            </option>
          ))}
        </select>
        <p id={maxDurationDescId} className="text-xs text-white/50">
          {t('videoMaxDurationDescription')}
        </p>
      </div>
    </div>
  );
}
