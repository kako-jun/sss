// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveLocale,
  setLanguageSetting,
  getLocale,
  getLanguageSetting,
  subscribeLocale,
  initLocale,
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
