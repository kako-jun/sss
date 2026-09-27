/**
 * 言語状態のストア（#80）。
 *
 * React外（`src/lib/startup.ts` 等の純粋関数、`src/lib/tauri.ts` のダイアログ
 * title組み立て）からも参照できるよう、Reactに依存しないモジュール変数+
 * 購読者リストで実装する（大きなi18nライブラリを入れないための「軽量な自前」
 * 実装）。Reactからは `useT.ts` の `useSyncExternalStore` 経由で購読する。
 */

export type Locale = 'ja' | 'en';
export type LanguageSetting = Locale | 'auto';

type Listener = () => void;

let languageSetting: LanguageSetting = 'auto';
let locale: Locale = 'ja'; // 起動直後・#80導入前の環境向けの既定値。initLocale()が確定させる。
const listeners = new Set<Listener>();

/** 現在の表示言語（'auto' を解決した後の実際のロケール）。 */
export function getLocale(): Locale {
  return locale;
}

/** 現在の設定値（'ja' | 'en' | 'auto'）。設定画面のUIが選択状態の表示に使う。 */
export function getLanguageSetting(): LanguageSetting {
  return languageSetting;
}

/**
 * `navigator.language` を見て 'auto' を実際のロケールへ解決する。
 * jaで始まる（ja, ja-JP等）ならja、それ以外は既定でen。
 */
function detectNavigatorLocale(): Locale {
  if (typeof navigator === 'undefined' || !navigator.language) return 'en';
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** `setting` から実際のロケールを求める（テスト・設定画面のプレビュー用に公開）。 */
export function resolveLocale(setting: LanguageSetting): Locale {
  if (setting === 'ja' || setting === 'en') return setting;
  return detectNavigatorLocale();
}

/** 購読者に変更を通知しつつ、設定とロケールを更新する。 */
export function setLanguageSetting(setting: LanguageSetting): void {
  languageSetting = setting;
  locale = resolveLocale(setting);
  listeners.forEach((listener) => listener());
}

/** ロケール変更の購読（`useSyncExternalStore` から呼ぶ）。 */
export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * アプリ起動時、保存済みの `app_settings.language` を読み込んでストアを初期化する。
 * 保存値が無い/不正な場合は 'auto' として扱う。
 */
export async function initLocale(
  getSetting: (key: string) => Promise<string | null>,
): Promise<void> {
  const saved = await getSetting('language');
  const setting: LanguageSetting = saved === 'ja' || saved === 'en' ? saved : 'auto';
  setLanguageSetting(setting);
}
