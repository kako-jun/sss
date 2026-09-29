// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setLanguageSetting } from '../../lib/i18n/store';

// #80: GraphSectionはuPlotでチャートを描画する。src/test/setup.tsに追加した
// `window.matchMedia`スタブが無いとuPlotのモジュール読み込み自体が例外を投げる
// （import時にdevicePixelRatio監視のため呼ばれるため）。jsdomは実canvasを持たない
// （`canvas`パッケージ未導入）ため`getContext('2d')`はnullで、jsdomがコンソールに
// "Not implemented" を出すが例外にはならず、legend等のDOM要素は生成される
// （uPlotはlegendをcanvas描画でなくDOM要素で構築するため）。
const getDisplayStats = vi.fn();
const getStats = vi.fn();
const resetAllDisplayCounts = vi.fn();
vi.mock('../../lib/tauri', () => ({
  getDisplayStats: (...args: unknown[]) => getDisplayStats(...args),
  getStats: (...args: unknown[]) => getStats(...args),
  resetAllDisplayCounts: (...args: unknown[]) => resetAllDisplayCounts(...args),
}));

import { GraphSection } from './GraphSection';

beforeEach(() => {
  getDisplayStats.mockReset();
  getStats.mockReset();
  resetAllDisplayCounts.mockReset();
});

describe('GraphSection i18n (#80)', () => {
  it('renders translated labels (title, chart summary, badge, reset button) in the default (ja) locale', async () => {
    getDisplayStats.mockResolvedValue({
      files: 2,
      min: 1,
      max: 2,
      mean: 1.5,
      bins: [
        { count: 1, files: 1 },
        { count: 2, files: 1 },
      ],
    });
    getStats.mockResolvedValue({ totalImages: 2, displayedImages: 2 });

    const { container } = render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByText('画像ごとの表示回数')).toBeTruthy();
    });
    // #66レビューmust5: uPlotの構築は上のタイトル描画とは別のeffectで起きるため、
    // タイトルが見えた直後の同期チェックだとCIで稀に間に合わずflakyだった
    // （実ブラウザ差ではなくレンダー完了タイミングの問題）。waitForに入れて待つ。
    // #67: 単一系列なので凡例は出さない。チャートのラベルは role=img の
    // aria-label（翻訳済み）で確認する。
    await waitFor(() => {
      expect(container.querySelector('.u-over')).not.toBeNull();
    });
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '表示回数の分布グラフ。2ファイル、最少1回、最多2回、平均1.5回',
    );
    expect(screen.getByText('均等（差は1回以内）')).toBeTruthy();
    expect(screen.getByText('表示回数をリセット')).toBeTruthy();
  });

  it('shows the translated "no stats" message when there is no display data yet', async () => {
    getDisplayStats.mockResolvedValue({ files: 0, min: 0, max: 0, mean: 0, bins: [] });
    getStats.mockResolvedValue({ totalImages: 0, displayedImages: 0 });

    render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByText('データがありません。スキャンを実行してください。')).toBeTruthy();
    });
  });

  // #80実装コメント（GraphSection.tsx）: `t`自体は同一関数参照でuseTの再レンダー
  // トリガーにしかならないため、チャート再構築effectを言語切替に追従させるには
  // `locale`自体を依存配列に含める必要がある、と明記されている。ここでは実際に
  // ロケールを切り替え、Reactコンポーネントツリー（title/ボタン等）だけでなく
  // uPlot自身が再構築されチャートのlegendラベルも追従することを固定する
  // （`locale`を依存配列から外すと本テストは落ちることを確認済み）。
  it('rebuilds the uPlot chart when the locale changes without remounting', async () => {
    getDisplayStats.mockResolvedValue({
      files: 2,
      min: 1,
      max: 2,
      mean: 1.5,
      bins: [
        { count: 1, files: 1 },
        { count: 2, files: 1 },
      ],
    });
    getStats.mockResolvedValue({ totalImages: 2, displayedImages: 2 });

    const { container } = render(<GraphSection />);
    const plotRoot = () => container.querySelector('.u-over');
    const chartLabel = () => container.querySelector('[role="img"]')?.getAttribute('aria-label');

    await waitFor(() => {
      expect(plotRoot()).not.toBeNull();
    });
    const before = plotRoot();
    expect(chartLabel()).toContain('表示回数の分布グラフ');

    act(() => {
      setLanguageSetting('en');
    });

    await waitFor(() => {
      expect(chartLabel()).toContain('Display count distribution chart');
    });
    // uPlot自身が作り直されている（canvas上の軸ラベル・平均ラベルは再構築でしか
    // 翻訳に追従できない）。旧インスタンスのDOMとは別ノードになる。
    expect(plotRoot()).not.toBeNull();
    expect(plotRoot()).not.toBe(before);
    expect(screen.getByText('Display Count per Image')).toBeTruthy();
    expect(screen.getByText('Reset Display Counts')).toBeTruthy();
  });

  it('flags a wide spread instead of the "even" badge and lists every bin in the table view (#67)', async () => {
    getDisplayStats.mockResolvedValue({
      files: 10,
      min: 0,
      max: 5,
      mean: 2.2,
      bins: [
        { count: 0, files: 2 },
        { count: 2, files: 6 },
        { count: 5, files: 2 },
      ],
    });
    getStats.mockResolvedValue({ totalImages: 10, displayedImages: 8 });

    const { container } = render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByTestId('fairness-badge').textContent).toBe('最多と最少の差 5回');
    });
    expect(screen.queryByText('均等（差は1回以内）')).toBeNull();
    // 行の中身は「回数 / ファイル数 / 割合」の連結（2回・6ファイル・60.0%）。棒のある3ビンだけが表の行になる（隙間の 1,3,4 回は行にしない）。
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
    expect(rows[1].textContent).toBe('2660.0%');
  });
});
