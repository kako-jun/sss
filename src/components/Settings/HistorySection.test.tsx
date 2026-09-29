// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RecentImage } from '../../types';

const getRecentImages = vi.fn();
const excludeImage = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getRecentImages: (...args: unknown[]) => getRecentImages(...args),
  excludeImage: (...args: unknown[]) => excludeImage(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  // jsdomには実装が無く、呼ぶと window.__TAURI_INTERNALS__ が無いとして
  // 例外になるため素通しモックに差し替える（App.test.tsx等と同じ方式）。
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { HistorySection } from './HistorySection';

beforeEach(() => {
  getRecentImages.mockReset();
  excludeImage.mockReset();
});

// #66レビュー3巡目must（OverlayUIと同じ問題の点検で発見）: 設定モーダルの
// パネル（framer-motionのmotion.divでanimate={{scale:1}}を持つ）は静止時も
// `transform: scale(1)`をインラインで保持し続けるため、その子孫の
// `position:fixed`要素の含有ブロックがパネル自身に限定されてしまい、
// `inset-0`が画面全体をカバーしなくなる。`createPortal`で`document.body`
// 直下に出すことで解消した。jsdomはレイアウトの含有ブロック計算自体は
// 行わないため、ここでは「実際にdocument.bodyの直接の子として存在するか」
// という構造面と、クリックで実際に閉じることを確認する
// （祖先のtransformが実際に影響する見た目の確認は実ブラウザe2eが担当）。
describe('HistorySection exclude submenu backdrop is portaled to document.body (#66レビュー3巡目must)', () => {
  it('renders the click-to-close backdrop as a direct child of document.body', async () => {
    const images: RecentImage[] = [
      { path: '/photos/a.jpg', displayCount: 3, lastDisplayed: '2026-01-01T00:00:00Z' },
    ];
    getRecentImages.mockResolvedValue(images);
    const { container } = render(<HistorySection />);

    await waitFor(() => {
      expect(screen.getByTitle('除外')).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle('除外'));

    const backdrops = Array.from(document.body.children).filter(
      (el) => el.className === 'fixed inset-0 z-40',
    );
    expect(backdrops.length).toBe(1);
    expect(container.contains(backdrops[0])).toBe(false);
  });

  it('closes the submenu when the portaled backdrop is clicked', async () => {
    const images: RecentImage[] = [
      { path: '/photos/a.jpg', displayCount: 3, lastDisplayed: '2026-01-01T00:00:00Z' },
    ];
    getRecentImages.mockResolvedValue(images);
    render(<HistorySection />);

    await waitFor(() => {
      expect(screen.getByTitle('除外')).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle('除外'));
    expect(screen.getByText('この写真を除外')).toBeTruthy();

    const backdrop = Array.from(document.body.children).find(
      (el) => el.className === 'fixed inset-0 z-40',
    )!;
    fireEvent.click(backdrop);

    expect(screen.queryByText('この写真を除外')).toBeNull();
  });
});
