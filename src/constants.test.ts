import { describe, it, expect } from 'vitest';
import { clampDisplayInterval, DEFAULT_DISPLAY_INTERVAL } from './constants';

// #65 問題7: clampDisplayInterval は保存済み設定の破損（NaN/0/範囲外）を丸める唯一の
// 検証経路（IntervalSection・起動シーケンス・useSlideshow が全てこれを通す）。
// 境界値（最小5秒/最大60秒の直前・直後・ちょうど）を直接ピン留めする。
describe('clampDisplayInterval boundaries (#65 問題7)', () => {
  it('clamps just below the minimum (4s) up to the minimum (5s)', () => {
    expect(clampDisplayInterval(4000)).toBe(5000);
  });

  it('leaves exactly the minimum (5s) unchanged', () => {
    expect(clampDisplayInterval(5000)).toBe(5000);
  });

  it('leaves just above the minimum (6s) unchanged', () => {
    expect(clampDisplayInterval(6000)).toBe(6000);
  });

  it('leaves just below the maximum (59s) unchanged', () => {
    expect(clampDisplayInterval(59000)).toBe(59000);
  });

  it('leaves exactly the maximum (60s) unchanged', () => {
    expect(clampDisplayInterval(60000)).toBe(60000);
  });

  it('clamps just above the maximum (61s) down to the maximum (60s)', () => {
    expect(clampDisplayInterval(61000)).toBe(60000);
  });

  it('falls back to the default on NaN', () => {
    expect(clampDisplayInterval(NaN)).toBe(DEFAULT_DISPLAY_INTERVAL);
  });

  it('falls back to the default on NaN produced by parseInt("") (empty string field)', () => {
    // IntervalSection/起動シーケンスの実際の入力経路: 空文字をparseIntするとNaNになる。
    expect(clampDisplayInterval(parseInt('', 10))).toBe(DEFAULT_DISPLAY_INTERVAL);
  });

  it('falls back to the default on +/-Infinity (not finite)', () => {
    expect(clampDisplayInterval(Infinity)).toBe(DEFAULT_DISPLAY_INTERVAL);
    expect(clampDisplayInterval(-Infinity)).toBe(DEFAULT_DISPLAY_INTERVAL);
  });

  it('clamps a negative value up to the minimum', () => {
    expect(clampDisplayInterval(-1000)).toBe(5000);
  });

  it('clamps zero up to the minimum', () => {
    expect(clampDisplayInterval(0)).toBe(5000);
  });
});
