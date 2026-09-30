// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type uPlot from 'uplot';
import type { DisplayStats } from '../../types';
import { setLanguageSetting } from '../../lib/i18n/store';
import { CHART_HEIGHT, buildDisplayCountOptions } from './displayCountPlot';

// #67: uPlot 本体は jsdom（canvas 無し）で描けないため、オプション組み立て関数が返す
// 設定値・フック（canvas 重ね描き・ツールチップ）を偽の uPlot インスタンスで直接叩いて固定する。

const stats: DisplayStats = {
  files: 10,
  min: 1,
  max: 4,
  mean: 2.5,
  bins: [
    { count: 1, files: 2 },
    { count: 3, files: 5 },
    { count: 4, files: 3 },
  ],
};

type Fn = (...args: unknown[]) => unknown;
const asFn = (v: unknown): Fn => v as Fn;

describe('buildDisplayCountOptions structure (#67)', () => {
  it('uses the given width and the fixed chart height', () => {
    const opts = buildDisplayCountOptions(stats, 480, 'ja');
    expect(opts.width).toBe(480);
    expect(opts.height).toBe(CHART_HEIGHT);
  });

  it('hides the legend because there is a single series', () => {
    expect(buildDisplayCountOptions(stats, 480, 'ja').legend?.show).toBe(false);
  });

  it('has a time-less x scale over the padded count range', () => {
    const opts = buildDisplayCountOptions(stats, 480, 'ja');
    expect(opts.scales!.x.time).toBe(false);
    expect(asFn(opts.scales!.x.range)()).toEqual([-0.5, 5.5]);
  });

  it('starts the y scale at zero with headroom above the tallest bin', () => {
    const opts = buildDisplayCountOptions(stats, 480, 'ja');
    expect(asFn(opts.scales!.y.range)()).toEqual([0, 6]);
  });

  it('keeps a floor on the y scale when every bin is empty', () => {
    const opts = buildDisplayCountOptions({ ...stats, files: 0, bins: [] }, 480, 'ja');
    expect(asFn(opts.scales!.y.range)()).toEqual([0, 1]);
  });

  it('labels the series and axes with the current language', () => {
    const opts = buildDisplayCountOptions(stats, 480, 'ja');
    expect(opts.series.map((s) => s.label)).toEqual(['表示回数', 'ファイル数']);
    expect(opts.axes!.map((a) => a.label)).toEqual(['表示回数', 'ファイル数']);
  });

  it('follows a language switch when the options are rebuilt', () => {
    setLanguageSetting('en');
    const opts = buildDisplayCountOptions(stats, 480, 'en');
    expect(opts.series.map((s) => s.label)).toEqual(['Times shown', 'Files']);
  });

  it('draws the bar series without an outline and without point markers', () => {
    const bars = buildDisplayCountOptions(stats, 480, 'ja').series[1];
    expect(bars.width).toBe(0);
    expect(bars.points?.show).toBe(false);
  });

  it('disables cursor drag and the crosshair so the chart stays read-only', () => {
    const cursor = buildDisplayCountOptions(stats, 480, 'ja').cursor!;
    expect(cursor.x).toBe(false);
    expect(cursor.y).toBe(false);
    expect(cursor.drag).toEqual({ x: false, y: false });
  });

  it('shows integer x ticks only and thins them for wide ranges', () => {
    const xAxis = buildDisplayCountOptions(stats, 480, 'ja').axes![0];
    expect(asFn(xAxis.splits)(null, 0, -0.5, 4.5)).toEqual([0, 1, 2, 3, 4]);
    expect(asFn(xAxis.values)(null, [0, 2])).toEqual(['0', '2']);
    expect(asFn(xAxis.splits)(null, 0, -0.5, 103.5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('shortens large y tick labels per locale', () => {
    const en = buildDisplayCountOptions(stats, 480, 'en').axes![1];
    expect(asFn(en.values)(null, [0, 500, 12_500])).toEqual(['0', '500', '12.5K']);
    const ja = buildDisplayCountOptions(stats, 480, 'ja').axes![1];
    expect(asFn(ja.values)(null, [15_000])).toEqual(['1.5万']);
  });

  it('never proposes fractional y tick increments', () => {
    const incrs = buildDisplayCountOptions(stats, 480, 'ja').axes![1].incrs as number[];
    expect(incrs.every((n) => Number.isInteger(n))).toBe(true);
  });

  it('registers exactly one draw hook and one plugin', () => {
    const opts = buildDisplayCountOptions(stats, 480, 'ja');
    expect(opts.hooks!.draw).toHaveLength(1);
    expect(opts.plugins).toHaveLength(1);
  });
});

function fakeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textBaseline: '',
    textAlign: '',
  };
}

/** x: 1 count = 20px, y: 1 file = 10px (baseline at y=200)。 */
function fakeDrawPlot(ctx: ReturnType<typeof fakeCtx> | null) {
  return {
    ctx,
    bbox: { left: 0, top: 30, width: 200, height: 170 },
    valToPos: (val: number, scale: string) => (scale === 'x' ? val * 20 : 200 - val * 10),
  } as unknown as uPlot;
}

describe('buildDisplayCountOptions draw overlay (#67)', () => {
  const draw = (u: uPlot, s: DisplayStats = stats, locale: 'ja' | 'en' = 'ja') =>
    (buildDisplayCountOptions(s, 480, locale).hooks!.draw as ((u: uPlot) => void)[])[0](u);

  it('does nothing without a canvas context (jsdom)', () => {
    expect(() => draw(fakeDrawPlot(null))).not.toThrow();
  });

  it('draws a dashed mean line at the mean position and restores the context state', () => {
    const ctx = fakeCtx();
    draw(fakeDrawPlot(ctx));

    expect(ctx.setLineDash).toHaveBeenNthCalledWith(1, [4, 4]);
    expect(ctx.setLineDash).toHaveBeenLastCalledWith([]);
    expect(ctx.moveTo).toHaveBeenCalledWith(50, 26);
    expect(ctx.lineTo).toHaveBeenCalledWith(50, 200);
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it('labels the mean directly above the plot with one decimal', () => {
    const ctx = fakeCtx();
    draw(fakeDrawPlot(ctx));
    expect(ctx.fillText).toHaveBeenCalledWith('平均 2.5', 50, 21);
  });

  it('clamps the mean label inside the plot when the mean is at the left edge', () => {
    const ctx = fakeCtx();
    draw(fakeDrawPlot(ctx), { ...stats, mean: 0 });
    expect(ctx.fillText).toHaveBeenCalledWith('平均 0', 20, 21);
  });

  it('translates the mean label with the locale', () => {
    setLanguageSetting('en');
    const ctx = fakeCtx();
    draw(fakeDrawPlot(ctx), stats, 'en');
    expect(ctx.fillText).toHaveBeenCalledWith('Avg 2.5', 50, 21);
  });

  it('marks a bin that would collapse below 2px with a minimum-height bar', () => {
    const ctx = fakeCtx();
    const u = {
      ...fakeDrawPlot(ctx),
      // 1 ファイル = 0.5px しか立たない（母数が巨大なとき）。
      valToPos: (val: number, scale: string) => (scale === 'x' ? val * 20 : 200 - val * 0.5),
    } as unknown as uPlot;
    draw(u, { ...stats, bins: [{ count: 1, files: 1 }] });

    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    const [x, y, w, h] = ctx.fillRect.mock.calls[0];
    expect(y).toBe(198);
    expect(h).toBe(2);
    expect(x + w / 2).toBe(20);
  });

  it('adds no marker for bins tall enough to be visible', () => {
    const ctx = fakeCtx();
    draw(fakeDrawPlot(ctx));
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('adds no marker for a bin with zero files', () => {
    const ctx = fakeCtx();
    draw(fakeDrawPlot(ctx), { ...stats, bins: [{ count: 2, files: 0 }] });
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

function tooltipHarness(s: DisplayStats = stats, locale: 'ja' | 'en' = 'ja') {
  const plugin = buildDisplayCountOptions(s, 480, locale).plugins![0];
  const over = document.createElement('div');
  const cursor: { left: number | null | undefined } = { left: -1 };
  const u = {
    over,
    cursor,
    posToVal: (px: number) => px / 20,
    valToPos: (val: number) => val * 20,
  } as unknown as uPlot;
  asFn(plugin.hooks!.init)(u);
  const [highlight, tip] = Array.from(over.children) as HTMLDivElement[];
  const moveTo = (left: number | null | undefined) => {
    cursor.left = left;
    asFn(plugin.hooks!.setCursor)(u);
  };
  return { highlight, tip, moveTo };
}

describe('buildDisplayCountOptions tooltip (#67)', () => {
  it('starts hidden', () => {
    const { highlight, tip } = tooltipHarness();
    expect(highlight.style.display).toBe('none');
    expect(tip.style.display).toBe('none');
  });

  it('shows the count, file count and share for the hovered bar', () => {
    const { tip, moveTo } = tooltipHarness();
    moveTo(60); // count 3 → 5 files of 10
    expect(tip.style.display).toBe('block');
    expect(tip.textContent).toBe('3回表示5ファイル（50.0%）');
  });

  it('reports a gap slot (no bar) as 0 files', () => {
    const { tip, moveTo } = tooltipHarness();
    moveTo(40); // count 2 → no bin
    expect(tip.textContent).toBe('2回表示0ファイル（0.0%）');
  });

  it('highlights the whole slot around the hovered count', () => {
    const { highlight, moveTo } = tooltipHarness();
    moveTo(60);
    expect(highlight.style.display).toBe('block');
    expect(highlight.style.left).toBe('50px');
    expect(highlight.style.width).toBe('20px');
  });

  it('hides when the cursor leaves the plot', () => {
    const { tip, moveTo } = tooltipHarness();
    moveTo(60);
    moveTo(-1);
    expect(tip.style.display).toBe('none');
  });

  it('treats a missing cursor position as outside the plot', () => {
    const { tip, moveTo } = tooltipHarness();
    moveTo(60);
    moveTo(null);
    expect(tip.style.display).toBe('none');
  });

  it('hides for a slot beyond the padded x range', () => {
    const { tip, moveTo } = tooltipHarness();
    moveTo(60);
    moveTo(20 * 20); // count 20, far past the range
    expect(tip.style.display).toBe('none');
  });

  it('formats the tooltip numbers with the locale', () => {
    setLanguageSetting('en');
    const big: DisplayStats = {
      files: 20_000,
      min: 1,
      max: 1,
      mean: 1,
      bins: [{ count: 1, files: 12_345 }],
    };
    const { tip, moveTo } = tooltipHarness(big, 'en');
    moveTo(20);
    expect(tip.textContent).toBe('Shown 1x12,345 files (61.7%)');
  });
});
