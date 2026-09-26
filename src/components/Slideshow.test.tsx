// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// convertFileSrc は window.__TAURI_INTERNALS__ を要求するため jsdom では
// 呼ぶと例外になる。パスをそのまま素通しするだけの薄いモックに差し替える。
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { Slideshow } from './Slideshow';
import type { ImageInfo } from '../types';

function makeImage(overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    path: '/photos/a.jpg',
    optimizedPath: null,
    isVideo: false,
    width: 100,
    height: 100,
    fileSize: 1234,
    exif: null,
    displayCount: 0,
    lastDisplayed: null,
    ...overrides,
  };
}

// #60レビュー2巡目 must B: crossOrigin/image-orientationの明示切替は撤去し、
// WebView既定の動作（from-image）に任せる方針に転換した。wryのWebKitGTK実装が
// assetスキームをCORS有効登録しておらず、crossOrigin="anonymous"を付けると
// Linux本番で画像が一切表示されなくなるリスクがあったため。
// img要素がcrossOrigin/image-orientationを明示指定しない（ブラウザ既定に委ねる）
// ことをピン留めする（過去にこれらを明示していた実装への回帰検知）。
describe('Slideshow img attributes (#60)', () => {
  it('does not set crossOrigin or an explicit imageOrientation style on the <img>', () => {
    const { container } = render(<Slideshow image={makeImage()} />);

    const img = container.querySelector('img[alt="/photos/a.jpg"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.crossOrigin).toBeNull();
    expect(img.style.imageOrientation).toBe('');
  });

  it('does not set crossOrigin or imageOrientation on the <video> element either', () => {
    const { container } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.crossOrigin).toBeNull();
    expect(video.style.imageOrientation).toBe('');
  });

  it('renders nothing image-related when image is null (loading placeholder only)', () => {
    const { container } = render(<Slideshow image={null} isLoading />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});
