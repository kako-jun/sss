// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
});
