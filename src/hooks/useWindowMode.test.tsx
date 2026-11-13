// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const win = {
  isFullscreen: vi.fn(),
  isDecorated: vi.fn(),
  onResized: vi.fn(),
  setFullscreen: vi.fn(),
  setDecorations: vi.fn(),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => win,
}));
const isWaylandSession = vi.fn();
vi.mock('../lib/tauri', () => ({
  isWaylandSession: (...a: unknown[]) => isWaylandSession(...a),
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
  win.isDecorated.mockReset().mockResolvedValue(false);
  isWaylandSession.mockReset().mockResolvedValue(false);
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

// #164: ウィンドウモードなのに OS の装飾（タイトルバー）が無いとき（Wayland で装飾を後付け
// できない場合）だけ needsDragRegion が true になる。
describe('needsDragRegion (#164)', () => {
  /** マイクロタスクを流して非同期の取得結果を反映させる */
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** 起動時の実態を設定して描画し、反映まで待つ */
  async function setupWith(real: { fullscreen: boolean; decorated: boolean }) {
    win.isFullscreen.mockResolvedValue(real.fullscreen);
    win.isDecorated.mockResolvedValue(real.decorated);
    const hook = setup();
    await flush();
    return hook;
  }

  /** setDecorations(true) を無視する Wayland 風の状態付きウィンドウ */
  function installStatefulWindow(opts: { honorDecorations: boolean; fullscreen: boolean }) {
    const state = { fs: opts.fullscreen, dec: false };
    win.isFullscreen.mockImplementation(async () => state.fs);
    win.isDecorated.mockImplementation(async () => state.dec);
    win.setFullscreen.mockImplementation(async (v: boolean) => {
      await Promise.resolve();
      state.fs = v;
    });
    win.setDecorations.mockImplementation(async (v: boolean) => {
      await Promise.resolve();
      if (opts.honorDecorations) state.dec = v;
    });
    return state;
  }

  it('is false while fullscreen even without decorations', async () => {
    const { result } = await setupWith({ fullscreen: true, decorated: false });
    expect(result.current.isFullscreen).toBe(true);
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('is false in window mode when the window is decorated', async () => {
    const { result } = await setupWith({ fullscreen: false, decorated: true });
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('is true in window mode when the window has no decorations (Wayland)', async () => {
    const { result } = await setupWith({ fullscreen: false, decorated: false });
    expect(result.current.needsDragRegion).toBe(true);
  });

  it('stays true after switching to window mode when setDecorations(true) succeeds but isDecorated() is still false', async () => {
    installStatefulWindow({ honorDecorations: false, fullscreen: true });
    const { result } = setup();
    await flush();
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(win.setDecorations).toHaveBeenCalledWith(true);
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(true);
  });

  it('is false after switching to window mode when isDecorated() reports true', async () => {
    installStatefulWindow({ honorDecorations: true, fullscreen: true });
    const { result } = setup();
    await flush();
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('goes back to false when returning to fullscreen', async () => {
    installStatefulWindow({ honorDecorations: false, fullscreen: false });
    const { result } = setup();
    await flush();
    expect(result.current.needsDragRegion).toBe(true);
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(result.current.isFullscreen).toBe(true);
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('re-reads isDecorated() on every onResized, in both directions', async () => {
    const { result } = await setupWith({ fullscreen: false, decorated: false });
    expect(result.current.needsDragRegion).toBe(true);
    win.isDecorated.mockResolvedValue(true);
    await act(async () => {
      resizeCb!();
    });
    await flush();
    expect(result.current.needsDragRegion).toBe(false);
    win.isDecorated.mockResolvedValue(false);
    await act(async () => {
      resizeCb!();
    });
    await flush();
    expect(result.current.needsDragRegion).toBe(true);
  });

  it('keeps the current state when isDecorated() rejects at startup (async reject)', async () => {
    win.isFullscreen.mockResolvedValue(false);
    win.isDecorated.mockRejectedValue(new Error('x'));
    const { result } = setup();
    await flush();
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('keeps the current state when isDecorated() throws synchronously at startup', async () => {
    win.isFullscreen.mockResolvedValue(false);
    win.isDecorated.mockImplementation(() => {
      throw new Error('sync');
    });
    const { result } = setup();
    await flush();
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('treats a failed isDecorated() right after switching to window mode as decorated (no band)', async () => {
    const { result } = await setupWith({ fullscreen: true, decorated: false });
    win.isDecorated.mockRejectedValue(new Error('x'));
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('shows no band when isDecorated() fails right after switching to fullscreen', async () => {
    const { result } = await setupWith({ fullscreen: false, decorated: true });
    win.isDecorated.mockRejectedValue(new Error('x'));
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(result.current.isFullscreen).toBe(true);
    expect(result.current.needsDragRegion).toBe(false);
  });

  // 起動時の2つの非同期取得（isFullscreen / isDecorated）のどちらが先に解決しても、
  // 実態が「ウィンドウモード+装飾あり」なら帯が一瞬でも出てはいけない。
  it.each([
    ['isFullscreen first', true],
    ['isDecorated first', false],
  ])(
    'never shows the band for window mode + decorated regardless of resolve order (%s)',
    async (_n, fullscreenFirst) => {
      const fs = deferred<boolean>();
      const dec = deferred<boolean>();
      win.isFullscreen.mockReturnValue(fs.promise);
      win.isDecorated.mockReturnValue(dec.promise);
      const seen: boolean[] = [];
      renderHook(() => {
        const r = useWindowMode(t, onFailure, onCleared);
        seen.push(r.needsDragRegion);
        return r;
      });
      const steps = fullscreenFirst
        ? [() => fs.resolve(false), () => dec.resolve(true)]
        : [() => dec.resolve(true), () => fs.resolve(false)];
      for (const step of steps) {
        step();
        await flush();
      }
      expect(seen).not.toContain(true);
    },
  );

  it('does not let a stale isDecorated() response overwrite a newer one (resize twice, first delayed)', async () => {
    const { result } = await setupWith({ fullscreen: false, decorated: true });
    const first = deferred<boolean>();
    win.isDecorated.mockReturnValueOnce(first.promise).mockResolvedValueOnce(false);
    await act(async () => {
      resizeCb!(); // 1回目（遅延）
      resizeCb!(); // 2回目（false を即返す）
    });
    await flush();
    expect(result.current.needsDragRegion).toBe(true);
    first.resolve(true); // 古い応答が後から解決
    await flush();
    expect(result.current.needsDragRegion).toBe(true);
  });

  it('does not let a stale resize response overwrite the result of a toggle', async () => {
    installStatefulWindow({ honorDecorations: true, fullscreen: true });
    const { result } = setup();
    await flush();
    const stale = deferred<boolean>();
    win.isDecorated.mockReturnValueOnce(stale.promise);
    await act(async () => {
      resizeCb!(); // 遅延する古い応答（切替前の false 相当）
    });
    await act(async () => {
      await result.current.toggleWindowMode(); // 装飾あり（true）に確定
    });
    expect(result.current.needsDragRegion).toBe(false);
    stale.resolve(false);
    await flush();
    expect(result.current.needsDragRegion).toBe(false);
  });

  it('logs no console.error when pending requests resolve after unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fs = deferred<boolean>();
    const dec = deferred<boolean>();
    win.isFullscreen.mockReturnValue(fs.promise);
    win.isDecorated.mockReturnValue(dec.promise);
    const { unmount } = setup();
    await flush();
    unmount();
    fs.resolve(false);
    dec.resolve(false);
    await flush();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not contradict the real state after a partial failure (setFullscreen ok, setDecorations ng, retry makes it decorated)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = installStatefulWindow({ honorDecorations: true, fullscreen: true });
    win.setDecorations.mockReset().mockImplementation(async (v: boolean) => {
      state.dec = v;
    });
    win.setDecorations.mockRejectedValueOnce(new Error('denied'));
    const { result } = setup();
    await flush();
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    // 再同期で setDecorations(true) の再試行が成功し、実態は「ウィンドウモード+装飾あり」
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ fs: false, dec: true });
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(false);
    errorSpy.mockRestore();
  });

  it('still shows the band after a partial failure when the real window stays undecorated', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installStatefulWindow({ honorDecorations: false, fullscreen: true });
    win.setDecorations.mockRejectedValueOnce(new Error('denied'));
    const { result } = setup();
    await flush();
    await act(async () => {
      await result.current.toggleWindowMode();
    });
    expect(result.current.isFullscreen).toBe(false);
    expect(result.current.needsDragRegion).toBe(true);
    errorSpy.mockRestore();
  });

  it.each([
    ['honored decorations', true],
    ['Wayland (decorations ignored)', false],
  ])('ends consistent with the real state after rapid repeated toggles (%s)', async (_n, honor) => {
    const state = installStatefulWindow({ honorDecorations: honor, fullscreen: true });
    const { result } = setup();
    await flush();
    // 同じレンダーの toggleWindowMode を待たずに連打する（どちらも同じ next を閉じ込める）
    await act(async () => {
      const a = result.current.toggleWindowMode();
      const b = result.current.toggleWindowMode();
      const c = result.current.toggleWindowMode();
      await Promise.all([a, b, c]);
    });
    await flush();
    expect(result.current.isFullscreen).toBe(state.fs);
    expect(result.current.needsDragRegion).toBe(!state.fs && !state.dec);
  });

  /** 描画ごとの needsDragRegion を記録するフック描画 */
  function setupRecording() {
    const seen: boolean[] = [];
    const hook = renderHook(() => {
      const r = useWindowMode(t, onFailure, onCleared);
      seen.push(r.needsDragRegion);
      return r;
    });
    return { ...hook, seen };
  }

  // should S2: 全画面→ウィンドウ切替で isFullscreen だけ先に false になると、装飾の読み直し前に
  // 古い isDecorated(false) と組み合わさって、装飾が付く環境でも帯が一瞬描画されていた。
  describe('no flash while toggling on a decorating backend (x11 / Windows / macOS)', () => {
    it('never renders the band while switching fullscreen -> window', async () => {
      installStatefulWindow({ honorDecorations: true, fullscreen: true });
      const { result, seen } = setupRecording();
      await flush();
      expect(result.current.isFullscreen).toBe(true);
      await act(async () => {
        await result.current.toggleWindowMode();
      });
      await flush();
      expect(result.current.isFullscreen).toBe(false);
      expect(seen).not.toContain(true);
    });

    it('never renders the band when onResized fires in the middle of the switch', async () => {
      const state = installStatefulWindow({ honorDecorations: true, fullscreen: true });
      // 実機同様、setFullscreen の完了時に（装飾がまだ付く前に）onResized が飛ぶ
      win.setFullscreen.mockImplementation(async (v: boolean) => {
        await Promise.resolve();
        state.fs = v;
        resizeCb?.();
      });
      const { result, seen } = setupRecording();
      await flush();
      await act(async () => {
        await result.current.toggleWindowMode();
      });
      await flush();
      expect(result.current.isFullscreen).toBe(false);
      expect(result.current.needsDragRegion).toBe(false);
      expect(seen).not.toContain(true);
    });

    it('never renders the band while switching window -> fullscreen', async () => {
      const state = installStatefulWindow({ honorDecorations: true, fullscreen: false });
      state.dec = true;
      const { result, seen } = setupRecording();
      await flush();
      expect(result.current.isFullscreen).toBe(false);
      await act(async () => {
        await result.current.toggleWindowMode();
      });
      await flush();
      expect(result.current.isFullscreen).toBe(true);
      expect(seen).not.toContain(true);
    });
  });

  // must M1: tao は Wayland で装飾なしのウィンドウに空のカスタムタイトルバーを入れるため、
  // setDecorations(true) 後は isDecorated() が true でも OS のタイトルバーは使えない。
  // ここでは isDecorated() が true を返すモックで、Wayland 判定だけで帯が出ることを確かめる。
  describe('Wayland (isWaylandSession() === true)', () => {
    beforeEach(() => {
      isWaylandSession.mockResolvedValue(true);
    });

    it('shows the band in window mode even when isDecorated() is true', async () => {
      const { result } = await setupWith({ fullscreen: false, decorated: true });
      expect(result.current.isFullscreen).toBe(false);
      expect(result.current.needsDragRegion).toBe(true);
    });

    it('does not show the band while fullscreen', async () => {
      const { result } = await setupWith({ fullscreen: true, decorated: true });
      expect(result.current.needsDragRegion).toBe(false);
    });

    it('shows the band after switching to window mode and keeps it on every render until fullscreen again', async () => {
      // setDecorations(true) が「成功」し isDecorated() も true になる = tao 0.37 の Wayland の実挙動
      installStatefulWindow({ honorDecorations: true, fullscreen: true });
      const { result, seen } = setupRecording();
      await flush();
      expect(result.current.needsDragRegion).toBe(false);
      await act(async () => {
        await result.current.toggleWindowMode();
      });
      await flush();
      expect(result.current.isFullscreen).toBe(false);
      expect(result.current.needsDragRegion).toBe(true);
      // 一度出たら、次の全画面切替まで消えない（resize の再同期でも消えない）
      const firstShown = seen.indexOf(true);
      await act(async () => {
        resizeCb!();
      });
      await flush();
      expect(seen.slice(firstShown)).not.toContain(false);
      await act(async () => {
        await result.current.toggleWindowMode();
      });
      expect(result.current.isFullscreen).toBe(true);
      expect(result.current.needsDragRegion).toBe(false);
    });

    it('asks the backend only once (at mount)', async () => {
      const { result } = await setupWith({ fullscreen: false, decorated: true });
      await act(async () => {
        resizeCb!();
      });
      await flush();
      expect(result.current.needsDragRegion).toBe(true);
      expect(isWaylandSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-Wayland or unknown backend', () => {
    it('does not show the band in window mode when decorated (isWaylandSession() === false)', async () => {
      isWaylandSession.mockResolvedValue(false);
      const { result } = await setupWith({ fullscreen: false, decorated: true });
      expect(result.current.isFullscreen).toBe(false);
      expect(result.current.needsDragRegion).toBe(false);
    });

    it('treats a failed isWaylandSession() as not Wayland (keeps the previous behavior)', async () => {
      isWaylandSession.mockRejectedValue(new Error('no command'));
      const { result } = await setupWith({ fullscreen: false, decorated: true });
      expect(result.current.needsDragRegion).toBe(false);
    });

    it('treats a synchronously throwing isWaylandSession() as not Wayland', async () => {
      isWaylandSession.mockImplementation(() => {
        throw new Error('sync');
      });
      const { result } = await setupWith({ fullscreen: false, decorated: true });
      expect(result.current.needsDragRegion).toBe(false);
    });
  });

  it('does not update state when a toggle finishes after unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installStatefulWindow({ honorDecorations: true, fullscreen: true });
    const dec = deferred<boolean>();
    const { result, unmount } = setup();
    await flush();
    win.isDecorated.mockReturnValueOnce(dec.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.toggleWindowMode();
    });
    await flush();
    unmount();
    dec.resolve(true);
    await act(async () => {
      await pending;
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
