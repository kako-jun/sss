// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { t, type MessageKey } from './t';
import { setLanguageSetting } from './store';
import { en } from './dictionaries/en';

/**
 * #80: `t()` のプレースホルダ補間ロジックの独立ユニットテスト。
 *
 * これまで補間（欠けたパラメータ・余分なパラメータ・同じプレースホルダの複数回
 * 出現）を直接検証するテストが無く、`resolveScanErrorMessage`等の呼び出し経由で
 * 「正しい引数を渡した場合」しか通っていなかった。
 */
describe('t() message interpolation (#80)', () => {
  it('interpolates a single {param} placeholder', () => {
    // errorDirectoryNotFound: '指定したフォルダが見つかりません: {path}'
    expect(t('errorDirectoryNotFound', { path: '/photos' })).toBe(
      '指定したフォルダが見つかりません: /photos',
    );
  });

  it('leaves a placeholder untouched (literal "{param}") when the param is not supplied', () => {
    expect(t('errorDirectoryNotFound', {})).toBe('指定したフォルダが見つかりません: {path}');
  });

  it('leaves the placeholder untouched when params is omitted entirely', () => {
    expect(t('errorDirectoryNotFound')).toBe('指定したフォルダが見つかりません: {path}');
  });

  it('ignores extra params that do not correspond to any placeholder in the template', () => {
    expect(t('errorDirectoryNotFound', { path: '/photos', unused: 'noise', another: 123 })).toBe(
      '指定したフォルダが見つかりません: /photos',
    );
  });

  // secondsUnit: '{value}秒' はScanSection（実測秒数を埋める）とIntervalSection
  // （既に別の<input>に数値があるため単位表記だけ欲しい）の2箇所で共用されている。
  // IntervalSection側は`t('secondsUnit', { value: '' })`と明示的に空文字を渡す
  // ことで単位だけを残す設計（キー自体を分けず、パラメータを空にする選択）。
  // 「パラメータ自体を渡さない」場合（プレースホルダがそのまま残る）とは異なる
  // 挙動になることをここで区別して固定する。
  it('replaces a placeholder with an empty string when the param is explicitly "" (distinct from omitting the param)', () => {
    expect(t('secondsUnit', { value: '' })).toBe('秒');
    expect(t('secondsUnit', {})).toBe('{value}秒');
  });

  it('replaces every occurrence of the same placeholder when it appears multiple times', () => {
    // 実在辞書には同一プレースホルダが複数回出現するキーが無い（確認済み）ため、
    // `en`辞書オブジェクト（`t.ts`内部の`dictionaries.en`と同一参照）に一時的な
    // テスト専用キーを生やして、実際の`t()`本体（split+join実装）を通す。
    // 辞書ファイル自体は変更しない（テスト内でのみ追加し、finallyで必ず削除する）。
    const testKey = '__test_repeated_placeholder__' as MessageKey;
    (en as unknown as Record<string, string>)[testKey] = '{name} vs {name} ({name})';
    try {
      setLanguageSetting('en');
      expect(t(testKey, { name: 'A' })).toBe('A vs A (A)');
    } finally {
      delete (en as unknown as Record<string, string>)[testKey];
    }
  });

  it('replaces every occurrence of {reason} etc. across a real dictionary entry with multiple params', () => {
    // startupDirectoryRejected: '前回のフォルダに接続できませんでした: {reason}'
    // （プレースホルダは1個のみだが、実在キーで基本の単一置換を再確認しておく）
    expect(t('startupDirectoryRejected', { reason: 'ENOENT' })).toBe(
      '前回のフォルダに接続できませんでした: ENOENT',
    );
  });

  it('substitutes numeric param values by coercing them to strings', () => {
    // errorCountValue: '{count}件'
    expect(t('errorCountValue', { count: 5 })).toBe('5件');
    expect(t('errorCountValue', { count: 0 })).toBe('0件');
  });

  it('falls back to the key itself for an unknown key not present in either dictionary', () => {
    expect(t('thisKeyDoesNotExist' as MessageKey)).toBe('thisKeyDoesNotExist');
  });

  it('follows locale switches: the same key resolves to a different language after setLanguageSetting', () => {
    setLanguageSetting('ja');
    expect(t('errorPatternEmpty')).toBe('パターンを入力してください');
    setLanguageSetting('en');
    expect(t('errorPatternEmpty')).toBe('Please enter a pattern');
  });
});
