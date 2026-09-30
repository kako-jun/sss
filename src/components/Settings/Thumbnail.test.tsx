// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';

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
    // 動画と同様にファイル名も出す（何のファイルか分かるように）。
    await waitFor(() => expect(screen.getByText('broken.jpg')).toBeTruthy());
    spy.mockRestore();
  });

  it('switches to the failed placeholder when the thumbnail file cannot be loaded', async () => {
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/gone.jpg' });
    const { container } = render(<Thumbnail path="/photos/gone.jpg" />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    // キャッシュ削除・リセット後などでサムネイルファイルが読めない。
    act(() => {
      fireEvent.error(container.querySelector('img')!);
    });

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('gone.jpg')).toBeTruthy();
  });

  it('draws the same thin border as the old grid tile around every state', async () => {
    getThumbnail.mockResolvedValue({ kind: 'video' });
    const { container } = render(<Thumbnail path="/v/clip.mp4" />);
    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeTruthy());
    const box = container.firstElementChild!;
    expect(box.classList.contains('border')).toBe(true);
    expect(box.classList.contains('border-white/5')).toBe(true);
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

// #67 レビュー指摘D: path prop が変わったとき前のパスの表示を残さない。
describe('Thumbnail path change (#67)', () => {
  it('drops the previous path image while the new path is loading', async () => {
    let resolveSecond: (v: unknown) => void = () => {};
    getThumbnail
      .mockResolvedValueOnce({ kind: 'image', path: '/cache/thumbs/first.jpg' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { container, rerender } = render(<Thumbnail path="/photos/first.jpg" />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    rerender(<Thumbnail path="/photos/second.jpg" />);

    expect(container.querySelector('img')).toBeNull();
    await act(async () => {
      resolveSecond({ kind: 'image', path: '/cache/thumbs/second.jpg' });
    });
    await waitFor(() =>
      expect(container.querySelector('img')!.getAttribute('src')).toBe(
        'asset://localhost//cache/thumbs/second.jpg',
      ),
    );
  });

  it('drops the previous video label when switching to an image path', async () => {
    getThumbnail
      .mockResolvedValueOnce({ kind: 'video' })
      .mockResolvedValueOnce({ kind: 'image', path: '/cache/thumbs/p.jpg' });
    const { container, rerender } = render(<Thumbnail path="/v/clip.mp4" />);
    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeTruthy());

    rerender(<Thumbnail path="/p/photo.jpg" />);

    expect(screen.queryByText('clip.mp4')).toBeNull();
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
  });

  it('ignores a slow response for the previous path (no stale overwrite)', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    getThumbnail
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: 'image', path: '/cache/thumbs/second.jpg' });
    const { container, rerender } = render(<Thumbnail path="/photos/first.jpg" />);
    rerender(<Thumbnail path="/photos/second.jpg" />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    await act(async () => {
      resolveFirst({ kind: 'image', path: '/cache/thumbs/first.jpg' });
    });

    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      'asset://localhost//cache/thumbs/second.jpg',
    );
  });

  it('requests the thumbnail again for the new path', async () => {
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/t.jpg' });
    const { container, rerender } = render(<Thumbnail path="/photos/a.jpg" />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    rerender(<Thumbnail path="/photos/b.jpg" />);

    await waitFor(() => expect(getThumbnail).toHaveBeenCalledWith('/photos/b.jpg'));
    expect(getThumbnail).toHaveBeenCalledTimes(2);
  });

  it('clears the failed placeholder state when the path changes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getThumbnail
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValueOnce({ kind: 'image', path: '/cache/thumbs/ok.jpg' });
    const { container, rerender } = render(<Thumbnail path="/photos/broken.jpg" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());

    rerender(<Thumbnail path="/photos/ok.jpg" />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    spy.mockRestore();
  });
});

describe('Thumbnail labels (#67)', () => {
  it('shows only the last segment of a Windows path for a video', async () => {
    getThumbnail.mockResolvedValue({ kind: 'video' });
    render(<Thumbnail path={'C:\\Videos\\holiday\\clip.mp4'} />);

    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeTruthy());
  });

  it('renders a decorative image with empty alt and no drag', async () => {
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/x.jpg' });
    const { container } = render(<Thumbnail path="/photos/a.jpg" />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('draggable')).toBe('false');
  });

  it('requests the thumbnail once and only after the observer reports it intersecting', async () => {
    const observed: { disconnect: number } = { disconnect: 0 };
    let trigger: (entries: { isIntersecting: boolean }[]) => void = () => {};
    class FakeObserver {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        trigger = cb;
      }
      observe() {}
      disconnect() {
        observed.disconnect += 1;
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/x.jpg' });

    const { container } = render(<Thumbnail path="/photos/a.jpg" />);
    act(() => trigger([{ isIntersecting: false }]));
    expect(getThumbnail).not.toHaveBeenCalled();

    act(() => trigger([{ isIntersecting: true }]));
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(getThumbnail).toHaveBeenCalledTimes(1);
    expect(observed.disconnect).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
