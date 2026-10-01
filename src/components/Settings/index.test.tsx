// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// 各セクションは本テストの対象外（タブ行のクラスだけを見る）ため空のスタブにする。
vi.mock('./ScanSection', () => ({ ScanSection: () => null }));
vi.mock('./IntervalSection', () => ({ IntervalSection: () => null }));
vi.mock('./VideoSection', () => ({ VideoSection: () => null }));
vi.mock('./ShareDirectorySection', () => ({ ShareDirectorySection: () => null }));
vi.mock('./LanguageSection', () => ({ LanguageSection: () => null }));
vi.mock('./ExcludeRulesSection', () => ({ ExcludeRulesSection: () => null }));
vi.mock('./PickSection', () => ({ PickSection: () => null }));
vi.mock('./HistorySection', () => ({ HistorySection: () => null }));
vi.mock('./GraphSection', () => ({ GraphSection: () => null }));
vi.mock('./InfoSection', () => ({ InfoSection: () => null }));

import { Settings } from './index';

describe('Settings tablist (#109)', () => {
  it('is shrink-0 so it never collapses inside the flex-col modal body', () => {
    // 実描画での高さ一定の検証は e2e（Settings tablist height stays constant ...）が正本。
    // jsdom はレイアウトしないため、潰れ防止クラス（role=tablist 経由で取得）が落ちていないことだけを確認する。
    render(<Settings isOpen onClose={() => {}} onScanComplete={() => {}} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('shrink-0');
  });

  describe('selected tab follows into view', () => {
    // jsdom には scrollIntoView が無いので prototype に差し込んで spy にする。
    const original = Element.prototype.scrollIntoView;
    const spy = vi.fn();
    beforeEach(() => {
      spy.mockClear();
      Element.prototype.scrollIntoView = spy;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = original;
    });

    it('calls scrollIntoView({inline:nearest, block:nearest}) on open and when the tab changes', () => {
      render(<Settings isOpen onClose={() => {}} onScanComplete={() => {}} />);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith({ inline: 'nearest', block: 'nearest' });
      fireEvent.click(screen.getAllByRole('tab', { selected: false })[0]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith({ inline: 'nearest', block: 'nearest' });
    });

    it('does not call scrollIntoView while closed', () => {
      render(<Settings isOpen={false} onClose={() => {}} onScanComplete={() => {}} />);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
