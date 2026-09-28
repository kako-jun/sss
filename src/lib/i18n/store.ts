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
// #82レビューshould3: OSロケール（`get_os_locale`、sys-localeクレート経由）で
// 解決できた結果のキャッシュ。navigator.languageより優先する（macOSのWKWebViewは
// CFBundleLocalizationsが無いとnavigator.languageがen-US固定になる既知の制約が
// あるため）。取得できていない/失敗した間はnullのままnavigator.languageを使う。
let cachedOsLocale: Locale | null = null;
// #82レビューshould2: 起動直後（initLocale完了前）の最初のレンダーから、決め打ちの
// 'ja'でなくnavigator.languageベースの推定値を使う（英語OS環境で初回フレームだけ
// 必ず日本語になっていた問題の修正）。
let locale: Locale = resolveLocale('auto');
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
 * #82レビュー2巡目nit: 生のロケールタグ（`navigator.language`の`ja-JP`形式、
 * OSロケール取得コマンドの`ja_JP.UTF-8`/`ja`/`C`/空文字/`zh-Hant-TW`形式など）を
 * 'ja'|'en' へ正規化する。`ja`で始まっていても直後が区切り文字（`-`/`_`/`.`/`@`）
 * か文字列終端でなければ別言語（例: ジャマイカ・クレオール英語の`jam`）として
 * 扱う。それ以外はすべて既定で'en'。navigator側・OS側の両方でこの関数を使う
 * ことで、区切り文字の流儀（`-` vs `_`）が違っても同じ判定基準になる。
 */
export function normalizeLocaleTag(tag: string | null | undefined): Locale {
  if (!tag) return 'en';
  return /^ja([-_.@]|$)/i.test(tag) ? 'ja' : 'en';
}

/** `navigator.language` を見て 'auto' を実際のロケールへ解決する。 */
function detectNavigatorLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return normalizeLocaleTag(navigator.language);
}

/**
 * `setting` から実際のロケールを求める（テスト・設定画面のプレビュー用に公開）。
 * 'auto' の解決は `cachedOsLocale`（`initLocale` がOSロケールを取得できていれば
 * 設定済み）を優先し、無ければ `navigator.language` にフォールバックする。
 */
export function resolveLocale(setting: LanguageSetting): Locale {
  if (setting === 'ja' || setting === 'en') return setting;
  return cachedOsLocale ?? detectNavigatorLocale();
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
 * テスト専用: `cachedOsLocale` をリセットする。モジュール状態がテスト間で
 * 漏れないよう `src/test/setup.ts` の `beforeEach` から呼ぶ。
 */
export function clearOsLocaleCache(): void {
  cachedOsLocale = null;
}

/**
 * アプリ起動時、保存済みの `app_settings.language` を読み込んでストアを初期化する。
 * 保存値が無い/不正な場合は 'auto' として扱う。
 *
 * #82レビューmust: `getSetting` が reject しても起動シーケンスを止めないよう、
 * ここで確実に例外を吸収し 'auto' へフォールバックする（このPromiseは
 * 正常系・異常系のどちらでも必ずresolveする。呼び出し元の `App.tsx` はこの
 * `.then()` の中で起動シーケンス本体を走らせているため、ここで reject すると
 * アプリが起動画面のまま永久に止まっていた）。
 *
 * `getOsLocale` は任意（#82レビューshould3）。渡された場合、**保存された設定値に
 * かかわらず常に**OSロケールの取得を試み、成功すれば `cachedOsLocale` を更新する
 * （#82レビュー2巡目should2: 以前は保存値が`auto`の時だけ取得していたため、
 * `ja`/`en`を明示保存している間はキャッシュが空のままで、後から設定画面で
 * 「自動」に切り替えた瞬間は`navigator.language`ベースの解決にしかならず、
 * OSロケールへ切り替わるにはアプリの再起動が要った。起動時に常に取得して
 * おけば、後から`auto`を選んだ直後からOSロケールで解決される）。取得に失敗
 * しても無視して `navigator.language` ベースの解決のまま進む（起動を止めない）。
 */
export async function initLocale(
  getSetting: (key: string) => Promise<string | null>,
  getOsLocale?: () => Promise<string | null>,
): Promise<void> {
  let setting: LanguageSetting = 'auto';
  try {
    const saved = await getSetting('language');
    setting = saved === 'ja' || saved === 'en' ? saved : 'auto';
  } catch (err) {
    console.error('Failed to load the language setting, falling back to "auto":', err);
    setting = 'auto';
  }

  if (getOsLocale) {
    try {
      const osLocale = await getOsLocale();
      if (osLocale) {
        cachedOsLocale = normalizeLocaleTag(osLocale);
      }
    } catch (err) {
      console.error('Failed to detect the OS locale, falling back to navigator.language:', err);
    }
  }

  setLanguageSetting(setting);
}
