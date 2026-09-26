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

// #60: WebView既定の image-orientation: from-image を無効化しないと、
// apply_exif_rotation設定をOFFにしていても原本のEXIF Orientationに従って
// WebViewが勝手に回転してしまい、設定の意味と矛盾する。回転はバックエンドが
// キャッシュ生成時に一元管理するので、フロント側は常に imageOrientation: 'none'
// でWebViewの自動回転を止めておく必要がある（このピン留めが無いと再発に気づけない）。
describe('Slideshow imageOrientation (#60)', () => {
  it('sets imageOrientation: none on the <img> for a static image', () => {
    const { container } = render(<Slideshow image={makeImage()} />);

    const img = container.querySelector('img[alt="/photos/a.jpg"]');
    expect(img).not.toBeNull();
    expect((img as HTMLImageElement).style.imageOrientation).toBe('none');
  });

  it('does not (need to) set imageOrientation on the <video> element', () => {
    // 動画にはEXIF Orientationという概念自体が無いため、video要素側は対象外
    // （念のため、誤って影響が漏れていないことをピン留めする）。
    const { container } = render(
      <Slideshow image={makeImage({ isVideo: true, path: '/videos/a.mp4' })} />,
    );

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect((video as HTMLElement).style.imageOrientation).toBe('');
  });

  it('renders nothing image-related when image is null (loading placeholder only)', () => {
    const { container } = render(<Slideshow image={null} isLoading />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});
