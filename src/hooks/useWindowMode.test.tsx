// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const win = {
  isFullscreen: vi.fn(),
  onResized: vi.fn(),
  setFullscreen: vi.fn(),
  setDecorations: vi.fn(),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => win,
}));

import { useWindowMode } from './useWindowMode';

const t = ((key: string) => key) as Parameters<typeof useWindowMode>[0];

let onFailure: ReturnType<typeof vi.fn>;
let onCleared: ReturnType<typeof vi.fn>;
let resizeCb: (() => void) | null;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onFailure = vi.fn();
  onCleared = vi.fn();
  resizeCb = null;
  unlisten = vi.fn();
  win.isFullscreen.mockReset().mockResolvedValue(true);
  win.onResized.mockReset().mockImplementation(async (cb: () => void) => {
    resizeCb = cb;
    return unlisten;
  });
  win.setFullscreen.mockReset().mockResolvedValue(undefined);
  win.setDecorations.mockReset().mockResolvedValue(undefined);
});

function setup() {
  return renderHook(() => useWindowMode(t, onFailure, onCleared));
}

describe('useWindowMode: OS sync (#103)', () => {
  it('starts as fullscreen, then adopts the real state from isFullscreen()', async () => {
    win.isFullscreen.mockResolvedValue(false);
    const { result } = setup();
    expect(result.current.isFullscreen).toBe(true);
    await waitFor(() => expect(result.current.isFullscreen).toBe(false));
  });

  it('re-reads the real state on every onResized', async () => {
    const { result } = setup();
    await waitFor(() => expect(resizeCb).not.toBeNull());
    win.isFullscreen.mockResolvedValue(false);
    await act(async () => {
      resizeCb!();
    });
    await waitFor(() => expect(result.current.isFullscreen).toBe(false));
  });

  it('unregisters the resize listener on unmount', async () => {
    const { unmount } = setup();
    await waitFor(() => expect(resizeCb).not.toBeNull());
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe('useWindowMode: toggle', () => {
  it('toggles fullscreen and decorations together, and clears the failure notice', async () => {
    const { result } = setup();
    await waitFor(() => expect(win.isFullscreen).toHaveBeenCalled());
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.setDecorations).toHaveBeenCalledWith(true);
    expect(result.current.isFullscreen).toBe(false);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('alternates on repeated toggles (the returned function reads the latest state)', async () => {
    const { result } = setup();
    await waitFor(() => expect(win.isFullscreen).toHaveBeenCalled());
    for (const expected of [false, true, false]) {
      await act(async () => {
        await result.current.toggleWindowMode();
      });
      expect(win.setFullscreen).toHaveBeenLastCalledWith(expected);
      expect(result.current.isFullscreen).toBe(expected);
    }
  });
});

describe('useWindowMode: failures re-sync to the real state (#103)', () => {
  it('notifies and keeps the displayed mode when setFullscreen rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    win.setFullscreen.mockRejectedValue(new Error('not allowed'));
    const { result } = setup();
    await waitFor(() => expect(win.isFullscreen).toHaveBeenCalled());
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(onFailure).toHaveBeenCalledWith('windowModeToggleFailed');
    expect(onCleared).not.toHaveBeenCalled();
    expect(result.current.isFullscreen).toBe(true);
    // 部分失敗に備え、実態(フルスクリーン)に合わせて装飾を非表示へ戻す
    expect(win.setDecorations).toHaveBeenCalledWith(false);
    errorSpy.mockRestore();
  });

  it('re-syncs decorations to the real state when setFullscreen succeeds but setDecorations fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    win.isFullscreen.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
    win.setDecorations.mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
    const { result } = setup();
    await waitFor(() => expect(win.isFullscreen).toHaveBeenCalled());
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    // 1回目: 切替(!next=true)で失敗、2回目: 実態(false)に合わせて !actual=true を試行
    expect(win.setDecorations).toHaveBeenNthCalledWith(1, true);
    expect(win.setDecorations).toHaveBeenNthCalledWith(2, true);
    expect(result.current.isFullscreen).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('logs when re-syncing decorations also fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    win.isFullscreen.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
    win.setDecorations.mockRejectedValue(new Error('denied'));
    const { result } = setup();
    await waitFor(() => expect(win.isFullscreen).toHaveBeenCalled());
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Failed to re-sync window decorations:',
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('logs when the real fullscreen state cannot be read during re-sync', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    win.isFullscreen.mockReset().mockResolvedValueOnce(true).mockRejectedValue(new Error('x'));
    win.setFullscreen.mockRejectedValue(new Error('denied'));
    const { result } = setup();
    await waitFor(() => expect(win.isFullscreen).toHaveBeenCalled());
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Failed to re-sync window mode:',
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
