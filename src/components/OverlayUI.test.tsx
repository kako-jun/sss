// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// #59: tauri-plugin-shell の open() から tauri-plugin-opener の openUrl() への移行。
// 地図セルのクリックが正しい引数で openUrl を呼ぶことをピン留めする（GPS座標→URL整形の
// ロジック自体は OverlayUI 内にあるため、モックは openUrl の呼び出しだけを検証する）。
const openUrl = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

import { OverlayUI } from './OverlayUI';
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

const noop = () => {};
const requiredProps = {
  canGoBack: true,
  currentPosition: 1,
  totalImages: 10,
  progress: 0,
  isPlaying: true,
  onPrevious: noop,
  onNext: noop,
  onOpenPickTab: noop,
  onMouseEnter: noop,
  onMouseLeave: noop,
  onTogglePause: noop,
};

function clickMapButton() {
  // 地図セルのボタン自体にはラベルが無いため、内側の img (alt="Location Map") から辿る。
  fireEvent.click(screen.getByAltText('Location Map').closest('button')!);
}

beforeEach(() => {
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
});

describe('OverlayUI map button (openUrl)', () => {
  it('calls openUrl with a Google Maps URL built from positive GPS coordinates', async () => {
    const image = makeImage({
      exif: {
        dateTime: null,
        gpsLatitude: 35.6812,
        gpsLongitude: 139.7671,
        width: null,
        height: null,
      },
    });
    render(<OverlayUI image={image} {...requiredProps} />);

    clickMapButton();

    expect(openUrl).toHaveBeenCalledWith('https://www.google.com/maps?q=35.6812,139.7671');
  });

  it('calls openUrl with negative (southern/western hemisphere) coordinates verbatim', async () => {
    // 境界/文字種: 符号付き数値が URL 文字列にそのまま(エンコードなしで)埋め込まれる現在の
    // 仕様を固定する。
    const image = makeImage({
      exif: {
        dateTime: null,
        gpsLatitude: -33.8688,
        gpsLongitude: -151.2093,
        width: null,
        height: null,
      },
    });
    render(<OverlayUI image={image} {...requiredProps} />);

    clickMapButton();

    expect(openUrl).toHaveBeenCalledWith('https://www.google.com/maps?q=-33.8688,-151.2093');
  });

  it('does not render the map button (and never calls openUrl) when GPS is absent', () => {
    // 同値分割: exif はあるが GPS が無い（未設定機種・位置情報オフ）
    const image = makeImage({
      exif: {
        dateTime: '2024:01:01 12:00:00',
        gpsLatitude: null,
        gpsLongitude: null,
        width: null,
        height: null,
      },
    });
    render(<OverlayUI image={image} {...requiredProps} />);

    expect(screen.queryByAltText('Location Map')).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
