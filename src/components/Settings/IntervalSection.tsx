import { useState, useEffect, useRef, useCallback } from 'react';
import { getSetting, saveSetting } from '../../lib/tauri';
import {
  DEFAULT_DISPLAY_INTERVAL,
  MIN_DISPLAY_INTERVAL,
  MAX_DISPLAY_INTERVAL,
  clampDisplayInterval,
} from '../../constants';
import { useT } from '../../lib/i18n';

interface IntervalSectionProps {
  onIntervalChange?: (interval: number) => void;
}

/** スライダー操作でDB保存を毎ステップ実行しないためのdebounce時間（#65 問題7）。 */
const SAVE_DEBOUNCE_MS = 400;

export function IntervalSection({ onIntervalChange }: IntervalSectionProps) {
  const t = useT();
  const [displayInterval, setDisplayInterval] = useState<number>(DEFAULT_DISPLAY_INTERVAL);
  // 数値入力欄の生テキスト。表示中の値(秒)の確定値とは別に持つことで、
  // 「一度クリアしたら即5に置換される」（#65 問題7）ような入力中の押し付けをしない。
  // 確定（onBlur/Enter）した時だけ displayInterval に反映する。
  const [numberText, setNumberText] = useState<string>(String(DEFAULT_DISPLAY_INTERVAL / 1000));

  const saveTimeoutRef = useRef<number | undefined>(undefined);
  // #65レビューS5: debounce中の保存先（ms）を覚えておき、unmount時に破棄せず
  // flushできるようにする。
  const pendingMsRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    getSetting('display_interval')
      .then((value) => {
        if (!value) return;
        const ms = clampDisplayInterval(parseInt(value, 10));
        setDisplayInterval(ms);
        setNumberText(String(ms / 1000));
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    return () => {
      // #65レビューS5: debounce中の保存を「捨てる」のではなく「即座に確定させる」。
      // 以前はclearTimeoutするだけで、スライダーを動かした直後に設定画面を閉じる
      // （このコンポーネントがunmountする）と、まだ発火していないdebounce保存が
      // 静かに消え、DBには古い値が残ったままになっていた。
      if (saveTimeoutRef.current !== undefined) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
        if (pendingMsRef.current !== undefined) {
          saveSetting('display_interval', pendingMsRef.current.toString()).catch((err) => {
            console.error('Failed to flush pending display interval on unmount:', err);
          });
        }
      }
    };
  }, []);

  const persistDebounced = useCallback((ms: number) => {
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
    }
    pendingMsRef.current = ms;
    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = undefined;
      pendingMsRef.current = undefined;
      saveSetting('display_interval', ms.toString()).catch((err) => {
        console.error('Failed to save display interval:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const persistImmediately = useCallback((ms: number) => {
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    pendingMsRef.current = undefined;
    saveSetting('display_interval', ms.toString()).catch((err) => {
      console.error('Failed to save display interval:', err);
    });
  }, []);

  // スライダー: ドラッグ中は毎ステップDB書込せず、値の反映と再生中スライドショーへの
  // 通知だけ即時に行い、DB保存はdebounceする（#65 問題7）。
  const handleSliderChange = (seconds: number) => {
    const ms = clampDisplayInterval(seconds * 1000);
    setDisplayInterval(ms);
    setNumberText(String(ms / 1000));
    onIntervalChange?.(ms);
    persistDebounced(ms);
  };

  // 数値入力: 入力中は生テキストをそのまま保持するだけ（clampしない・確定しない）。
  // 「消すと即5に置換される」不具合の原因は、入力の都度clamp後の値で上書きしていた
  // ことだったため、確定（onBlur）まで押し付けない。
  const handleNumberInputChange = (text: string) => {
    setNumberText(text);
  };

  // #65 問題7: 数値入力はonBlurで確定する。
  const commitNumberInput = () => {
    const parsed = parseInt(numberText, 10);
    const ms = clampDisplayInterval(
      Number.isNaN(parsed) ? DEFAULT_DISPLAY_INTERVAL : parsed * 1000,
    );
    setDisplayInterval(ms);
    setNumberText(String(ms / 1000));
    onIntervalChange?.(ms);
    persistImmediately(ms);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-white/70">{t('displayIntervalTitle')}</h3>
        <p className="text-xs text-white/50 mt-1">{t('displayIntervalDescription')}</p>
      </div>
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={MIN_DISPLAY_INTERVAL}
          max={MAX_DISPLAY_INTERVAL}
          value={displayInterval / 1000}
          onChange={(e) => handleSliderChange(parseInt(e.target.value, 10))}
          className="flex-1 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white/60"
        />
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MIN_DISPLAY_INTERVAL}
            max={MAX_DISPLAY_INTERVAL}
            value={numberText}
            onChange={(e) => handleNumberInputChange(e.target.value)}
            onBlur={commitNumberInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            className="w-14 px-2 py-1 bg-black/40 text-white/60 rounded border border-white/8 text-center text-sm focus:outline-none focus:border-white/20"
          />
          {/* #66レビュー2巡目nit: /30→/50（他の説明/補助テキストと同じ濃さに統一）。 */}
          <span className="text-white/50 text-sm">{t('secondsUnitOnly')}</span>
        </div>
      </div>
    </div>
  );
}
