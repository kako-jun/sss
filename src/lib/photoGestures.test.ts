import { describe, it, expect } from 'vitest';
import {
  createClickDebouncer,
  createWheelNavigator,
  CLICK_DEBOUNCE_MS,
  WHEEL_QUIET_MS,
  WHEEL_THRESHOLD_PX,
} from './photoGestures';

describe('createClickDebouncer', () => {
  it('最初のクリックは受理し、間隔内の連打は無視する', () => {
    const accept = createClickDebouncer();
    expect(accept(1000)).toBe(true);
    expect(accept(1000 + CLICK_DEBOUNCE_MS - 1)).toBe(false);
  });

  it('間隔が空けば再び受理する（無視したクリックは間隔の起点にしない）', () => {
    const accept = createClickDebouncer();
    expect(accept(1000)).toBe(true);
    expect(accept(1200)).toBe(false);
    expect(accept(1000 + CLICK_DEBOUNCE_MS)).toBe(true);
  });
});

describe('createWheelNavigator', () => {
  it('マウスホイール1ノッチ（下=100px）で「次」、上で「前」', () => {
    const nav = createWheelNavigator();
    expect(nav(0, 100, 0, 1000)).toBe('next');
    // 十分な間隔（quiet超え）を空ければ次の操作として再び受理される
    expect(nav(0, -100, 0, 1000 + WHEEL_QUIET_MS + 1)).toBe('previous');
  });

  it('行モード（Firefox等）の1ノッチ（3行=48px）でも発火する', () => {
    const nav = createWheelNavigator();
    expect(nav(0, 3, 1, 1000)).toBe('next');
  });

  it('横スワイプ（縦より横が大きい）は横軸で判定する。左スワイプ(deltaX>0)=次', () => {
    const nav = createWheelNavigator();
    expect(nav(80, 5, 0, 1000)).toBe('next');
    expect(nav(-80, 5, 0, 1000 + WHEEL_QUIET_MS + 1)).toBe('previous');
  });

  it('トラックパッドの小さなイベントは閾値まで累積してから1回だけ発火する', () => {
    const nav = createWheelNavigator();
    let t = 1000;
    const fired: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      fired.push(nav(0, WHEEL_THRESHOLD_PX / 4, 0, t));
      t += 16;
    }
    expect(fired).toEqual([null, null, null, 'next']);
  });

  it('慣性スクロール（発火後も途切れず届くイベント）では連続発火しない', () => {
    const nav = createWheelNavigator();
    let t = 1000;
    const results: Array<string | null> = [];
    for (let i = 0; i < 60; i++) {
      results.push(nav(0, 30, 0, t));
      t += 16; // 約1秒の慣性
    }
    expect(results.filter((r) => r !== null)).toEqual(['next']);
  });

  it('慣性が途切れた（quiet経過）後の新しい操作は受理される', () => {
    const nav = createWheelNavigator();
    expect(nav(0, 100, 0, 1000)).toBe('next');
    expect(nav(0, 100, 0, 1050)).toBeNull(); // ロック中
    expect(nav(0, 100, 0, 1050 + WHEEL_QUIET_MS)).toBe('next');
  });

  it('途中で向きが変わったら逆向きの累積を持ち越さない', () => {
    const nav = createWheelNavigator();
    expect(nav(0, 30, 0, 1000)).toBeNull();
    expect(nav(0, -30, 0, 1016)).toBeNull(); // 累積がリセットされ -30 から
    expect(nav(0, -30, 0, 1032)).toBe('previous');
  });

  it('delta が 0 や NaN のイベントは無視する', () => {
    const nav = createWheelNavigator();
    expect(nav(0, 0, 0, 1000)).toBeNull();
    expect(nav(0, NaN, 0, 1016)).toBeNull();
  });
});
