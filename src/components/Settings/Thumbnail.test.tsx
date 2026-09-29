// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const getThumbnail = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getThumbnail: (...args: unknown[]) => getThumbnail(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { Thumbnail } from './Thumbnail';

beforeEach(() => {
  getThumbnail.mockReset();
});

// #67: 履歴/ピックのサムネイルは原本でなくバックエンドが縮小したキャッシュ JPEG を読む。
describe('Thumbnail (#67)', () => {
  it('shows the backend-generated thumbnail, never the original file', async () => {
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/abc.jpg' });
    const { container } = render(<Thumbnail path="/photos/huge.jpg" />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(getThumbnail).toHaveBeenCalledWith('/photos/huge.jpg');
    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      'asset://localhost//cache/thumbs/abc.jpg',
    );
  });

  it('shows a film icon and the file name for videos instead of a broken image', async () => {
    getThumbnail.mockResolvedValue({ kind: 'video' });
    const { container } = render(<Thumbnail path="/videos/clip one.mp4" />);

    await waitFor(() => expect(screen.getByText('clip one.mp4')).toBeTruthy());
    expect(container.querySelector('img')).toBeNull();
  });

  it('falls back to a quiet placeholder when thumbnail generation fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getThumbnail.mockRejectedValue(new Error('decode failed'));
    const { container } = render(<Thumbnail path="/photos/broken.jpg" />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.querySelector('img')).toBeNull();
    spy.mockRestore();
  });

  it('does not request a thumbnail until it scrolls into view', async () => {
    let trigger: (entries: { isIntersecting: boolean }[]) => void = () => {};
    class FakeObserver {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        trigger = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/x.jpg' });

    const { container } = render(<Thumbnail path="/photos/a.jpg" />);
    expect(getThumbnail).not.toHaveBeenCalled();

    trigger([{ isIntersecting: true }]);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(getThumbnail).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
