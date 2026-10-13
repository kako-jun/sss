import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Translate } from '../lib/i18n';

/**
 * #80: ロケール変更（起動時の初期化含む）に追従して html lang 属性とネイティブ
 * ウィンドウタイトルを更新する。切替の即時反映（タイトル・lang 属性込み）を保証する。
 */
export function useLocaleSync(locale: string, t: Translate): void {
  useEffect(() => {
    document.documentElement.lang = locale;
    getCurrentWindow()
      .setTitle(t('windowTitle'))
      .catch((err) => console.error('Failed to set window title:', err));
  }, [locale, t]);
}
