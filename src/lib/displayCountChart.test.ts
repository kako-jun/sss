import { describe, it, expect } from 'vitest';
import {
  EVEN_SPREAD_MAX,
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
