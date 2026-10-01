// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const rescanLastDirectory = vi.fn();
vi.mock('../../lib/tauri', () => ({
  rescanLastDirectory: (...a: unknown[]) => rescanLastDirectory(...a),
}));

import { useExcludeRescan } from './useExcludeRescan';

const progress = (totalFiles: number) => ({
  totalFiles,
  newFiles: 0,
  deletedFiles: 0,
  durationMs: 1,
  errorCount: 0,
  errorExamples: [],
});
const deferred = () => {
  let resolve!: (v: ReturnType<typeof progress>) => void;
  const promise = new Promise<ReturnType<typeof progress>>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  rescanLastDirectory.mockReset();
});

describe('useExcludeRescan guard and races (#111)', () => {
  it('runs a single IPC when rescan() is called repeatedly while running', async () => {
    const d = deferred();
    rescanLastDirectory.mockReturnValue(d.promise);
    const { result } = renderHook(() => useExcludeRescan(() => {}));
    act(() => {
      void result.current.rescan();
      void result.current.rescan();
      void result.current.rescan();
    });
    expect(rescanLastDirectory).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(progress(1)));
  });

  it('does not run a rescan while a folder-tab scan holds the guard (and says why)', async () => {
    const { result } = renderHook(() => useExcludeRescan(() => {}));
    let token: number | null = null;
    act(() => {
      token = result.current.begin();
    });
    expect(token).not.toBeNull();
    await act(async () => result.current.rescan());
    expect(rescanLastDirectory).not.toHaveBeenCalled();
    expect(result.current.error).toEqual({ kind: 'code', raw: 'scanInProgress' });
    act(() => result.current.end());
    rescanLastDirectory.mockResolvedValue(progress(2));
    await act(async () => result.current.rescan());
    expect(rescanLastDirectory).toHaveBeenCalledTimes(1);
  });

  it('a folder-tab scan cannot start while a rescan is running', async () => {
    const d = deferred();
    rescanLastDirectory.mockReturnValue(d.promise);
    const { result } = renderHook(() => useExcludeRescan(() => {}));
    act(() => {
      void result.current.rescan();
    });
    let token: number | null = 0;
    act(() => {
      token = result.current.begin();
    });
    expect(token).toBeNull();
    await act(async () => d.resolve(progress(1)));
  });

  it('keeps the notice when an add is cancelled by a remove while a rescan that saw it is running', async () => {
    const d = deferred();
    rescanLastDirectory.mockReturnValue(d.promise);
    const { result } = renderHook(() => useExcludeRescan(() => {}));
    act(() => result.current.noteChange({ kind: 'added', pattern: 'A' }));
    act(() => {
      void result.current.rescan();
    });
    act(() => result.current.noteChange({ kind: 'removed', pattern: 'A' }));
    await act(async () => d.resolve(progress(1)));
    // 再スキャンは A 除外後の状態を読んだ可能性がある → 削除ぶんの反映待ちが残る
    await waitFor(() => expect(result.current.notice).toEqual({ kind: 'removed', pattern: 'A' }));
  });

  it('still cancels add/remove of the same pattern when no rescan is running', () => {
    const { result } = renderHook(() => useExcludeRescan(() => {}));
    act(() => result.current.noteChange({ kind: 'added', pattern: 'A' }));
    act(() => result.current.noteChange({ kind: 'removed', pattern: 'A' }));
    expect(result.current.notice).toBeNull();
  });

  it('clearUpTo only clears changes made before the scan started', () => {
    const { result } = renderHook(() => useExcludeRescan(() => {}));
    act(() => result.current.noteChange({ kind: 'added', pattern: 'A' }));
    let token: number | null = null;
    act(() => {
      token = result.current.begin();
    });
    act(() => result.current.noteChange({ kind: 'added', pattern: 'B' })); // スキャン開始後
    act(() => {
      result.current.clearUpTo(token as unknown as number);
      result.current.end();
    });
    expect(result.current.notice).toEqual({ kind: 'added', pattern: 'B' });
  });

  it('does not set state after unmount (no throw) when the rescan resolves late', async () => {
    const d = deferred();
    rescanLastDirectory.mockReturnValue(d.promise);
    const onRefreshed = vi.fn();
    const { result, unmount } = renderHook(() => useExcludeRescan(onRefreshed));
    act(() => {
      void result.current.rescan();
    });
    unmount();
    await act(async () => d.resolve(progress(1)));
    expect(onRefreshed).not.toHaveBeenCalled();
  });
});
