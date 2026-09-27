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
