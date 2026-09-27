// スライドショー設定
export const DEFAULT_DISPLAY_INTERVAL = 10000; // ミリ秒
export const MIN_DISPLAY_INTERVAL = 5; // 秒
export const MAX_DISPLAY_INTERVAL = 60; // 秒

/**
 * 表示間隔（ミリ秒）を許容範囲へ丸める（#65 問題7）。
 *
 * 保存済み設定の破損・parseInt失敗によるNaN/0が渡ってきても、即時発火ループ
 * （0msタイマーで全件を一瞬でカウントし尽くす）にならないよう、ここを唯一の
 * 検証経路にする（`IntervalSection`・起動シーケンス・`useSlideshow` の全てが
 * これを通す）。
 */
export function clampDisplayInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_DISPLAY_INTERVAL;
  const clampedSeconds = Math.min(MAX_DISPLAY_INTERVAL, Math.max(MIN_DISPLAY_INTERVAL, ms / 1000));
  return Math.round(clampedSeconds) * 1000;
}

// アニメーション
export const MODAL_ANIMATION_DURATION = 0.2; // 秒
