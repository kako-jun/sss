import { describe, expect, it } from 'vitest';
import { expectedWheelNavigations } from './wheel-expect.js';
import { createWheelNavigator, WHEEL_QUIET_MS } from '../src/lib/photoGestures';

/** 実装（createWheelNavigator）に同じ到達時刻列を流したときの移動回数。 */
function simulate(stamps: number[]) {
  const nav = createWheelNavigator();
  return stamps.filter((t) => nav(0, 100, 0, t) !== null).length;
}

describe('expectedWheelNavigations (e2e の期待値計算が実装と一致する)', () => {
  const cases: Record<string, number[]> = {
    empty: [],
    single: [1000],
    'burst within window': [1000, 1050, 1060],
    'split by load (gap >= 200ms)': [1000, 1050, 1300],
    'split into three': [1000, 1250, 1500],
    'gap just under window': [1000, 1000 + WHEEL_QUIET_MS - 1, 1000 + 2 * (WHEEL_QUIET_MS - 1)],
    'gap exactly at window': [1000, 1000 + WHEEL_QUIET_MS],
  };
  for (const [name, stamps] of Object.entries(cases)) {
    it(name, () => {
      expect(expectedWheelNavigations(stamps, WHEEL_QUIET_MS)).toBe(simulate(stamps));
    });
  }
  it('known values', () => {
    expect(expectedWheelNavigations([1000, 1050, 1060])).toBe(1);
    expect(expectedWheelNavigations([1000, 1050, 1300])).toBe(2);
    expect(expectedWheelNavigations([])).toBe(0);
  });
});
