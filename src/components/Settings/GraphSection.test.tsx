// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setLanguageSetting } from '../../lib/i18n/store';

// #80: GraphSectionはuPlotでチャートを描画する。src/test/setup.tsに追加した
// `window.matchMedia`スタブが無いとuPlotのモジュール読み込み自体が例外を投げる
// （import時にdevicePixelRatio監視のため呼ばれるため）。jsdomは実canvasを持たない
// （`canvas`パッケージ未導入）ため`getContext('2d')`はnullで、jsdomがコンソールに
// "Not implemented" を出すが例外にはならず、legend等のDOM要素は生成される
// （uPlotはlegendをcanvas描画でなくDOM要素で構築するため）。
const getDisplayStats = vi.fn();
const resetAllDisplayCounts = vi.fn();
vi.mock('../../lib/tauri', () => ({
  getDisplayStats: (...args: unknown[]) => getDisplayStats(...args),
  resetAllDisplayCounts: (...args: unknown[]) => resetAllDisplayCounts(...args),
}));

import { GraphSection } from './GraphSection';

beforeEach(() => {
  getDisplayStats.mockReset();
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

// #67: 均等バッジの境界（EVEN_SPREAD_MAX = 1）。差が 0/1 なら「均等」、2 から差を示す。
describe('GraphSection fairness badge boundary (#67)', () => {
  const stats = (min: number, max: number) => ({
    files: 4,
    min,
    max,
    mean: (min + max) / 2,
    bins:
      min === max
        ? [{ count: min, files: 4 }]
        : [
            { count: min, files: 2 },
            { count: max, files: 2 },
          ],
  });
  const load = (min: number, max: number) => {
    getDisplayStats.mockResolvedValue(stats(min, max));
    render(<GraphSection />);
  };

  it('treats a single bin (spread 0) as even', async () => {
    load(3, 3);
    await waitFor(() => {
      expect(screen.getByTestId('fairness-badge').textContent).toBe('均等（差は1回以内）');
    });
  });

  it('treats a spread of exactly 1 as even', async () => {
    load(2, 3);
    await waitFor(() => {
      expect(screen.getByTestId('fairness-badge').textContent).toBe('均等（差は1回以内）');
    });
  });

  it('reports the gap once the spread reaches 2', async () => {
    load(2, 4);
    await waitFor(() => {
      expect(screen.getByTestId('fairness-badge').textContent).toBe('最多と最少の差 2回');
    });
  });

  it('draws the check icon only for the even badge', async () => {
    load(2, 3);
    await waitFor(() => {
      expect(screen.getByTestId('fairness-badge').querySelector('svg')).not.toBeNull();
    });
  });

  it('draws no check icon for the spread badge', async () => {
    load(2, 4);
    await waitFor(() => {
      expect(screen.getByTestId('fairness-badge').textContent).toBe('最多と最少の差 2回');
    });
    expect(screen.getByTestId('fairness-badge').querySelector('svg')).toBeNull();
  });
});

describe('GraphSection summary cards and table (#67)', () => {
  it('derives viewed/total from the histogram (total = files, viewed = files minus the 0-count bin), plus the rounded mean and min-max range', async () => {
    getDisplayStats.mockResolvedValue({
      files: 1234,
      min: 0,
      max: 3,
      mean: 0.66,
      bins: [
        { count: 0, files: 1231 },
        { count: 1, files: 2 },
        { count: 3, files: 1 },
      ],
    });

    const { container } = render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByText('表示済み')).toBeTruthy();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('3 / 1,234');
    expect(text).toContain('0.7');
    expect(text).toContain('0–3');
  });

  it('shows 0 viewed when every file is in the 0-count bin, and full when there is no 0-count bin', async () => {
    getDisplayStats.mockResolvedValueOnce({
      files: 5,
      min: 0,
      max: 0,
      mean: 0,
      bins: [{ count: 0, files: 5 }],
    });
    const { container, unmount } = render(<GraphSection />);
    await waitFor(() => expect(screen.getByText('表示済み')).toBeTruthy());
    expect(container.textContent).toContain('0 / 5');
    unmount();

    getDisplayStats.mockResolvedValueOnce({
      files: 5,
      min: 2,
      max: 2,
      mean: 2,
      bins: [{ count: 2, files: 5 }],
    });
    const second = render(<GraphSection />);
    await waitFor(() => expect(screen.getByText('表示済み')).toBeTruthy());
    expect(second.container.textContent).toContain('5 / 5');
  });

  it('derives the displayed-of-total summary from the get_display_stats histogram alone', async () => {
    getDisplayStats.mockResolvedValue({
      files: 2,
      min: 1,
      max: 1,
      mean: 1,
      bins: [{ count: 1, files: 2 }],
    });
    render(<GraphSection />);
    await waitFor(() => expect(screen.getByText('表示済み')).toBeTruthy());
    expect(getDisplayStats).toHaveBeenCalledTimes(1);
  });

  it('shows a 100% row for a single-bin table', async () => {
    getDisplayStats.mockResolvedValue({
      files: 5,
      min: 2,
      max: 2,
      mean: 2,
      bins: [{ count: 2, files: 5 }],
    });

    const { container } = render(<GraphSection />);

    await waitFor(() => {
      expect(container.querySelectorAll('tbody tr').length).toBe(1);
    });
    expect(container.querySelector('tbody tr')!.textContent).toBe('25100.0%');
  });

  it('shows the "no data" message and no chart when files is 0 (even if the playlist has members elsewhere)', async () => {
    getDisplayStats.mockResolvedValue({ files: 0, min: 0, max: 0, mean: 0, bins: [] });

    const { container } = render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByText('データがありません。スキャンを実行してください。')).toBeTruthy();
    });
    expect(container.querySelector('.u-over')).toBeNull();
    expect(screen.queryByTestId('fairness-badge')).toBeNull();
  });

  it('falls back to the "no data" message and logs when loading fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getDisplayStats.mockRejectedValue(new Error('db locked'));

    render(<GraphSection />);

    await waitFor(() => {
      expect(screen.getByText('データがありません。スキャンを実行してください。')).toBeTruthy();
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('GraphSection reset flow (#67)', () => {
  const stats = {
    files: 2,
    min: 1,
    max: 2,
    mean: 1.5,
    bins: [
      { count: 1, files: 1 },
      { count: 2, files: 1 },
    ],
  };

  it('does not reset or reload when the confirmation is cancelled', async () => {
    getDisplayStats.mockResolvedValue(stats);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<GraphSection />);
    await waitFor(() => expect(screen.getByText('表示回数をリセット')).toBeTruthy());
    fireEvent.click(screen.getByText('表示回数をリセット'));

    expect(confirm).toHaveBeenCalledWith('すべての画像の表示回数をリセットしますか？');
    expect(resetAllDisplayCounts).not.toHaveBeenCalled();
    expect(getDisplayStats).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('resets and then reloads the stats: the real backend still returns every playlist member, all in the 0-count bin', async () => {
    getDisplayStats.mockResolvedValueOnce(stats).mockResolvedValueOnce({
      files: 2,
      min: 0,
      max: 0,
      mean: 0,
      bins: [{ count: 0, files: 2 }],
    });
    resetAllDisplayCounts.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container } = render(<GraphSection />);
    await waitFor(() => expect(screen.getByText('表示回数をリセット')).toBeTruthy());
    fireEvent.click(screen.getByText('表示回数をリセット'));

    // 「データがありません」ではなく、0回の単一棒（全員 0 回 = 均等）が出る。
    await waitFor(() => {
      expect(container.querySelector('tbody tr')!.textContent).toBe('02100.0%');
    });
    expect(container.querySelectorAll('tbody tr').length).toBe(1);
    expect(screen.getByTestId('fairness-badge').textContent).toBe('均等（差は1回以内）');
    expect(container.textContent).toContain('0 / 2');
    expect(container.querySelector('.u-over')).not.toBeNull();
    expect(screen.queryByText('データがありません。スキャンを実行してください。')).toBeNull();
    expect(resetAllDisplayCounts).toHaveBeenCalledTimes(1);
    expect(getDisplayStats).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });
});
