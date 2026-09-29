import type { DisplayStats } from '../types';

/**
 * 統計タブの「表示回数の分布」チャート用の純粋関数（#67）。
 *
 * uPlot のオプション組み立てそのものは jsdom（canvas 無し）では検証できない
 * ため、数値まわり（X範囲・目盛り・ばらつき判定・割合）だけをここへ切り出して
 * 単体テストする。
 */

/** X 軸（表示回数）に最低限確保したいスロット数。1〜2ビンだけのとき棒が画面いっぱいに広がらないよう余白を取る。 */
const MIN_X_SLOTS = 6;

/** 「均等」とみなす最多−最少の差。完全平等ランダムは 1 周ごとに全件が 1 回ずつ出るので、通常は 1 以内に収まる。 */
export const EVEN_SPREAD_MAX = 1;

/** X 軸に出す目盛りの最大数。 */
const MAX_X_TICKS = 10;

/**
 * X 軸（表示回数）の描画範囲。各ビンは整数値の上に立つ棒なので、両端は
 * 半スロット分（±0.5）の余白を持たせる。ビンが少ないときは左右対称に広げるが、
 * 表示回数は 0 未満にならないので左端は -0.5 で止め、余りは右へ回す。
 */
export function chartXRange(min: number, max: number): [number, number] {
  let lo = min - 0.5;
  let hi = max + 0.5;
  const shortfall = MIN_X_SLOTS - (hi - lo);
  if (shortfall > 0) {
    lo -= shortfall / 2;
    hi += shortfall / 2;
    if (lo < -0.5) {
      hi += -0.5 - lo;
      lo = -0.5;
    }
  }
  return [lo, hi];
}

/** 1, 2, 5, 10, 20, 50, ... の「きりの良い」刻み幅のうち、目盛り数が maxTicks 以内になる最小のもの。 */
function niceStep(span: number, maxTicks: number): number {
  let magnitude = 1;
  for (;;) {
    for (const base of [1, 2, 5]) {
      const step = base * magnitude;
      if (span / step <= maxTicks) return step;
    }
    magnitude *= 10;
  }
}

/** X 軸の整数目盛り（0 以上）。範囲が広いときは 2, 5, 10, ... 刻みに間引く。 */
export function integerTicks(lo: number, hi: number, maxTicks = MAX_X_TICKS): number[] {
  const first = Math.max(0, Math.ceil(lo));
  const last = Math.floor(hi);
  if (last < first) return [];
  const step = niceStep(last - first, maxTicks);
  const ticks: number[] = [];
  for (let v = Math.ceil(first / step) * step; v <= last; v += step) ticks.push(v);
  return ticks;
}

/** Y 軸（ファイル数）の目盛り刻みの候補。ファイル数なので小数刻み(0.5 等)は出さない。 */
export const FILE_COUNT_INCRS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000,
  500_000, 1_000_000,
];

/** Y 軸の範囲。棒は 0 から始める（切り詰めない）。最大の棒の上に少し余白を取る。 */
export function chartYRange(maxFiles: number): [number, number] {
  return [0, Math.max(1, Math.ceil(maxFiles * 1.08))];
}

/** 最多表示回数と最少表示回数の差。0 = 全ファイルが同じ回数。 */
export function spreadOf(stats: Pick<DisplayStats, 'min' | 'max'>): number {
  return stats.max - stats.min;
}

/** 全ファイルに占める割合（%）を小数 1 桁で。母数 0 は 0。 */
export function percentOf(files: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((files / total) * 1000) / 10;
}

/** 大きな数を軸ラベル用に短縮する（12500 -> 12.5K / 1.2万）。ロケールは呼び出し側が渡す。 */
export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}
