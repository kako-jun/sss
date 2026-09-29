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
  it('renders translated labels (title, legend, reset button) in the default (ja) locale', async () => {
    getDisplayStats.mockResolvedValue([
      ['/a.jpg', 1],
      ['/b.jpg', 2],
    ]);
    getStats.mockResolvedValue({ totalImages: 2, displayedImages: 2 });

    const { container } = render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByText('画像ごとの表示回数')).toBeTruthy();
    });
    // #66レビューmust5: uPlotのlegend DOM構築は上のタイトル描画とは別のeffectで
    // 起きるため、タイトルが見えた直後の同期チェックだとCIで稀に間に合わず
    // flakyだった（実ブラウザ差ではなくレンダー完了タイミングの問題）。waitForに
    // 入れてuPlotの構築を待つ。
    await waitFor(() => {
      expect(container.querySelector('.u-legend .u-label')?.textContent).toBe('表示回数');
    });
    expect(screen.getByText('表示回数をリセット')).toBeTruthy();
  });

  it('shows the translated "no stats" message when there is no display data yet', async () => {
    getDisplayStats.mockResolvedValue([]);
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
  it('rebuilds the uPlot chart (legend labels) when the locale changes without remounting', async () => {
    getDisplayStats.mockResolvedValue([
      ['/a.jpg', 1],
      ['/b.jpg', 2],
    ]);
    getStats.mockResolvedValue({ totalImages: 2, displayedImages: 2 });

    const { container } = render(<GraphSection />);
    const legendText = () => container.querySelector('.u-legend .u-label')?.textContent;

    await waitFor(() => {
      expect(legendText()).toBe('表示回数');
    });

    act(() => {
      setLanguageSetting('en');
    });

    await waitFor(() => {
      expect(legendText()).toBe('Display Count');
    });
    expect(screen.getByText('Display Count per Image')).toBeTruthy();
    expect(screen.getByText('Reset Display Counts')).toBeTruthy();
  });
});
