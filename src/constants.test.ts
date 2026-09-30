import { describe, it, expect } from 'vitest';
import {
  clampDisplayInterval,
  DEFAULT_DISPLAY_INTERVAL,
  DEFAULT_VIDEO_MAX_DURATION_SEC,
  VIDEO_MAX_DURATION_OPTIONS_SEC,
  idleFadeClassName,
  normalizeVideoMaxDuration,
  parseVideoAudioEnabled,
  parseVideoMaxDuration,
} from './constants';

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

// #66 問題10: 右上の常設ボタン列・オーバーレイの両方がidle時にフェードアウトする
// 共通クラスを組み立てるヘルパー。opacity/pointer-eventsの対がidle状態に応じて
// 正しく入れ替わり、`:focus-visible`時の可視化クラスは常に含まれることを固定する。
// #66レビューmust2(a): 以前は`focus-within`（マウスクリックの残留フォーカスにも
// 反応する）だったが、`has-[:focus-visible]`（実際にキーボード操作等で
// フォーカスされた場合だけ真になる）に変更した。
describe('idleFadeClassName (#66 問題10, #66レビューmust2)', () => {
  it('hides (opacity-0, pointer-events-none) when idle', () => {
    const className = idleFadeClassName(true);
    expect(className).toContain('opacity-0');
    expect(className).toContain('pointer-events-none');
  });

  it('shows (opacity-100, pointer-events-auto) when not idle, and never opacity-0', () => {
    const className = idleFadeClassName(false);
    expect(className).toContain('opacity-100');
    expect(className).toContain('pointer-events-auto');
    expect(className).not.toContain('opacity-0');
  });

  it('always includes has-[:focus-visible] escape hatches regardless of idle state', () => {
    expect(idleFadeClassName(true)).toContain('has-[:focus-visible]:opacity-100');
    expect(idleFadeClassName(false)).toContain('has-[:focus-visible]:opacity-100');
  });

  it('does not use the old focus-within variant (residual mouse-click focus must not keep it visible)', () => {
    expect(idleFadeClassName(true)).not.toContain('focus-within');
    expect(idleFadeClassName(false)).not.toContain('focus-within');
  });
});

// #68: 動画設定の検証関数。保存値の破損（NaN・負数・選択肢外・小数）で
// 「1秒で次へ進み続ける」ような事故にならないよう、既定（無制限）へ丸める。
describe('normalizeVideoMaxDuration (#68)', () => {
  it('keeps every offered option unchanged (including 0 = unlimited)', () => {
    for (const sec of VIDEO_MAX_DURATION_OPTIONS_SEC) {
      expect(normalizeVideoMaxDuration(sec)).toBe(sec);
    }
  });

  it('defaults to unlimited (0) and offers 30/60/120 among the options', () => {
    expect(DEFAULT_VIDEO_MAX_DURATION_SEC).toBe(0);
    expect(VIDEO_MAX_DURATION_OPTIONS_SEC).toEqual(expect.arrayContaining([0, 30, 60, 120]));
  });

  it('rounds values not in the option list to the default (boundaries around 30)', () => {
    expect(normalizeVideoMaxDuration(29)).toBe(0);
    expect(normalizeVideoMaxDuration(31)).toBe(0);
    expect(normalizeVideoMaxDuration(1)).toBe(0);
  });

  it('rounds negative, fractional, NaN and Infinity to the default', () => {
    expect(normalizeVideoMaxDuration(-30)).toBe(0);
    expect(normalizeVideoMaxDuration(30.5)).toBe(0);
    expect(normalizeVideoMaxDuration(NaN)).toBe(0);
    expect(normalizeVideoMaxDuration(Infinity)).toBe(0);
  });
});

describe('parseVideoMaxDuration (#68)', () => {
  it('parses stored option values', () => {
    expect(parseVideoMaxDuration('0')).toBe(0);
    expect(parseVideoMaxDuration('30')).toBe(30);
    expect(parseVideoMaxDuration('120')).toBe(120);
  });

  it('falls back to the default for missing or corrupt values', () => {
    expect(parseVideoMaxDuration(null)).toBe(0);
    expect(parseVideoMaxDuration(undefined)).toBe(0);
    expect(parseVideoMaxDuration('')).toBe(0);
    expect(parseVideoMaxDuration('abc')).toBe(0);
    expect(parseVideoMaxDuration('-30')).toBe(0);
    expect(parseVideoMaxDuration('30.5')).toBe(0);
    expect(parseVideoMaxDuration('45')).toBe(0);
    expect(parseVideoMaxDuration('NaN')).toBe(0);
  });
});

describe('parseVideoAudioEnabled (#68)', () => {
  it('restores "true"/"false" exactly', () => {
    expect(parseVideoAudioEnabled('true')).toBe(true);
    expect(parseVideoAudioEnabled('false')).toBe(false);
  });

  it('defaults to OFF for missing or corrupt values', () => {
    expect(parseVideoAudioEnabled(null)).toBe(false);
    expect(parseVideoAudioEnabled(undefined)).toBe(false);
    expect(parseVideoAudioEnabled('')).toBe(false);
    expect(parseVideoAudioEnabled('1')).toBe(false);
    expect(parseVideoAudioEnabled('TRUE')).toBe(false);
  });
});
