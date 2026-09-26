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
    applyRotation: true,
    ...overrides,
  };
}

// #60レビュー方針転換: 回転はバックエンドでキャッシュに焼き込まず、フロントの
// image-orientation CSS で行う。apply_exif_rotation設定（ImageInfo.applyRotation）に
// 連動して from-image（ON）/none（OFF）を切り替える必要がある。
// asset プロトコルはWebViewから見て別オリジンのため、crossOrigin無しでは
// image-orientationがそもそも無視される（Edgeで実測確認済み）ので、
// crossOrigin="anonymous" も併せてピン留めする。
describe('Slideshow imageOrientation / crossOrigin (#60)', () => {
  it('sets imageOrientation: from-image and crossOrigin when applyRotation is true', () => {
    const { container } = render(<Slideshow image={makeImage({ applyRotation: true })} />);

    const img = container.querySelector('img[alt="/photos/a.jpg"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.style.imageOrientation).toBe('from-image');
    expect(img.crossOrigin).toBe('anonymous');
  });

  it('sets imageOrientation: none when applyRotation is false (still with crossOrigin)', () => {
    const { container } = render(<Slideshow image={makeImage({ applyRotation: false })} />);

    const img = container.querySelector('img[alt="/photos/a.jpg"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.style.imageOrientation).toBe('none');
    expect(img.crossOrigin).toBe('anonymous');
  });

  it('does not set imageOrientation/crossOrigin on the <video> element', () => {
    // 動画にはEXIF Orientationという概念自体が無いため、video要素側は対象外
    // （念のため、誤って影響が漏れていないことをピン留めする）。
    const { container } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.style.imageOrientation).toBe('');
    expect(video.crossOrigin).toBeNull();
  });

  it('renders nothing image-related when image is null (loading placeholder only)', () => {
    const { container } = render(<Slideshow image={null} isLoading />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});
