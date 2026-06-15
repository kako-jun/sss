// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the tauri bridge so the hook is exercised without a backend. The
// equal-random "next" selection logic lives entirely in Rust (playlist.rs) and
// is covered by cargo tests; from the hook's point of view getNextImage simply
// returns whatever image the backend hands back, so we pin the hook's *state
// machine* (loading flags, play/pause, error handling, auto-advance timer)
// rather than the randomness.
const getNextImage = vi.fn();
const getPreviousImage = vi.fn();

vi.mock('../lib/tauri', () => ({
  getNextImage: (...a: unknown[]) => getNextImage(...a),
  getPreviousImage: (...a: unknown[]) => getPreviousImage(...a),
}));

import { useSlideshow } from './useSlideshow';
import type { ImageInfo } from '../types';

function makeImage(path: string, isVideo = false): ImageInfo {
  return {
    path,
    optimizedPath: null,
    isVideo,
    width: 100,
    height: 100,
    fileSize: 1,
    exif: null,
    displayCount: 0,
    lastDisplayed: null,
  };
}

beforeEach(() => {
  getNextImage.mockReset();
  getPreviousImage.mockReset();
});

describe('useSlideshow initial state', () => {
  it('starts paused, not loading, no image, no error, progress 0', () => {
    const { result } = renderHook(() => useSlideshow());
    expect(result.current.currentImage).toBeNull();
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.progress).toBe(0);
  });
});

describe('loadNextImage', () => {
  it('sets currentImage from the backend result', async () => {
    getNextImage.mockResolvedValue(makeImage('/a.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.currentImage?.path).toBe('/a.jpg');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('sets "No more images" error when backend returns null', async () => {
    getNextImage.mockResolvedValue(null);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.currentImage).toBeNull();
    expect(result.current.error).toBe('No more images');
  });

  it('captures the error message when backend rejects with an Error', async () => {
    getNextImage.mockRejectedValue(new Error('disk gone'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.error).toBe('disk gone');
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to "Failed to load image" when rejection is not an Error', async () => {
    getNextImage.mockRejectedValue('plain string');
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.error).toBe('Failed to load image');
  });
});

describe('loadPreviousImage', () => {
  it('sets currentImage when backend returns an image', async () => {
    getPreviousImage.mockResolvedValue(makeImage('/prev.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.currentImage?.path).toBe('/prev.jpg');
  });

  it('does NOT set an error when backend returns null (history boundary)', async () => {
    getPreviousImage.mockResolvedValue(null);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    // characterization: unlike loadNextImage, the previous path is silent on null
    expect(result.current.error).toBeNull();
    expect(result.current.currentImage).toBeNull();
  });

  it('captures the error message when backend rejects', async () => {
    getPreviousImage.mockRejectedValue(new Error('prev boom'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.error).toBe('prev boom');
  });
});

describe('play / pause', () => {
  it('play sets isPlaying true, pause sets it false', () => {
    const { result } = renderHook(() => useSlideshow());
    act(() => result.current.play());
    expect(result.current.isPlaying).toBe(true);
    act(() => result.current.pause());
    expect(result.current.isPlaying).toBe(false);
  });
});

describe('initialize', () => {
  it('loads the first image and auto-plays by default', async () => {
    getNextImage.mockResolvedValue(makeImage('/first.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.initialize();
    });
    expect(result.current.currentImage?.path).toBe('/first.jpg');
    expect(result.current.isPlaying).toBe(true);
  });

  it('loads the first image but stays paused when autoPlay is false', async () => {
    getNextImage.mockResolvedValue(makeImage('/first.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.initialize(false);
    });
    expect(result.current.currentImage?.path).toBe('/first.jpg');
    expect(result.current.isPlaying).toBe(false);
  });
});

describe('handleVideoEnded', () => {
  it('advances to the next image only while playing', async () => {
    getNextImage.mockResolvedValue(makeImage('/next.jpg'));
    const { result } = renderHook(() => useSlideshow());

    // not playing -> no advance
    await act(async () => {
      result.current.handleVideoEnded();
    });
    expect(getNextImage).not.toHaveBeenCalled();

    act(() => result.current.play());
    await act(async () => {
      result.current.handleVideoEnded();
    });
    expect(getNextImage).toHaveBeenCalledTimes(1);
  });
});

// Timer teardown (unmount + clearAllTimers + useRealTimers) is handled globally
// in src/test/setup.ts so a queued progress-interval callback can never fire
// after the jsdom env is torn down.
describe('auto-advance timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('advances after the interval and updates progress while playing an image', async () => {
    getNextImage.mockResolvedValue(makeImage('/img.jpg', false));
    const { result } = renderHook(() => useSlideshow(1000));

    await act(async () => {
      await result.current.loadNextImage();
    });
    getNextImage.mockClear();

    act(() => result.current.play());

    // progress interval (~16ms) ticks toward 100
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.progress).toBeGreaterThan(0);
    expect(result.current.progress).toBeLessThanOrEqual(100);

    // hitting the full interval triggers loadNextImage
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getNextImage).toHaveBeenCalled();
  });

  it('does NOT start the auto-advance timer for a video (driven by onEnded instead)', async () => {
    getNextImage.mockResolvedValue(makeImage('/clip.mp4', true));
    const { result } = renderHook(() => useSlideshow(1000));

    await act(async () => {
      await result.current.loadNextImage();
    });
    getNextImage.mockClear();

    act(() => result.current.play());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // video path: no timer-driven advance, progress stays reset at 0
    expect(getNextImage).not.toHaveBeenCalled();
    expect(result.current.progress).toBe(0);
  });
});
