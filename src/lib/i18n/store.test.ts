// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveLocale,
  setLanguageSetting,
  getLocale,
  getLanguageSetting,
  subscribeLocale,
  initLocale,
  normalizeLocaleTag,
  clearOsLocaleCache,
} from './store';

/** #80: 言語設定('ja'|'en'|'auto')→実ロケール解決と、購読/初期化ロジックの検証。 */
describe('i18n locale resolution (#80)', () => {
  const originalLanguage = navigator.language;

  function setNavigatorLanguage(value: string) {
    Object.defineProperty(navigator, 'language', { value, configurable: true });
  }

  afterEach(() => {
    setNavigatorLanguage(originalLanguage);
  });

  it('resolves explicit ja/en settings directly regardless of navigator.language', () => {
    setNavigatorLanguage('en-US');
    expect(resolveLocale('ja')).toBe('ja');
    setNavigatorLanguage('ja-JP');
    expect(resolveLocale('en')).toBe('en');
  });

  it('resolves "auto" to ja when navigator.language starts with ja', () => {
    setNavigatorLanguage('ja-JP');
    expect(resolveLocale('auto')).toBe('ja');
    setNavigatorLanguage('ja');
    expect(resolveLocale('auto')).toBe('ja');
  });

  it('resolves "auto" to en for any non-ja navigator.language', () => {
    setNavigatorLanguage('en-US');
    expect(resolveLocale('auto')).toBe('en');
    setNavigatorLanguage('fr-FR');
    expect(resolveLocale('auto')).toBe('en');
  });

  it('resolves "auto" to en when navigator.language is an empty string (falsy, treated as "unset")', () => {
    setNavigatorLanguage('');
    expect(resolveLocale('auto')).toBe('en');
  });

  it('resolves "auto" to en when navigator.language is undefined', () => {
    // `!navigator.language` はundefinedでもtrueになるため、空文字と同じ経路を通る。
    // 実行環境で navigator.language が未設定になるケース（本当に「未設定」）を模す。
    Object.defineProperty(navigator, 'language', { value: undefined, configurable: true });
    expect(resolveLocale('auto')).toBe('en');
  });

  it('is case-insensitive when matching "ja" (e.g. uppercase locale tags)', () => {
    setNavigatorLanguage('JA-JP');
    expect(resolveLocale('auto')).toBe('ja');
  });

  it('setLanguageSetting updates the setting and resolved locale, and notifies subscribers', () => {
    setNavigatorLanguage('en-US');
    let notified = 0;
    const unsubscribe = subscribeLocale(() => {
      notified++;
    });
    setLanguageSetting('ja');
    expect(getLanguageSetting()).toBe('ja');
    expect(getLocale()).toBe('ja');
    expect(notified).toBe(1);
    unsubscribe();
  });

  it('stops notifying a listener after it unsubscribes, without affecting other listeners', () => {
    let notifiedA = 0;
    let notifiedB = 0;
    const unsubscribeA = subscribeLocale(() => {
      notifiedA++;
    });
    const unsubscribeB = subscribeLocale(() => {
      notifiedB++;
    });

    setLanguageSetting('ja');
    expect(notifiedA).toBe(1);
    expect(notifiedB).toBe(1);

    unsubscribeA();
    setLanguageSetting('en');
    // Aは解除済みなので増えない。Bはまだ購読中なので増える。
    expect(notifiedA).toBe(1);
    expect(notifiedB).toBe(2);

    unsubscribeB();
  });

  it('initLocale loads the saved setting via getSetting("language")', async () => {
    setNavigatorLanguage('en-US');
    const getSetting = async (key: string) => (key === 'language' ? 'ja' : null);
    await initLocale(getSetting);
    expect(getLanguageSetting()).toBe('ja');
    expect(getLocale()).toBe('ja');
  });

  it('initLocale falls back to "auto" (then navigator.language) when nothing is saved', async () => {
    setNavigatorLanguage('en-US');
    const getSetting = async () => null;
    await initLocale(getSetting);
    expect(getLanguageSetting()).toBe('auto');
    expect(getLocale()).toBe('en');
  });

  it('initLocale ignores an invalid saved value and falls back to "auto"', async () => {
    setNavigatorLanguage('ja-JP');
    const getSetting = async () => 'fr'; // 想定外の値
    await initLocale(getSetting);
    expect(getLanguageSetting()).toBe('auto');
    expect(getLocale()).toBe('ja');
  });
});

/**
 * #82レビュー2巡目 should2: 保存値が明示的な'ja'/'en'であっても、initLocaleは
 * 常にgetOsLocaleを呼んでcachedOsLocaleを温めておく。以前は保存値が'auto'の
 * 時しか呼んでいなかったため、'ja'/'en'を明示保存している間に設定画面で
 * 「自動」へ切り替えても、その場ではnavigator.languageベースの解決にしか
 * ならず、OSロケールへ切り替えるには再起動が要った。
 */
describe('initLocale keeps the OS locale cache warm for a later switch to "auto" (#82レビュー2巡目 should2)', () => {
  const originalLanguage = navigator.language;

  function setNavigatorLanguage(value: string) {
    Object.defineProperty(navigator, 'language', { value, configurable: true });
  }

  afterEach(() => {
    setNavigatorLanguage(originalLanguage);
    clearOsLocaleCache();
  });

  it('calls getOsLocale even when the saved setting is an explicit "ja" (not "auto")', async () => {
    setNavigatorLanguage('ja-JP'); // navigator側はja。OS側はenを返させ、両者を区別する。
    const getSetting = async (key: string) => (key === 'language' ? 'ja' : null);
    const getOsLocale = vi.fn(async () => 'en-US');

    await initLocale(getSetting, getOsLocale);

    expect(getOsLocale).toHaveBeenCalledTimes(1);
    // 保存値'ja'が優先されるので、現在の表示はまだjaのまま。
    expect(getLanguageSetting()).toBe('ja');
    expect(getLocale()).toBe('ja');

    // ここで再起動せずに「自動」へ切り替えると、キャッシュ済みのOSロケール
    // （en）が即座に反映される（navigator.languageのja-JPではなく）。
    setLanguageSetting('auto');
    expect(getLocale()).toBe('en');
  });

  it('calls getOsLocale even when the saved setting is an explicit "en"', async () => {
    setNavigatorLanguage('en-US');
    const getSetting = async (key: string) => (key === 'language' ? 'en' : null);
    const getOsLocale = vi.fn(async () => 'ja_JP.UTF-8');

    await initLocale(getSetting, getOsLocale);

    expect(getOsLocale).toHaveBeenCalledTimes(1);
    expect(getLocale()).toBe('en'); // 保存値優先

    setLanguageSetting('auto');
    expect(getLocale()).toBe('ja');
  });
});

/**
 * #82レビュー3巡目nit: `getSetting`/`getOsLocale`が（rejectでなく）永久に
 * pendingのまま返ってこない場合、約1秒でタイムアウトしてフォールバックする
 * ことを固定する（以前はreject/例外しか救っておらず、無限pendingだと
 * initLocaleが永久に解決しなかった＝起動シーケンスが呼ばれなかった）。
 */
describe('initLocale times out a hanging getSetting/getOsLocale instead of hanging forever (#82レビュー3巡目 nit)', () => {
  const originalLanguage = navigator.language;

  function setNavigatorLanguage(value: string) {
    Object.defineProperty(navigator, 'language', { value, configurable: true });
  }

  afterEach(() => {
    setNavigatorLanguage(originalLanguage);
    clearOsLocaleCache();
    vi.useRealTimers();
  });

  it('falls back to "auto" when getSetting never resolves nor rejects', async () => {
    vi.useFakeTimers();
    setNavigatorLanguage('ja-JP');
    // 一度もresolve/rejectしない、永久にpendingのままのPromiseを模す。
    const getSetting = () => new Promise<string | null>(() => {});

    const done = initLocale(getSetting);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(getLanguageSetting()).toBe('auto');
    expect(getLocale()).toBe('ja'); // navigator.languageへフォールバック
  });

  it('falls back to navigator.language when getOsLocale never resolves nor rejects', async () => {
    vi.useFakeTimers();
    setNavigatorLanguage('en-US');
    const getSetting = async () => null;
    const getOsLocale = vi.fn(() => new Promise<string | null>(() => {}));

    const done = initLocale(getSetting, getOsLocale);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(getOsLocale).toHaveBeenCalledTimes(1);
    expect(getLanguageSetting()).toBe('auto');
    expect(getLocale()).toBe('en'); // navigator.languageへフォールバック（OSロケール未取得）
  });

  it('does not wait the full timeout when getSetting resolves quickly', async () => {
    vi.useFakeTimers();
    setNavigatorLanguage('en-US');
    const getSetting = async (key: string) => (key === 'language' ? 'ja' : null);

    const done = initLocale(getSetting);
    // タイムアウト(1000ms)より十分前に解決していることを確認する。
    await vi.advanceTimersByTimeAsync(10);
    await done;

    expect(getLanguageSetting()).toBe('ja');
  });
});

/**
 * #82レビュー2巡目 nit: OSロケール取得コマンド・navigator.languageの両方が
 * 返しうる様々な形式のタグを、統一した基準（/^ja([-_.@]|$)/i）で正規化する
 * ことをテーブルテストで固定する。
 */
describe('normalizeLocaleTag table test (#82レビュー2巡目 nit)', () => {
  const cases: Array<[string | null | undefined, 'ja' | 'en']> = [
    ['ja_JP.UTF-8', 'ja'], // Linux/macOSのgetenv形式
    ['ja', 'ja'],
    ['ja-JP', 'ja'], // navigator.language形式
    ['JA-JP', 'ja'], // 大文字小文字を無視
    ['ja@euro', 'ja'], // POSIXロケールのmodifier
    ['C', 'en'], // POSIXの既定（ロケール未設定）
    ['', 'en'],
    ['zh-Hant-TW', 'en'],
    ['jam', 'en'], // ジャマイカ・クレオール英語のISO 639-3コード。「ja」で始まるが別言語
    [null, 'en'],
    [undefined, 'en'],
  ];

  for (const [input, expected] of cases) {
    it(`normalizeLocaleTag(${JSON.stringify(input)}) -> ${expected}`, () => {
      expect(normalizeLocaleTag(input)).toBe(expected);
    });
  }
});
