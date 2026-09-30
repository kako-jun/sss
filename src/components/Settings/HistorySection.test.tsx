// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RecentImage } from '../../types';

const getRecentImages = vi.fn();
const excludeImage = vi.fn();
const getThumbnail = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getRecentImages: (...args: unknown[]) => getRecentImages(...args),
  excludeImage: (...args: unknown[]) => excludeImage(...args),
  getThumbnail: (...args: unknown[]) => getThumbnail(...args),
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
  getThumbnail.mockReset();
  getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/t.jpg' });
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

// #67: 履歴は 100 件でも「画面に入った分だけ」サムネイルを要求する。
describe('HistorySection thumbnails (#67)', () => {
  const images: RecentImage[] = [
    { path: '/photos/a.jpg', displayCount: 3, lastDisplayed: '2026-01-01T00:00:00Z' },
    { path: '/photos/b.jpg', displayCount: 1, lastDisplayed: '2026-01-02T00:00:00Z' },
  ];

  it('requests one thumbnail per history item when nothing gates visibility', async () => {
    getRecentImages.mockResolvedValue(images);
    const { container } = render(<HistorySection />);

    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(2));
    expect(getThumbnail).toHaveBeenCalledTimes(2);
    expect(getThumbnail).toHaveBeenCalledWith('/photos/a.jpg');
    expect(getThumbnail).toHaveBeenCalledWith('/photos/b.jpg');
  });

  it('requests no thumbnail while every item is outside the viewport', async () => {
    class NeverVisibleObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', NeverVisibleObserver);
    getRecentImages.mockResolvedValue(images);

    render(<HistorySection />);
    await waitFor(() => expect(screen.getAllByTitle('除外').length).toBe(2));

    expect(getThumbnail).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows the display count over each thumbnail', async () => {
    getRecentImages.mockResolvedValue(images);
    render(<HistorySection />);

    await waitFor(() => expect(screen.getByText('\u00d73')).toBeTruthy());
    expect(screen.getByText('\u00d71')).toBeTruthy();
  });

  it('shows the empty message and requests no thumbnail for an empty history', async () => {
    getRecentImages.mockResolvedValue([]);
    render(<HistorySection />);

    await waitFor(() => expect(screen.getByText('表示履歴はありません')).toBeTruthy());
    expect(getThumbnail).not.toHaveBeenCalled();
  });
});

// #92: 除外失敗はコンソールだけでなく、ローカライズしたメッセージを画面に出す。
describe('HistorySection exclude failure message (#92)', () => {
  const images: RecentImage[] = [
    { path: '/photos/a.jpg', displayCount: 3, lastDisplayed: '2026-01-01T00:00:00Z' },
  ];

  it('shows the localized message when the backend rejects an unmanaged path and keeps the row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getRecentImages.mockResolvedValue(images);
    excludeImage.mockRejectedValue('pathNotManaged');
    render(<HistorySection />);

    await waitFor(() => expect(screen.getByTitle('除外')).toBeTruthy());
    fireEvent.click(screen.getByTitle('除外'));
    fireEvent.click(screen.getByText('この写真を除外'));

    expect(
      await screen.findByText('このファイルはスライドショーの管理外のため除外できません'),
    ).toBeTruthy();
    expect(screen.getByTitle('除外')).toBeTruthy();
  });

  it('falls back to the generic failure message for other errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getRecentImages.mockResolvedValue(images);
    excludeImage.mockRejectedValue(new Error('boom'));
    render(<HistorySection />);

    await waitFor(() => expect(screen.getByTitle('除外')).toBeTruthy());
    fireEvent.click(screen.getByTitle('除外'));
    fireEvent.click(screen.getByText('この写真を除外'));

    expect(await screen.findByText('エラー: 除外失敗')).toBeTruthy();
  });
});
