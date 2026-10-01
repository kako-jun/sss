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

// 動画設定（#68）
export const SETTING_VIDEO_AUDIO_ENABLED = 'video_audio_enabled';
export const SETTING_VIDEO_MAX_DURATION_SEC = 'video_max_duration_sec';
/** 動画の音声は既定でOFF（無音のまま次々に流れる、これまでの挙動を維持する）。 */
export const DEFAULT_VIDEO_AUDIO_ENABLED = false;
/** 動画の最大再生時間の既定。0 = 無制限（動画の長さ分そのまま再生する）。 */
export const DEFAULT_VIDEO_MAX_DURATION_SEC = 0;
/** 設定UIに出す選択肢（秒）。0 = 無制限。 */
export const VIDEO_MAX_DURATION_OPTIONS_SEC: readonly number[] = [0, 30, 60, 120, 300];

/**
 * 動画の最大再生時間（秒）を許容値へ丸める（#68）。
 *
 * 選択肢に無い値・NaN・負数・小数が保存値の破損等で入ってきても、意図しない
 * 短い上限（例: 1秒で次へ進み続けて全件を一瞬で消化する）にならないよう、
 * 選択肢に完全一致する場合以外は既定（無制限）に戻す。`clampDisplayInterval`
 * （#65）と同じく、ここを唯一の検証経路にする。
 */
export function normalizeVideoMaxDuration(sec: number): number {
  return VIDEO_MAX_DURATION_OPTIONS_SEC.includes(sec) ? sec : DEFAULT_VIDEO_MAX_DURATION_SEC;
}

/** 保存済みの文字列（`app_settings`）から動画音声ON/OFFを復元する。未設定・破損は既定。 */
export function parseVideoAudioEnabled(value: string | null | undefined): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return DEFAULT_VIDEO_AUDIO_ENABLED;
}

/** 保存済みの文字列から動画の最大再生時間（秒）を復元する。未設定・破損は既定（無制限）。 */
export function parseVideoMaxDuration(value: string | null | undefined): number {
  if (value == null || !/^\d+$/.test(value.trim())) return DEFAULT_VIDEO_MAX_DURATION_SEC;
  return normalizeVideoMaxDuration(parseInt(value, 10));
}

// アニメーション
export const MODAL_ANIMATION_DURATION = 0.2; // 秒

/**
 * idle（マウス非操作）時にフェードアウトする要素の共通クラス（#66）。
 * オーバーレイUIと右上の常設ボタン（終了・ウィンドウモード・設定・ショートカット）の
 * 両方に使う。
 *
 * `has-[:focus-visible]:opacity-100`により、キーボードで実際にTab移動して内部の
 * ボタンにフォーカスが当たっている間は idle 判定に関わらず可視化する
 * （フォーカスされたのに見えない、というa11y上の欠陥を避けるため）。
 *
 * #66レビューmust2: 以前は`focus-within`（マウスクリックによる残留フォーカスにも
 * 反応する）を使っていたため、ボタンをマウスでクリックしただけでその後ずっと
 * idle時にバーが消えなくなる不具合があった（実ブラウザで再現確認済み）。
 * `:focus-visible`はブラウザが「キーボード操作等で意図的にフォーカスされた」と
 * 判定した場合だけ真になり、クリック直後の残留フォーカスでは真にならないため、
 * `has-[:focus-visible]`にすることでこの誤検知を避ける。
 */
export const IDLE_FADE_BASE =
  'transition-opacity duration-300 has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto';
export const IDLE_FADE_HIDDEN = 'opacity-0 pointer-events-none';
export const IDLE_FADE_VISIBLE = 'opacity-100 pointer-events-auto';

/** `IDLE_FADE_*` をまとめて組み立てるヘルパー。 */
export function idleFadeClassName(isIdle: boolean): string {
  return `${IDLE_FADE_BASE} ${isIdle ? IDLE_FADE_HIDDEN : IDLE_FADE_VISIBLE}`;
}

/**
 * 画像/動画の読込完了も失敗も来ない時に、強制的に次へ進むまでの待ち時間（ミリ秒、#120）。
 * `max(表示間隔, 下限)`。下限は既定10秒で、e2e だけが `VITE_MEDIA_WATCHDOG_MIN_MS`
 * （vite の環境変数）で短縮できる（実時間で見張りを検証するため）。
 */
export function mediaWatchdogMs(intervalMs: number): number {
  const floor = Number(import.meta.env.VITE_MEDIA_WATCHDOG_MIN_MS) || 10_000;
  return Math.max(intervalMs, floor);
}
