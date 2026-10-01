// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the tauri bridge so the hook is exercised without a backend. The
// equal-random "next" selection logic lives entirely in Rust (playlist.rs) and
// is covered by cargo tests; from the hook's point of view getNextImage simply
// returns whatever ImageNavigationResult the backend hands back, so we pin the
// hook's *state machine* (loading flags, notices, concurrency guard, timer)
// rather than the randomness.
const getNextImage = vi.fn();
const getPreviousImage = vi.fn();
const undoDisplayCount = vi.fn();

vi.mock('../lib/tauri', () => ({
  getNextImage: (...a: unknown[]) => getNextImage(...a),
  getPreviousImage: (...a: unknown[]) => getPreviousImage(...a),
  undoDisplayCount: (...a: unknown[]) => undoDisplayCount(...a),
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
  undoDisplayCount.mockReset();
  undoDisplayCount.mockResolvedValue(undefined);
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

describe('displayToken (#65レビューM2)', () => {
  it('increments on every found result, even when the path repeats (single-item playlist)', async () => {
    getNextImage.mockResolvedValue(found('/only.jpg'));
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.loadNextImage();
    });
    const first = result.current.displayToken;

    await act(async () => {
      await result.current.loadNextImage();
    });
    const second = result.current.displayToken;

    expect(result.current.currentImage?.path).toBe('/only.jpg');
    expect(second).toBe(first + 1);
  });

  it('also increments on loadPreviousImage found results', async () => {
    getPreviousImage.mockResolvedValue(found('/prev.jpg'));
    const { result } = renderHook(() => useSlideshow());
    const before = result.current.displayToken;

    await act(async () => {
      await result.current.loadPreviousImage();
    });

    expect(result.current.displayToken).toBe(before + 1);
  });

  it('does not increment when the result is not "found" (emptyPlaylist/rootUnavailable/noHistory)', async () => {
    getNextImage.mockResolvedValue({ kind: 'emptyPlaylist' } satisfies ImageNavigationResult);
    const { result } = renderHook(() => useSlideshow());
    const before = result.current.displayToken;

    await act(async () => {
      await result.current.loadNextImage();
    });

    expect(result.current.displayToken).toBe(before);
  });
});

describe('continueInLastDirection (#65レビュー質問決定: onErrorは進行方向を引き継ぐ)', () => {
  it('defaults to next (forward) direction before any navigation has happened', async () => {
    getNextImage.mockResolvedValue(found('/a.jpg'));
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.continueInLastDirection();
    });

    expect(getNextImage).toHaveBeenCalledTimes(1);
    expect(getPreviousImage).not.toHaveBeenCalled();
  });

  it('continues backward (loadPreviousImage) after the most recent navigation was "previous" (onError while going back)', async () => {
    getNextImage.mockResolvedValue(found('/a.jpg'));
    getPreviousImage.mockResolvedValue(found('/prev.jpg'));
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.loadNextImage();
    });
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    getNextImage.mockClear();
    getPreviousImage.mockClear();

    // 「前へ」で戻ったばかりの画像がonErrorになったシナリオ:
    // continueInLastDirectionはさらに前へ戻る（次へ、ではない）。
    await act(async () => {
      await result.current.continueInLastDirection();
    });

    expect(getPreviousImage).toHaveBeenCalledTimes(1);
    expect(getNextImage).not.toHaveBeenCalled();
  });

  it('continues forward (loadNextImage) after the most recent navigation was "next"', async () => {
    getNextImage.mockResolvedValue(found('/a.jpg'));
    getPreviousImage.mockResolvedValue(found('/prev.jpg'));
    const { result } = renderHook(() => useSlideshow());

    await act(async () => {
      await result.current.loadPreviousImage();
    });
    await act(async () => {
      await result.current.loadNextImage();
    });
    getNextImage.mockClear();
    getPreviousImage.mockClear();

    await act(async () => {
      await result.current.continueInLastDirection();
    });

    expect(getNextImage).toHaveBeenCalledTimes(1);
    expect(getPreviousImage).not.toHaveBeenCalled();
  });
});

describe('auto-retry on error/rootUnavailable notices (#65レビューS3/S4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('retries automatically after `interval` ms when an invoke rejection sets an error notice (S3)', async () => {
    getNextImage.mockRejectedValueOnce('temporary glitch');
    const { result } = renderHook(() => useSlideshow(5000, true));

    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'error', message: 'temporary glitch' });
    getNextImage.mockClear();
    getNextImage.mockResolvedValue(found('/recovered.jpg'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(getNextImage).toHaveBeenCalledTimes(1);
    expect(result.current.currentImage?.path).toBe('/recovered.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('retries automatically after `interval` ms while rootUnavailable persists, and stops once the notice clears (S4: 文言を実挙動に一致させる)', async () => {
    getNextImage
      .mockResolvedValueOnce({ kind: 'rootUnavailable' } satisfies ImageNavigationResult)
      .mockResolvedValueOnce({ kind: 'rootUnavailable' } satisfies ImageNavigationResult)
      .mockResolvedValue(found('/reconnected.jpg'));
    const { result } = renderHook(() => useSlideshow(5000, true));

    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'rootUnavailable' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getNextImage).toHaveBeenCalledTimes(2);
    expect(result.current.notice).toEqual({ kind: 'rootUnavailable' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getNextImage).toHaveBeenCalledTimes(3);
    expect(result.current.currentImage?.path).toBe('/reconnected.jpg');
    expect(result.current.notice).toBeNull();

    // 復帰後はもう自動再試行しない。（#120: 画像が読み込まれないまま10秒経つと見張りが
    // 発動するため、その手前までで確認する。見張り自体は別 describe で検証）
    getNextImage.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(getNextImage).not.toHaveBeenCalled();
  });

  it('retries in the previous direction when rootUnavailable happened while going back', async () => {
    getNextImage.mockResolvedValue(found('/a.jpg'));
    getPreviousImage
      .mockResolvedValueOnce({ kind: 'rootUnavailable' } satisfies ImageNavigationResult)
      .mockResolvedValue(found('/prev.jpg'));
    const { result } = renderHook(() => useSlideshow(5000, true));

    await act(async () => {
      await result.current.loadNextImage();
    });
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.notice).toEqual({ kind: 'rootUnavailable' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(getPreviousImage).toHaveBeenCalledTimes(2);
    expect(result.current.currentImage?.path).toBe('/prev.jpg');
  });

  // #65レビュー2巡目S9(must): 一時停止中・設定画面表示中（＝呼び出し側が
  // isPlayingをfalseにしている間）は自動再試行が裏で進んではいけない。
  it('does not auto-retry while isPlaying is false (paused/settings open), even if the error persists', async () => {
    getNextImage.mockRejectedValue('temporary glitch');
    const { result, rerender } = renderHook(({ playing }) => useSlideshow(5000, playing), {
      initialProps: { playing: true },
    });

    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'error', message: 'temporary glitch' });

    // 一時停止（isPlaying=false）に切り替える。
    rerender({ playing: false });
    getNextImage.mockClear();

    // 表示間隔を大きく超えて待っても、一時停止中は再試行しない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(getNextImage).not.toHaveBeenCalled();
  });

  it('resumes auto-retry once isPlaying becomes true again after being paused', async () => {
    getNextImage.mockRejectedValue('temporary glitch');
    const { result, rerender } = renderHook(({ playing }) => useSlideshow(5000, playing), {
      initialProps: { playing: true },
    });

    await act(async () => {
      await result.current.loadNextImage();
    });
    rerender({ playing: false });
    getNextImage.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(getNextImage).not.toHaveBeenCalled(); // 前提: 一時停止中は再試行しない

    // 再開する。
    getNextImage.mockResolvedValue(found('/recovered.jpg'));
    rerender({ playing: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(getNextImage).toHaveBeenCalled();
    expect(result.current.currentImage?.path).toBe('/recovered.jpg');
  });

  it('does not auto-retry rootUnavailable while paused either', async () => {
    getNextImage.mockResolvedValue({ kind: 'rootUnavailable' } satisfies ImageNavigationResult);
    const { result, rerender } = renderHook(({ playing }) => useSlideshow(5000, playing), {
      initialProps: { playing: true },
    });

    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'rootUnavailable' });

    rerender({ playing: false });
    getNextImage.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(getNextImage).not.toHaveBeenCalled();
  });
});

describe('pause percentage uses the interval active when the timer started (#65レビューnit)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('stays within [0,100] and reflects the OLD interval when displayInterval changes mid-display then pauses', async () => {
    getNextImage.mockResolvedValue(found('/img.jpg'));
    const { result, rerender } = renderHook(
      ({ interval, playing }) => useSlideshow(interval, playing),
      { initialProps: { interval: 10000, playing: true } },
    );
    await act(async () => {
      await result.current.loadNextImage();
    });
    act(() => result.current.handleMediaReady());

    // 10秒間隔で3秒経過（30%）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // 再生中に間隔を5秒へ変更（このメディアの残り時間には影響しない設計）。
    rerender({ interval: 5000, playing: true });

    // 一時停止: 新しいintervalRef(5000)を分母にすると
    // ((5000-7000)/5000)*100 = -40 のようなおかしな値になっていたのが不具合。
    // 実際にタイマーが基準にしていた10000msを分母にした約30%になるはず。
    rerender({ interval: 5000, playing: false });

    expect(result.current.progressPercent).toBeGreaterThanOrEqual(0);
    expect(result.current.progressPercent).toBeLessThanOrEqual(100);
    expect(result.current.progressPercent).toBeGreaterThan(20);
    expect(result.current.progressPercent).toBeLessThan(40);
  });
});

type HookResult = { current: ReturnType<typeof useSlideshow> };

/** `path` を表示させ、その描画失敗（onError 相当）を通知する。直後の「次へ」は既定モックの '/next.jpg'。 */
async function showThenFail(result: HookResult, path: string) {
  getNextImage.mockResolvedValueOnce(found(path));
  await act(async () => {
    await result.current.loadNextImage();
  });
  await act(async () => {
    await result.current.handleMediaFailure(path);
  });
}

describe('broken media skipping (#120)', () => {
  beforeEach(() => {
    undoDisplayCount.mockResolvedValue(undefined);
    getNextImage.mockResolvedValue(found('/next.jpg'));
  });

  it('skips to the next image below the cap and shows no toast yet', async () => {
    const { result } = renderHook(() => useSlideshow());
    await showThenFail(result, '/bad1.jpg');
    expect(result.current.currentImage?.path).toBe('/next.jpg');
    expect(result.current.notice).toBeNull();
    expect(result.current.mediaSkipToast).toBeNull();
  });

  it('runs undo -> failure count -> next, in that order', async () => {
    const order: string[] = [];
    undoDisplayCount.mockImplementation(async () => {
      order.push('undo');
    });
    const { result } = renderHook(() => useSlideshow());
    getNextImage.mockResolvedValueOnce(found('/bad.jpg'));
    await act(async () => {
      await result.current.loadNextImage();
    });
    getNextImage.mockImplementation(async () => {
      order.push('next');
      return found('/next.jpg');
    });
    await act(async () => {
      await result.current.handleMediaFailure('/bad.jpg');
    });
    expect(order).toEqual(['undo', 'next']);
  });

  it('shows the skip toast from the 3rd consecutive failure, and it expires', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSlideshow());
      await showThenFail(result, '/1.jpg');
      await showThenFail(result, '/2.jpg');
      expect(result.current.mediaSkipToast).toBeNull();
      await showThenFail(result, '/3.jpg');
      expect(result.current.mediaSkipToast).toEqual({ count: 3 });
      act(() => {
        vi.advanceTimersByTime(6100);
      });
      expect(result.current.mediaSkipToast).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the toast as soon as a photo renders (success breaks the streak)', async () => {
    const { result } = renderHook(() => useSlideshow());
    for (const p of ['/1.jpg', '/2.jpg', '/3.jpg']) await showThenFail(result, p);
    expect(result.current.mediaSkipToast).not.toBeNull();
    act(() => {
      result.current.handleMediaReady();
    });
    expect(result.current.mediaSkipToast).toBeNull();
  });

  it('stops with mediaFailureStreak (not "all broken") after 10 in a row when the total is unknown', async () => {
    const { result } = renderHook(() => useSlideshow());
    for (let i = 0; i < 10; i++) await showThenFail(result, `/bad${i}.jpg`);
    expect(result.current.notice).toEqual({ kind: 'mediaFailureStreak' });
    expect(result.current.currentImage).toBeNull();
    expect(result.current.mediaSkipToast).toBeNull();
  });

  it('does not call a long run of broken files "all broken" when the playlist is larger', async () => {
    const { result } = renderHook(() => useSlideshow(10000, false, 5000));
    for (let i = 0; i < 10; i++) await showThenFail(result, `/bad${i}.jpg`);
    expect(result.current.notice).toEqual({ kind: 'mediaFailureStreak' });
  });

  it('stops with noReadableImages as soon as the failed set reaches the playlist total', async () => {
    const { result } = renderHook(() => useSlideshow(10000, false, 3));
    await showThenFail(result, '/a.jpg');
    await showThenFail(result, '/b.jpg');
    expect(result.current.notice).toBeNull();
    await showThenFail(result, '/c.jpg');
    expect(result.current.notice).toEqual({ kind: 'noReadableImages' });
    expect(result.current.currentImage).toBeNull();
  });

  it('a successful render (handleMediaReady) resets the consecutive-failure count', async () => {
    const { result } = renderHook(() => useSlideshow());
    for (let i = 0; i < 9; i++) await showThenFail(result, `/bad${i}.jpg`);
    act(() => {
      result.current.handleMediaReady();
    });
    await showThenFail(result, '/bad-next.jpg');
    expect(result.current.notice).toBeNull();
    expect(result.current.currentImage?.path).toBe('/next.jpg');
  });

  it('ignores a stale failure: the user moved to another photo while undo was in flight', async () => {
    let releaseUndo: () => void = () => {};
    undoDisplayCount.mockImplementation(
      () => new Promise<void>((resolve) => (releaseUndo = resolve)),
    );
    const { result } = renderHook(() => useSlideshow(10000, false, 0));
    getNextImage.mockResolvedValueOnce(found('/a.jpg'));
    await act(async () => {
      await result.current.loadNextImage();
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handleMediaFailure('/a.jpg');
    });
    // undo の待ち中に手動で次へ（正常な画像が出る）。
    getNextImage.mockResolvedValueOnce(found('/good.jpg'));
    await act(async () => {
      await result.current.loadNextImage();
    });
    await act(async () => {
      releaseUndo();
      await pending;
    });
    expect(result.current.currentImage?.path).toBe('/good.jpg');
    expect(getNextImage).toHaveBeenCalledTimes(2); // 古い失敗では続行の get_next_image を呼ばない
    // 古い失敗は数えない: 残り9件失敗してもまだ停止しない
    undoDisplayCount.mockReset();
    undoDisplayCount.mockResolvedValue(undefined);
    getNextImage.mockResolvedValue(found('/next.jpg'));
    for (let i = 0; i < 9; i++) await showThenFail(result, `/x${i}.jpg`);
    expect(result.current.notice).toBeNull();
  });

  it('skips a path that already failed this session without rendering it, undoing its count', async () => {
    const { result } = renderHook(() => useSlideshow());
    await showThenFail(result, '/bad.jpg');
    undoDisplayCount.mockClear();
    getNextImage
      .mockReset()
      .mockResolvedValueOnce(found('/bad.jpg'))
      .mockResolvedValueOnce(found('/good.jpg'));
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.currentImage?.path).toBe('/good.jpg');
    expect(undoDisplayCount).toHaveBeenCalledWith('/bad.jpg');
  });

  it('screens known-broken paths in the previous direction too (no count undo there)', async () => {
    const { result } = renderHook(() => useSlideshow());
    await showThenFail(result, '/bad.jpg');
    undoDisplayCount.mockClear();
    getPreviousImage
      .mockResolvedValueOnce(found('/bad.jpg'))
      .mockResolvedValueOnce(found('/good.jpg'));
    await act(async () => {
      await result.current.loadPreviousImage();
    });
    expect(result.current.currentImage?.path).toBe('/good.jpg');
    expect(undoDisplayCount).not.toHaveBeenCalled();
    expect(getPreviousImage).toHaveBeenCalledTimes(2);
  });

  it('stops (no endless loop) when every returned path is already known-broken', async () => {
    const { result } = renderHook(() => useSlideshow(10000, false, 1));
    await showThenFail(result, '/bad.jpg');
    // 総数1で失敗セットが1件 -> すぐに全件破損で停止している
    expect(result.current.notice).toEqual({ kind: 'noReadableImages' });
    getNextImage.mockReset().mockResolvedValue(found('/bad.jpg'));
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.notice).toEqual({ kind: 'noReadableImages' });
    expect(getNextImage.mock.calls.length).toBeLessThan(20);
  });

  it('a manual next after giving up recovers when the photo is readable', async () => {
    const { result } = renderHook(() => useSlideshow(10000, false, 3));
    for (const p of ['/a.jpg', '/b.jpg', '/c.jpg']) await showThenFail(result, p);
    expect(result.current.notice).toEqual({ kind: 'noReadableImages' });
    getNextImage.mockReset().mockResolvedValue(found('/fixed.jpg'));
    await act(async () => {
      await result.current.loadNextImage();
    });
    expect(result.current.currentImage?.path).toBe('/fixed.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('resumeAfterFailures clears the failed set and tries again (a transient failure is retried)', async () => {
    const { result } = renderHook(() => useSlideshow());
    for (let i = 0; i < 10; i++) await showThenFail(result, `/bad${i}.jpg`);
    expect(result.current.notice).toEqual({ kind: 'mediaFailureStreak' });
    getNextImage.mockReset().mockResolvedValue(found('/bad3.jpg'));
    await act(async () => {
      await result.current.resumeAfterFailures();
    });
    // 失敗セットが空なので /bad3.jpg を読み飛ばさず表示する。
    expect(result.current.currentImage?.path).toBe('/bad3.jpg');
    expect(result.current.notice).toBeNull();
  });

  it('initialize forgets the failed set, the counter and the toast', async () => {
    const { result } = renderHook(() => useSlideshow());
    for (let i = 0; i < 3; i++) await showThenFail(result, `/bad${i}.jpg`);
    expect(result.current.mediaSkipToast).not.toBeNull();
    getNextImage.mockReset().mockResolvedValue(found('/bad0.jpg'));
    await act(async () => {
      await result.current.initialize();
    });
    expect(result.current.currentImage?.path).toBe('/bad0.jpg');
    expect(result.current.mediaSkipToast).toBeNull();
    // カウンタも0に戻っている: 9件失敗してもまだ止まらない
    getNextImage.mockResolvedValue(found('/next.jpg'));
    for (let i = 0; i < 9; i++) await showThenFail(result, `/y${i}.jpg`);
    expect(result.current.notice).toBeNull();
  });
});

describe('media watchdog (#120)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    undoDisplayCount.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  async function show(result: HookResult, path: string) {
    getNextImage.mockResolvedValueOnce(found(path));
    await act(async () => {
      await result.current.loadNextImage();
    });
  }

  it('forces a skip when neither load nor error arrives within max(interval, 10s), and logs why', async () => {
    const { result } = renderHook(() => useSlideshow(10000, true));
    await show(result, '/stuck.jpg');
    getNextImage.mockResolvedValue(found('/after.jpg'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9900);
    });
    expect(undoDisplayCount).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(undoDisplayCount).toHaveBeenCalledWith('/stuck.jpg');
    expect(result.current.currentImage?.path).toBe('/after.jpg');
    const msg = warn.mock.calls.find((c) => String(c[0]).includes('media watchdog'));
    expect(msg).toBeTruthy();
    expect(msg![1]).toMatchObject({ path: '/stuck.jpg', navigationInFlight: false });
  });

  it('is disarmed by a normal load (handleMediaReady), even a late one', async () => {
    const { result } = renderHook(() => useSlideshow(10000, true));
    await show(result, '/slow.jpg');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    act(() => {
      result.current.handleMediaReady();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // タイマーが張られるが、見張りは発動しない
    });
    expect(undoDisplayCount).not.toHaveBeenCalledWith('/slow.jpg');
  });

  it('is disarmed by an error report', async () => {
    const { result } = renderHook(() => useSlideshow(10000, true));
    await show(result, '/bad.jpg');
    getNextImage.mockResolvedValue(found('/n.jpg'));
    await act(async () => {
      await result.current.handleMediaFailure('/bad.jpg');
    });
    undoDisplayCount.mockClear();
    getNextImage.mockClear();
    // /n.jpg は読み込まれない前提なので、次の見張りが /n.jpg で発動する（/bad.jpg の二重発動は無い）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10100);
    });
    const undone = undoDisplayCount.mock.calls.map((c) => c[0]);
    expect(undone[0]).toBe('/n.jpg');
    expect(undone).not.toContain('/bad.jpg');
  });

  it('is replaced when the user moves to another photo (no firing for the old one)', async () => {
    const { result } = renderHook(() => useSlideshow(10000, true));
    await show(result, '/a.jpg');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await show(result, '/b.jpg');
    getNextImage.mockResolvedValue(found('/c.jpg'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000); // /a.jpg の元の期限(10s)を過ぎる
    });
    expect(undoDisplayCount).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(undoDisplayCount.mock.calls.map((c) => c[0])).toEqual(['/b.jpg']);
  });

  it('does not force a skip while paused, and fires after resuming', async () => {
    const { result, rerender } = renderHook(({ playing }) => useSlideshow(10000, playing), {
      initialProps: { playing: false },
    });
    await show(result, '/p.jpg');
    getNextImage.mockResolvedValue(found('/after.jpg'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25000);
    });
    expect(undoDisplayCount).not.toHaveBeenCalled();
    rerender({ playing: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10100);
    });
    expect(undoDisplayCount).toHaveBeenCalledWith('/p.jpg');
  });

  it('releases its timer on unmount', async () => {
    const { result, unmount } = renderHook(() => useSlideshow(10000, true));
    await show(result, '/gone.jpg');
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(undoDisplayCount).not.toHaveBeenCalled();
  });

  it('warns when undo_display_count is slow (diagnostic)', async () => {
    const { result } = renderHook(() => useSlideshow(10000, true));
    await show(result, '/bad.jpg');
    undoDisplayCount.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    );
    getNextImage.mockResolvedValue(found('/n.jpg'));
    await act(async () => {
      const p = result.current.handleMediaFailure('/bad.jpg');
      await vi.advanceTimersByTimeAsync(1600);
      await p;
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('undo_display_count took'))).toBe(
      true,
    );
  });
});
