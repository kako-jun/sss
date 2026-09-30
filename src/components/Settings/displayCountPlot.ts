import uPlot from 'uplot';
import type { DisplayStats } from '../../types';
import { t, type Locale } from '../../lib/i18n';
import {
  FILE_COUNT_INCRS,
  chartXRange,
  chartYRange,
  formatCompact,
  integerTicks,
  percentOf,
} from '../../lib/displayCountChart';

/**
 * 統計タブの「表示回数の分布」ヒストグラム（uPlot）のオプション組み立て（#67）。
 *
 * DESIGN.md「Charts」節のとおり、色は白の不透明度だけで表す（アクセント色なし。
 * 主役は写真でありグラフではない）。単一系列なので凡例は出さず、タイトルが系列名を
 * 兼ねる。値は棒の上のツールチップ、平均は破線＋直接ラベルで示す。
 */

export const CHART_HEIGHT = 240;

const INK = {
  /** 軸の数字・軸ラベル。黒背景に対して 4.5:1 を超える不透明度（DESIGN.md のコントラスト下限）。 */
  text: 'rgba(255,255,255,0.55)',
  /** Y 方向の罫線。あくまで下地。 */
  grid: 'rgba(255,255,255,0.06)',
  bar: 'rgba(255,255,255,0.72)',
  meanLine: 'rgba(255,255,255,0.9)',
  meanText: 'rgba(255,255,255,0.75)',
} as const;

const FONT_FAMILY = 'Inter, system-ui, sans-serif';
const FONT = `11px ${FONT_FAMILY}`;

/** 棒の幅（スロット幅に対する比率 / 最大 CSS px）。 */
const BAR_SIZE: [number, number] = [0.72, 80];
/** 棒の角丸（先端, 基線）。基線側は丸めない（データ端だけ丸める）。 */
const BAR_RADIUS: [number, number] = [0.3, 0];
/** 1 件でも存在するビンが埋もれないよう保証する棒の最小高さ（デバイス非依存の CSS px）。 */
const MIN_BAR_PX = 2;

/** 平均値の破線と直接ラベル、極小ビンの最小高さマーカーを canvas に重ね描きする。 */
function drawOverlay(u: uPlot, stats: DisplayStats, locale: Locale): void {
  const ctx = u.ctx;
  if (!ctx) return; // jsdom（canvas 無し）
  const r = uPlot.pxRatio;
  const { left, top, width, height } = u.bbox;
  const baseY = u.valToPos(0, 'y', true);

  ctx.save();

  // 極小ビン: 線形スケールのまま高さ 1px 未満に潰れる棒に「存在する」印を付ける。
  const slot = u.valToPos(1, 'x', true) - u.valToPos(0, 'x', true);
  const barW = Math.min(slot * BAR_SIZE[0], BAR_SIZE[1] * r);
  ctx.fillStyle = INK.bar;
  for (const bin of stats.bins) {
    if (bin.files <= 0) continue;
    if (baseY - u.valToPos(bin.files, 'y', true) >= MIN_BAR_PX * r) continue;
    const cx = u.valToPos(bin.count, 'x', true);
    ctx.fillRect(cx - barW / 2, baseY - MIN_BAR_PX * r, barW, MIN_BAR_PX * r);
  }

  // 平均: 破線 + 直接ラベル（プロット上端の余白に置く）。
  const mx = Math.round(u.valToPos(stats.mean, 'x', true));
  ctx.strokeStyle = INK.meanLine;
  ctx.lineWidth = Math.max(1, Math.round(r));
  ctx.setLineDash([4 * r, 4 * r]);
  ctx.beginPath();
  ctx.moveTo(mx, top - 4 * r);
  ctx.lineTo(mx, top + height);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `${Math.round(11 * r)}px ${FONT_FAMILY}`;
  ctx.fillStyle = INK.meanText;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const label = t('chartMeanLabel', {
    value: stats.mean.toLocaleString(locale, { maximumFractionDigits: 1 }),
  });
  const half = ctx.measureText(label).width / 2;
  const cx = Math.min(Math.max(mx, left + half), left + width - half);
  ctx.fillText(label, cx, top - 9 * r);

  ctx.restore();
}

/** ホバー時の棒ハイライト + ツールチップ（HTML。canvas 描画でなく DOM なのでコントラスト・フォントが素直）。 */
function tooltipPlugin(stats: DisplayStats, locale: Locale): uPlot.Plugin {
  const filesByCount = new Map(stats.bins.map((bin) => [bin.count, bin.files]));
  let highlight: HTMLDivElement;
  let tip: HTMLDivElement;
  let timesLine: HTMLDivElement;
  let filesLine: HTMLDivElement;

  const hide = () => {
    highlight.style.display = 'none';
    tip.style.display = 'none';
  };

  return {
    hooks: {
      init: (u) => {
        highlight = document.createElement('div');
        highlight.className = 'pointer-events-none absolute top-0 bottom-0 rounded bg-white/10';
        tip = document.createElement('div');
        tip.className =
          'pointer-events-none absolute top-1.5 z-10 whitespace-nowrap rounded-lg bg-black/90 px-2.5 py-1.5 text-xs shadow-2xl backdrop-blur-md';
        timesLine = document.createElement('div');
        timesLine.className = 'text-white/80';
        filesLine = document.createElement('div');
        filesLine.className = 'font-mono text-white/70';
        tip.append(timesLine, filesLine);
        u.over.append(highlight, tip);
        hide();
      },
      setCursor: (u) => {
        const cursorLeft = u.cursor.left ?? -1;
        if (cursorLeft < 0) {
          hide();
          return;
        }
        const count = Math.round(u.posToVal(cursorLeft, 'x'));
        const [lo, hi] = chartXRange(stats.min, stats.max);
        if (count < 0 || count < lo || count > hi) {
          hide();
          return;
        }
        // 棒の無い整数スロットは「0 ファイル」として示す（隙間も情報）。
        const files = filesByCount.get(count) ?? 0;
        timesLine.textContent = t('chartTooltipTimes', { count });
        filesLine.textContent = t('chartTooltipFiles', {
          files: files.toLocaleString(locale),
          percent: percentOf(files, stats.files).toLocaleString(locale, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        });

        const slotLeft = u.valToPos(count - 0.5, 'x');
        highlight.style.left = `${slotLeft}px`;
        highlight.style.width = `${u.valToPos(count + 0.5, 'x') - slotLeft}px`;
        highlight.style.display = 'block';

        tip.style.display = 'block';
        const half = tip.offsetWidth / 2;
        const center = Math.min(
          Math.max(u.valToPos(count, 'x'), half),
          Math.max(half, u.over.clientWidth - half),
        );
        tip.style.left = `${center - half}px`;
      },
    },
  };
}

export function buildDisplayCountOptions(
  stats: DisplayStats,
  width: number,
  locale: Locale,
): uPlot.Options {
  const [xLo, xHi] = chartXRange(stats.min, stats.max);
  const maxFiles = stats.bins.reduce((acc, bin) => Math.max(acc, bin.files), 0);

  return {
    width,
    height: CHART_HEIGHT,
    // 上端に平均ラベルを置く余白。
    padding: [24, 8, 0, 0],
    legend: { show: false },
    cursor: { x: false, y: false, points: { show: false }, drag: { x: false, y: false } },
    scales: {
      x: { time: false, range: () => [xLo, xHi] },
      y: { range: () => chartYRange(maxFiles) },
    },
    series: [
      { label: t('axisDisplayCount') },
      {
        label: t('seriesFileCount'),
        fill: INK.bar,
        stroke: INK.bar,
        width: 0,
        points: { show: false },
        paths: uPlot.paths.bars!({ size: BAR_SIZE, radius: BAR_RADIUS }),
      },
    ],
    axes: [
      {
        label: t('axisDisplayCount'),
        stroke: INK.text,
        font: FONT,
        labelFont: FONT,
        labelSize: 18,
        gap: 6,
        grid: { show: false },
        ticks: { show: false },
        splits: (_u, _axisIdx, min, max) => integerTicks(min, max),
        values: (_u, splits) => splits.map((v) => String(v)),
      },
      {
        label: t('seriesFileCount'),
        stroke: INK.text,
        font: FONT,
        labelFont: FONT,
        labelSize: 18,
        gap: 6,
        grid: { stroke: INK.grid, width: 1 },
        ticks: { show: false },
        incrs: FILE_COUNT_INCRS,
        values: (_u, splits) => splits.map((v) => formatCompact(v, locale)),
      },
    ],
    hooks: {
      draw: [(u) => drawOverlay(u, stats, locale)],
    },
    plugins: [tooltipPlugin(stats, locale)],
  };
}
