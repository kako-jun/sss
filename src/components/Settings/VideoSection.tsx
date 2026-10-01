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
import { useRollbackSave } from '../../hooks/useRollbackSave';
import { InlineError } from './SectionErrors';

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

  // #115: 取得失敗（既定値表示）と保存失敗（巻き戻し）を利用者に伝える。通知は1か所にまとめる。
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onAudioChangeRef = useRef(onAudioChange);
  useEffect(() => {
    onAudioChangeRef.current = onAudioChange;
  });
  const onMaxDurationChangeRef = useRef(onMaxDurationChange);
  useEffect(() => {
    onMaxDurationChangeRef.current = onMaxDurationChange;
  });
  const audioSave = useRollbackSave<boolean>(
    (v) => {
      setAudioEnabled(v);
      onAudioChangeRef.current?.(v);
    },
    DEFAULT_VIDEO_AUDIO_ENABLED,
    'videoSaveFailed',
  );
  const maxDurationSave = useRollbackSave<number>(
    (v) => {
      setMaxDurationSec(v);
      onMaxDurationChangeRef.current?.(v);
    },
    DEFAULT_VIDEO_MAX_DURATION_SEC,
    'videoSaveFailed',
  );
  const { beginLoad: beginAudioLoad, markLoaded: markAudioLoaded } = audioSave;
  const { beginLoad: beginMaxDurationLoad, markLoaded: markMaxDurationLoaded } = maxDurationSave;

  // 読込が完了する前にユーザーが操作した場合、遅れて届いた保存値で上書きしない。
  const audioTouchedRef = useRef(false);
  const maxDurationTouchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    const audioToken = beginAudioLoad();
    const maxDurationToken = beginMaxDurationLoad();
    const onLoadError = (what: string) => (err: unknown) => {
      console.error(`Failed to load ${what}:`, err);
      failed = true;
      if (!cancelled) setLoadFailed(true);
    };
    Promise.all([
      getSetting(SETTING_VIDEO_AUDIO_ENABLED)
        .then((value) => {
          if (cancelled) return;
          const parsed = parseVideoAudioEnabled(value);
          if (markAudioLoaded(parsed, audioToken) && !audioTouchedRef.current) {
            setAudioEnabled(parsed);
          }
        })
        .catch(onLoadError('video audio setting')),
      getSetting(SETTING_VIDEO_MAX_DURATION_SEC)
        .then((value) => {
          if (cancelled) return;
          const parsed = parseVideoMaxDuration(value);
          if (markMaxDurationLoaded(parsed, maxDurationToken) && !maxDurationTouchedRef.current) {
            setMaxDurationSec(parsed);
          }
        })
        .catch(onLoadError('video max duration setting')),
    ]).then(() => {
      if (!cancelled && !failed) setLoadFailed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, beginAudioLoad, beginMaxDurationLoad, markAudioLoaded, markMaxDurationLoaded]);

  const handleAudioChange = async (checked: boolean) => {
    audioTouchedRef.current = true;
    setAudioEnabled(checked);
    onAudioChange?.(checked);
    const ok = await audioSave.save(checked, (v) =>
      saveSetting(SETTING_VIDEO_AUDIO_ENABLED, v ? 'true' : 'false'),
    );
    if (ok) setLoadFailed(false);
  };

  const handleMaxDurationChange = async (raw: string) => {
    maxDurationTouchedRef.current = true;
    const sec = normalizeVideoMaxDuration(parseInt(raw, 10));
    setMaxDurationSec(sec);
    onMaxDurationChange?.(sec);
    const ok = await maxDurationSave.save(sec, (v) =>
      saveSetting(SETTING_VIDEO_MAX_DURATION_SEC, v.toString()),
    );
    if (ok) setLoadFailed(false);
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
          className="sss-select px-2 py-1 bg-black/40 text-white/60 rounded border border-white/8 text-sm focus:outline-none focus:border-white/20"
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

      <InlineError
        message={
          audioSave.saveFailed || maxDurationSave.saveFailed
            ? t('videoSaveFailed')
            : loadFailed
              ? t('settingLoadFailed')
              : null
        }
        onRetry={
          !audioSave.saveFailed && !maxDurationSave.saveFailed && loadFailed
            ? () => setAttempt((n) => n + 1)
            : undefined
        }
        testId="video-error"
      />
    </div>
  );
}
