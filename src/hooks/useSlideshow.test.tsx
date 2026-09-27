// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the tauri bridge so the hook is exercised without a backend. The
// equal-random "next" selection logic lives entirely in Rust (playlist.rs) and
// is covered by cargo tests; from the hook's point of view getNextImage simply
// returns whatever ImageNavigationResult the backend hands back, so we pin the
// hook's *state machine* (loading flags, notices, concurrency guard, timer)
// rather than the randomness.
const getNextImage = vi.fn();
const getPreviousImage = vi.fn();

vi.mock('../lib/tauri', () => ({
  getNextImage: (...a: unknown[]) => getNextImage(...a),
  getPreviousImage: (...a: unknown[]) => getPreviousImage(...a),
}));

import { useSlideshow } from './useSlideshow';
import type { ImageInfo, ImageNavigationResult } from '../types';

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

function found(path: string, isVideo = false): ImageNavigationResult {
  return { kind: 'found', data: makeImage(path, isVideo) };
}

beforeEach(() => {
  getNextImage.mockReset();
  getPreviousImage.mockReset();
});

describe('useSlideshow initial state', () => {
  it('starts with no image, no notice, not loading, progress 0/0', () => {
    const { result } = renderHook(() => useSlideshow());
    expect(result.current.currentImage).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.notice).toBeNull();
    expect(result.current.progressPercent).toBe(0);
    expect(result.current.progressDurationMs).toBe(0);
  });
});

describe('loadNextImage: ImageNavigationResult branching (#65)', () => {
  it('sets currentImage on a "found" result and clears any notice', async () => {
    getNextImage.mockResolvedValue(found('/a.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.currentImage?.path).toBe('/a.jpg');
    expect(result.current.notice).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('sets an emptyPlaylist notice and clears currentImage on "emptyPlaylist"', async () => {
    getNextImage.mockResolvedValue({ kind: 'emptyPlaylist' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.currentImage).toBeNull();
    expect(result.current.notice).toEqual({ kind: 'emptyPlaylist' });
  });

  it('keeps the previous image and sets a rootUnavailable notice on "rootUnavailable"', async () => {
    getNextImage.mockResolvedValueOnce(found('/first.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });

    getNextImage.mockResolvedValueOnce({
      kind: 'rootUnavailable',
    } satisfies ImageNavigationResult);
    await act(async () => {
      await result.current.loadNextImage();
    });

    // #65問題: フォルダ接続不可時は直前の画像を維持する（消さない）。
    expect(result.current.currentImage?.path).toBe('/first.jpg');
    expect(result.current.notice).toEqual({ kind: 'rootUnavailable' });
  });

  it('auto-retries on "loadFailed" until it finds an image (auto-advance, #62/#63コメント由来)', async () => {
    getNextImage
      .mockResolvedValueOnce({ kind: 'loadFailed' } satisfies ImageNavigationResult)
      .mockResolvedValueOnce({ kind: 'loadFailed' } satisfies ImageNavigationResult)
      .mockResolvedValueOnce(found('/third.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(getNextImage).toHaveBeenCalledTimes(3);
    expect(result.current.currentImage?.path).toBe('/third.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('gives up with a loadFailedGaveUp notice after the consecutive-failure cap', async () => {
    getNextImage.mockResolvedValue({ kind: 'loadFailed' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'loadFailedGaveUp' });
    // 無制限には再試行しない（呼び出し回数に上限があること）
    expect(getNextImage.mock.calls.length).toBeGreaterThan(1);
    expect(getNextImage.mock.calls.length).toBeLessThan(50);
  });

  it('captures the error message via String(err) on rejection (not instanceof-Error branching, 問題9)', async () => {
    getNextImage.mockRejectedValue('plain string reason');
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'error', message: 'plain string reason' });
  });

  it('captures Error rejections via String(err) too', async () => {
    getNextImage.mockRejectedValue(new Error('disk gone'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'error', message: 'Error: disk gone' });
  });
});

describe('loadPreviousImage', () => {
  it('sets currentImage when backend returns "found"', async () => {
    getPreviousImage.mockResolvedValue(found('/prev.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.currentImage?.path).toBe('/prev.jpg');
  });

  it('does nothing (no notice, no currentImage change) on "noHistory" (history boundary)', async () => {
    getPreviousImage.mockResolvedValue({ kind: 'noHistory' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.currentImage).toBeNull();
  });

  // #65: loadPreviousImage は loadNextImage の applyNextResult を再利用せず、
  // ImageNavigationResult の分岐を独自実装している（noHistoryだけが違う）。
  // found/noHistory以外の分岐が対称に抜け落ちていたため追加する（観点の欠落防止）。
  it('keeps the previous image and sets a rootUnavailable notice on "rootUnavailable"', async () => {
    getPreviousImage.mockResolvedValueOnce(found('/first.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });

    getPreviousImage.mockResolvedValueOnce({
      kind: 'rootUnavailable',
    } satisfies ImageNavigationResult);
    await act(async () => {
      await result.current.loadPreviousImage();
    });

    expect(result.current.currentImage?.path).toBe('/first.jpg');
    expect(result.current.notice).toEqual({ kind: 'rootUnavailable' });
  });

  it('sets an emptyPlaylist notice and clears currentImage on "emptyPlaylist"', async () => {
    getPreviousImage.mockResolvedValue({ kind: 'emptyPlaylist' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.currentImage).toBeNull();
    expect(result.current.notice).toEqual({ kind: 'emptyPlaylist' });
  });

  it('auto-retries on "loadFailed" until it finds an image', async () => {
    getPreviousImage
      .mockResolvedValueOnce({ kind: 'loadFailed' } satisfies ImageNavigationResult)
      .mockResolvedValueOnce({ kind: 'loadFailed' } satisfies ImageNavigationResult)
      .mockResolvedValueOnce(found('/older.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(getPreviousImage).toHaveBeenCalledTimes(3);
    expect(result.current.currentImage?.path).toBe('/older.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('gives up with a loadFailedGaveUp notice after the consecutive-failure cap', async () => {
    getPreviousImage.mockResolvedValue({ kind: 'loadFailed' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.notice).toEqual({ kind: 'loadFailedGaveUp' });
    expect(getPreviousImage.mock.calls.length).toBeGreaterThan(1);
    expect(getPreviousImage.mock.calls.length).toBeLessThan(50);
  });

  it('captures rejections via String(err), independently from loadNextImage', async () => {
    getPreviousImage.mockRejectedValue(new Error('disk gone'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.notice).toEqual({ kind: 'error', message: 'Error: disk gone' });
  });
});

// 決定表: 「読込失敗の連続上限-1／上限／上限+1」を next/previous 両方で明示的に
// ピン留めする。#65実装の MAX_CONSECUTIVE_LOAD_FAILURES は5（フックのプライベート
// 定数でエクスポートされていないため実測値を直書きする。変わったらこのテストが
// 赤くなって気付ける）。
describe('loadNextImage/loadPreviousImage: consecutive-failure cap boundary (上限-1/上限/上限+1)', () => {
  const MAX = 5;

  it('loadNextImage: cap-1 (4) failures then success does NOT give up (calls exactly 5 times)', async () => {
    for (let i = 0; i < MAX - 1; i++) {
      getNextImage.mockResolvedValueOnce({ kind: 'loadFailed' } satisfies ImageNavigationResult);
    }
    getNextImage.mockResolvedValueOnce(found('/saved-at-last-try.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(getNextImage).toHaveBeenCalledTimes(MAX);
    expect(result.current.currentImage?.path).toBe('/saved-at-last-try.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('loadNextImage: exactly cap (5) consecutive failures gives up after exactly 5 calls', async () => {
    getNextImage.mockResolvedValue({ kind: 'loadFailed' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(getNextImage).toHaveBeenCalledTimes(MAX);
    expect(result.current.notice).toEqual({ kind: 'loadFailedGaveUp' });
  });

  it('loadPreviousImage: cap-1 (4) failures then success does NOT give up (calls exactly 5 times)', async () => {
    for (let i = 0; i < MAX - 1; i++) {
      getPreviousImage.mockResolvedValueOnce({
        kind: 'loadFailed',
      } satisfies ImageNavigationResult);
    }
    getPreviousImage.mockResolvedValueOnce(found('/saved-at-last-try.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(getPreviousImage).toHaveBeenCalledTimes(MAX);
    expect(result.current.currentImage?.path).toBe('/saved-at-last-try.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('loadPreviousImage: exactly cap (5) consecutive failures gives up after exactly 5 calls', async () => {
    getPreviousImage.mockResolvedValue({ kind: 'loadFailed' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(getPreviousImage).toHaveBeenCalledTimes(MAX);
    expect(result.current.notice).toEqual({ kind: 'loadFailedGaveUp' });
  });
});

describe('concurrency guard + request id (#65 問題3)', () => {
  it('ignores an overlapping loadNextImage call while one is already in flight', async () => {
    let resolveFirst!: (v: ImageNavigationResult) => void;
    getNextImage.mockImplementationOnce(
      () =>
        new Promise<ImageNavigationResult>((res) => {
          resolveFirst = res;
        }),
    );
    const { result } = renderHook(() => useSlideshow());

    let firstDone = false;
    const firstCall = act(async () => {
      await result.current.loadNextImage().then(() => {
        firstDone = true;
      });
    });

    // 1件目がまだ解決していない間に2件目を呼んでも、バックエンドは1回しか叩かれない。
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(getNextImage).toHaveBeenCalledTimes(1);
    expect(firstDone).toBe(false);

    resolveFirst(found('/only.jpg'));
    await firstCall;
    expect(result.current.currentImage?.path).toBe('/only.jpg');
  });

  it('the concurrency guard also blocks loadPreviousImage while loadNextImage is in flight', async () => {
    let resolveFirst!: (v: ImageNavigationResult) => void;
    getNextImage.mockImplementationOnce(
      () =>
        new Promise<ImageNavigationResult>((res) => {
          resolveFirst = res;
        }),
    );
    const { result } = renderHook(() => useSlideshow());

    const firstCall = act(async () => {
      await result.current.loadNextImage();
    });

    await act(async () => {
      await result.current.loadPreviousImage();
    });
    // in-flightの next が終わるまで previous は叩かれない（問題3: 手動操作の重なりで
    // 見ていない画像がカウントされる/応答順逆転を防ぐガード）。
    expect(getPreviousImage).not.toHaveBeenCalled();

    resolveFirst(found('/next.jpg'));
    await firstCall;
    expect(result.current.currentImage?.path).toBe('/next.jpg');
  });

  // 対称性: 逆方向（previousがin-flightの間のnext）と、同方向の連打（previousの
  // 二重呼び出し）も同じガードで防がれることを確認する（決定表の欠落分）。
  it('blocks an overlapping loadNextImage call while loadPreviousImage is in flight (reverse direction)', async () => {
    let resolveFirst!: (v: ImageNavigationResult) => void;
    getPreviousImage.mockImplementationOnce(
      () =>
        new Promise<ImageNavigationResult>((res) => {
          resolveFirst = res;
        }),
    );
    const { result } = renderHook(() => useSlideshow());

    const firstCall = act(async () => {
      await result.current.loadPreviousImage();
    });

    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(getNextImage).not.toHaveBeenCalled();

    resolveFirst(found('/prev.jpg'));
    await firstCall;
    expect(result.current.currentImage?.path).toBe('/prev.jpg');
  });

  it('ignores an overlapping loadPreviousImage call while another loadPreviousImage is already in flight', async () => {
    let resolveFirst!: (v: ImageNavigationResult) => void;
    getPreviousImage.mockImplementationOnce(
      () =>
        new Promise<ImageNavigationResult>((res) => {
          resolveFirst = res;
        }),
    );
    const { result } = renderHook(() => useSlideshow());

    const firstCall = act(async () => {
      await result.current.loadPreviousImage();
    });

    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(getPreviousImage).toHaveBeenCalledTimes(1);

    resolveFirst(found('/prev-only.jpg'));
    await firstCall;
    expect(result.current.currentImage?.path).toBe('/prev-only.jpg');
  });
});

describe('unmount cleanup (#65)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('clears the pending advance timer on unmount so it never fires afterwards', async () => {
    getNextImage.mockResolvedValue(found('/img.jpg'));
    const { result, unmount } = renderHook(() => useSlideshow(5000, true));

    await act(async () => {
      await result.current.loadNextImage();
    });
    act(() => result.current.handleMediaReady());
    getNextImage.mockClear();

    unmount();

    // アンマウント後にタイマーが生きていれば、ここでgetNextImageが呼ばれてしまう
    // （デタッチされたフックインスタンスの状態を更新しようとして警告も出うる）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getNextImage).not.toHaveBeenCalled();
  });
});

describe('initialize', () => {
  it('loads the first image (autoplay is decided by the caller-supplied isPlaying, not here)', async () => {
    getNextImage.mockResolvedValue(found('/first.jpg'));
    const { result } = renderHook(() => useSlideshow());
    await act(async () => {
      await result.current.initialize();
    });
    expect(result.current.currentImage?.path).toBe('/first.jpg');
  });
});

describe('handleMediaReady + auto-advance timer (#65 問題6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // #65: 表示間隔はclampDisplayIntervalで最低5秒に丸められる（問題7）ため、
  // ここでは丸められない最小値である5000msを使う。
  it('does not start the timer until handleMediaReady (img onLoad) fires, even while playing', async () => {
    getNextImage.mockResolvedValue(found('/img.jpg'));
    const { result } = renderHook(() => useSlideshow(5000, true));

    await act(async () => {
      await result.current.loadNextImage();
    });
    getNextImage.mockClear();

    // 画像はまだ「表示開始」していない(onLoad未発火)ので、intervalが過ぎても進まない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getNextImage).not.toHaveBeenCalled();

    act(() => result.current.handleMediaReady());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getNextImage).toHaveBeenCalled();
  });

  it('sets progressDurationMs to the remaining time and target 100 once running', async () => {
    getNextImage.mockResolvedValue(found('/img.jpg'));
    const { result } = renderHook(() => useSlideshow(5000, true));
    await act(async () => {
      await result.current.loadNextImage();
    });
    act(() => result.current.handleMediaReady());

    expect(result.current.progressDurationMs).toBe(5000);
    expect(result.current.progressPercent).toBe(100);
  });

  it('freezes progress (duration 0) and remembers the remaining time when isPlaying goes false', async () => {
    getNextImage.mockResolvedValue(found('/img.jpg'));
    const { result, rerender } = renderHook(({ playing }) => useSlideshow(5000, playing), {
      initialProps: { playing: true },
    });
    await act(async () => {
      await result.current.loadNextImage();
    });
    act(() => result.current.handleMediaReady());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    rerender({ playing: false });

    expect(result.current.progressDurationMs).toBe(0);
    expect(result.current.progressPercent).toBeGreaterThan(0);
    expect(result.current.progressPercent).toBeLessThan(100);

    getNextImage.mockClear();
    // 一時停止中はいくら時間が経っても進まない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getNextImage).not.toHaveBeenCalled();

    // 再開すると、残り時間(約3000ms)経過後に進む。
    rerender({ playing: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(getNextImage).toHaveBeenCalled();
  });

  it('does not start the auto-advance timer for a video (driven by onEnded/Slideshow instead)', async () => {
    getNextImage.mockResolvedValue(found('/clip.mp4', true));
    const { result } = renderHook(() => useSlideshow(5000, true));

    await act(async () => {
      await result.current.loadNextImage();
    });
    getNextImage.mockClear();

    // handleMediaReadyは<img>専用。動画では呼ばれない想定だが、呼ばれても無視される。
    act(() => result.current.handleMediaReady());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getNextImage).not.toHaveBeenCalled();
    expect(result.current.progressPercent).toBe(0);
  });
});
