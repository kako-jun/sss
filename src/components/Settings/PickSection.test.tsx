// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getPickedImages = vi.fn();
const deletePickedImage = vi.fn();
const getThumbnail = vi.fn();

vi.mock('../../lib/tauri', () => ({
  getPickedImages: (...args: unknown[]) => getPickedImages(...args),
  deletePickedImage: (...args: unknown[]) => deletePickedImage(...args),
  getThumbnail: (...args: unknown[]) => getThumbnail(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { PickSection } from './PickSection';

beforeEach(() => {
  getPickedImages.mockReset();
  deletePickedImage.mockReset();
  getThumbnail.mockReset();
});

// #67: ピック済みタブは静止画と動画が混在する（動画はアイコン+ファイル名）。
describe('PickSection thumbnails (#67)', () => {
  it('shows a thumbnail for an image and a film label for a video in the same list', async () => {
    getPickedImages.mockResolvedValue(['/pick/a.jpg', '/pick/clip.mp4']);
    getThumbnail.mockImplementation(async (path: string) =>
      path.endsWith('.mp4') ? { kind: 'video' } : { kind: 'image', path: '/cache/thumbs/a.jpg' },
    );

    const { container } = render(<PickSection />);

    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeTruthy());
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(1));
    expect(container.querySelector('img')!.getAttribute('src')).toBe(
      'asset://localhost//cache/thumbs/a.jpg',
    );
  });

  it('requests no thumbnail while every picked item is outside the viewport', async () => {
    class NeverVisibleObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', NeverVisibleObserver);
    getPickedImages.mockResolvedValue(['/pick/a.jpg', '/pick/b.jpg']);

    render(<PickSection />);
    await waitFor(() => expect(screen.getAllByTitle('削除').length).toBe(2));

    expect(getThumbnail).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows the empty message and requests no thumbnail when nothing is picked', async () => {
    getPickedImages.mockResolvedValue([]);
    render(<PickSection />);

    await waitFor(() => expect(screen.getByText('ピックした写真はありません')).toBeTruthy());
    expect(getThumbnail).not.toHaveBeenCalled();
  });

  it('keeps a failing item quiet without hiding the others', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPickedImages.mockResolvedValue(['/pick/broken.jpg', '/pick/ok.jpg']);
    getThumbnail.mockImplementation(async (path: string) => {
      if (path.includes('broken')) throw new Error('decode failed');
      return { kind: 'image', path: '/cache/thumbs/ok.jpg' };
    });

    const { container } = render(<PickSection />);

    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(1));
    expect(spy).toHaveBeenCalled();
    expect(screen.getAllByTitle('削除').length).toBe(2);
    spy.mockRestore();
  });
});

describe('PickSection delete (#67)', () => {
  it('removes the item after a confirmed delete', async () => {
    getPickedImages.mockResolvedValue(['/pick/a.jpg', '/pick/b.jpg']);
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/t.jpg' });
    deletePickedImage.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PickSection />);
    await waitFor(() => expect(screen.getAllByTitle('削除').length).toBe(2));
    fireEvent.click(screen.getAllByTitle('削除')[0]);

    await waitFor(() => expect(screen.getAllByTitle('削除').length).toBe(1));
    expect(deletePickedImage).toHaveBeenCalledWith('/pick/a.jpg');
    confirm.mockRestore();
  });

  it('keeps the item when the confirmation is cancelled', async () => {
    getPickedImages.mockResolvedValue(['/pick/a.jpg']);
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/t.jpg' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<PickSection />);
    await waitFor(() => expect(screen.getAllByTitle('削除').length).toBe(1));
    fireEvent.click(screen.getByTitle('削除'));

    expect(deletePickedImage).not.toHaveBeenCalled();
    expect(screen.getAllByTitle('削除').length).toBe(1);
    confirm.mockRestore();
  });

  it('keeps the item when the backend delete fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPickedImages.mockResolvedValue(['/pick/a.jpg']);
    getThumbnail.mockResolvedValue({ kind: 'image', path: '/cache/thumbs/t.jpg' });
    deletePickedImage.mockRejectedValue(new Error('permission denied'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PickSection />);
    await waitFor(() => expect(screen.getAllByTitle('削除').length).toBe(1));
    fireEvent.click(screen.getByTitle('削除'));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.getAllByTitle('削除').length).toBe(1);
    confirm.mockRestore();
    spy.mockRestore();
  });
});
