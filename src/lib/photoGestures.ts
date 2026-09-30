/**
 * 写真上のマウス操作（#78）の判定ロジック。Reactから切り離した純粋な状態機械にして
 * 単体テストできるようにする。
 *
 * - クリック: 一時停止/再開のトグル。ダブルクリック等の連打で「押した覚えのない状態」に
 *   ならないよう、直前の受理から一定時間内のクリックは無視する。
 * - ホイール/トラックパッド横スワイプ: 前/次。マウスホイールは1ノッチ、トラックパッドは
 *   慣性で大量の小さなイベントが連続して届くため、
 *   (1) 移動量を累積して閾値を超えた時だけ1回発火し、
 *   (2) 発火後は「一定時間イベントが途切れる」までロックして連続発火（慣性・回しっぱなし）を抑える。
 */

export type WheelDirection = 'next' | 'previous';

/** クリックの再受理までの最短間隔（ms）。ダブルクリック（通常500ms以内）を1回に畳む。 */
export const CLICK_DEBOUNCE_MS = 350;
/** ホイール1回の発火に要する累積移動量（px換算）。マウスホイール1ノッチ（Firefoxの行モードでも48px）で超える値。 */
export const WHEEL_THRESHOLD_PX = 40;
/** この時間イベントが途切れたら「別の操作」とみなしロック・累積を解く（ms）。 */
export const WHEEL_QUIET_MS = 200;

/** `WheelEvent.deltaMode` を px 相当へ換算する係数（0=px, 1=行, 2=ページ）。 */
function deltaScale(mode: number): number {
  if (mode === 1) return 16;
  if (mode === 2) return 100;
  return 1;
}

/** 直前に受理した時刻から `debounceMs` 未満のクリックは `false`（無視）を返す。 */
export function createClickDebouncer(debounceMs: number = CLICK_DEBOUNCE_MS) {
  let last = -Infinity;
  return (now: number): boolean => {
    if (now - last < debounceMs) return false;
    last = now;
    return true;
  };
}

/**
 * ホイールイベントを前/次の操作へ変換する。戻り値が `null` なら何もしない。
 * 縦横のうち絶対値の大きい方の軸で判定する（下スクロール/左スワイプ＝次、
 * 上スクロール/右スワイプ＝前）。
 */
export function createWheelNavigator(
  thresholdPx: number = WHEEL_THRESHOLD_PX,
  quietMs: number = WHEEL_QUIET_MS,
) {
  let accumulated = 0;
  let lastEventAt = -Infinity;
  let locked = false;

  return (
    deltaX: number,
    deltaY: number,
    deltaMode: number,
    now: number,
  ): WheelDirection | null => {
    if (now - lastEventAt >= quietMs) {
      accumulated = 0;
      locked = false;
    }
    lastEventAt = now;
    if (locked) return null;

    const scale = deltaScale(deltaMode);
    const delta = (Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY) * scale;
    if (delta === 0 || !Number.isFinite(delta)) return null;

    // 途中で向きが変わったら、逆向きの累積を持ち越さない。
    if (accumulated !== 0 && Math.sign(accumulated) !== Math.sign(delta)) accumulated = 0;
    accumulated += delta;

    if (Math.abs(accumulated) < thresholdPx) return null;
    const direction: WheelDirection = accumulated > 0 ? 'next' : 'previous';
    accumulated = 0;
    locked = true;
    return direction;
  };
}
