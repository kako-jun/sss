import { ja } from './dictionaries/ja';
import { en } from './dictionaries/en';
import { getLocale, type Locale } from './store';

export type MessageKey = keyof typeof en;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { ja, en };

/**
 * キーを現在のロケールの文言に変換する（軽量な自前 t()、#80）。
 *
 * Reactコンポーネント外（`src/lib/startup.ts`・`src/lib/tauri.ts` 等）からも
 * 呼べる素の関数。コンポーネント内でロケール変更に追従して再レンダーしたい
 * 場合は `useT()`（`useT.ts`）を使う。
 *
 * `params` の `{key}` プレースホルダを置換する。未知キーは開発時に気づける
 * よう、キー名自体をそのまま返す（辞書に無いキーを参照した場合の目印）。
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = dictionaries[getLocale()][key] ?? dictionaries.en[key] ?? key;
  if (!params) return template;
  // `String.prototype.replaceAll` はビルドターゲット（Safari 13等）で使えないため
  // split+join で代用する（tsconfig の lib/targetを上げない）。
  return Object.entries(params).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    template,
  );
}
