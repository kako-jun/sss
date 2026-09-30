import { describe, it, expect } from 'vitest';
import {
  EVEN_SPREAD_MAX,
  FILE_COUNT_INCRS,
  chartXRange,
  chartYRange,
  formatCompact,
  integerTicks,
  percentOf,
  spreadOf,
} from './displayCountChart';

describe('chartXRange (#67)', () => {
  it('pads a wide range by half a slot on each side', () => {
    expect(chartXRange(0, 9)).toEqual([-0.5, 9.5]);
  });

  it('widens a single-bin range symmetrically so the bar does not fill the chart', () => {
    const [lo, hi] = chartXRange(5, 5);
    expect(hi - lo).toBeGreaterThanOrEqual(6);
    expect((lo + hi) / 2).toBe(5);
  });

  it('never extends left of zero (counts cannot be negative); the surplus goes right', () => {
    const [lo, hi] = chartXRange(0, 1);
    expect(lo).toBe(-0.5);
    expect(hi - lo).toBeGreaterThanOrEqual(6);
  });
});

describe('integerTicks (#67)', () => {
  it('lists every integer for a narrow range and skips negatives', () => {
    expect(integerTicks(-0.5, 4.5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('thins a wide range to round steps with at most the max tick count', () => {
    const ticks = integerTicks(-0.5, 103.5, 10);
    expect(ticks.length).toBeLessThanOrEqual(11);
    expect(ticks.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    expect(ticks[1] - ticks[0]).toBe(20);
  });

  it('is empty when the range holds no integer', () => {
    expect(integerTicks(0.2, 0.8)).toEqual([]);
  });
});

describe('chart numbers (#67)', () => {
  it('always starts the Y range at zero and keeps a floor for tiny data', () => {
    expect(chartYRange(100)).toEqual([0, 108]);
    expect(chartYRange(0)).toEqual([0, 1]);
  });

  it('spreadOf is max minus min and EVEN_SPREAD_MAX treats a gap of 1 as even', () => {
    expect(spreadOf({ min: 2, max: 3 })).toBe(1);
    expect(spreadOf({ min: 2, max: 3 })).toBeLessThanOrEqual(EVEN_SPREAD_MAX);
    expect(spreadOf({ min: 0, max: 5 })).toBeGreaterThan(EVEN_SPREAD_MAX);
  });

  it('percentOf rounds to one decimal and guards a zero denominator', () => {
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(5, 0)).toBe(0);
  });

  it('formatCompact shortens large counts per locale', () => {
    expect(formatCompact(12_500, 'en')).toBe('12.5K');
    expect(formatCompact(500, 'en')).toBe('500');
  });
});

describe('chartXRange edges (#67)', () => {
  it('keeps a lone zero-count bin at the left edge with the surplus on the right', () => {
    expect(chartXRange(0, 0)).toEqual([-0.5, 5.5]);
  });

  it('centres a lone high-count bin', () => {
    expect(chartXRange(10, 10)).toEqual([7, 13]);
  });

  it('adds no extra padding when the range already spans the minimum slots', () => {
    expect(chartXRange(0, 5)).toEqual([-0.5, 5.5]);
  });

  it('tops a slightly narrow range up to the minimum slots without going below zero', () => {
    expect(chartXRange(0, 4)).toEqual([-0.5, 5.5]);
  });
});

describe('integerTicks edges (#67)', () => {
  it('keeps every integer at exactly the max tick count', () => {
    expect(integerTicks(-0.5, 10.5)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('switches to a step of 2 as soon as the span exceeds the max tick count', () => {
    expect(integerTicks(-0.5, 11.5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('returns a single tick when the range covers one integer', () => {
    expect(integerTicks(2.5, 3.5)).toEqual([3]);
  });

  it('is empty when the whole range is negative', () => {
    expect(integerTicks(-5, -1)).toEqual([]);
  });
});

describe('chart numbers edges (#67)', () => {
  it('spreadOf is 0 when every file has the same count', () => {
    expect(spreadOf({ min: 4, max: 4 })).toBe(0);
  });

  it('chartYRange rounds the headroom up to a whole file', () => {
    expect(chartYRange(1)).toEqual([0, 2]);
  });

  it('percentOf returns 100 for the whole and treats a negative denominator as zero', () => {
    expect(percentOf(7, 7)).toBe(100);
    expect(percentOf(3, -1)).toBe(0);
  });

  it('percentOf returns 0 for zero files of a positive total', () => {
    expect(percentOf(0, 10)).toBe(0);
  });

  it('formatCompact uses the locale-specific unit for Japanese', () => {
    expect(formatCompact(15_000, 'ja')).toBe('1.5万');
  });

  it('formatCompact shortens millions in English', () => {
    expect(formatCompact(1_200_000, 'en')).toBe('1.2M');
  });

  it('FILE_COUNT_INCRS is strictly ascending and integer-only (no fractional Y ticks)', () => {
    expect(FILE_COUNT_INCRS.every((n) => Number.isInteger(n))).toBe(true);
    expect(FILE_COUNT_INCRS.every((n, i) => i === 0 || n > FILE_COUNT_INCRS[i - 1])).toBe(true);
    expect(FILE_COUNT_INCRS[0]).toBe(1);
  });
});
