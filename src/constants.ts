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

/**
 * idle（マウス非操作）時にフェードアウトする要素の共通クラス（#66）。
 * オーバーレイUIと右上の常設ボタン（終了・ウィンドウモード・設定・ショートカット）の
 * 両方に使う。`focus-within:opacity-100`により、キーボードでTab移動して内部の
 * ボタンにフォーカスが当たっている間は idle 判定に関わらず可視化する
 * （フォーカスされたのに見えない、というa11y上の欠陥を避けるため）。
 */
export const IDLE_FADE_BASE =
  'transition-opacity duration-300 focus-within:opacity-100 focus-within:pointer-events-auto';
export const IDLE_FADE_HIDDEN = 'opacity-0 pointer-events-none';
export const IDLE_FADE_VISIBLE = 'opacity-100 pointer-events-auto';

/** `IDLE_FADE_*` をまとめて組み立てるヘルパー。 */
export function idleFadeClassName(isIdle: boolean): string {
  return `${IDLE_FADE_BASE} ${isIdle ? IDLE_FADE_HIDDEN : IDLE_FADE_VISIBLE}`;
}
