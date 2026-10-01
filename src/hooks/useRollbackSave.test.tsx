// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRollbackSave } from './useRollbackSave';
import { subscribeFailureNotice } from '../lib/failureNotice';

// #115: 保存の完了順が前後しても、画面・保存済みの値・DB が食い違わないことを固定する。
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useRollbackSave ordering (#115)', () => {
  it('writes are serialized: the next save starts only after the previous one finished', async () => {
    const setValue = vi.fn();
    const { result } = renderHook(() => useRollbackSave<number>(setValue, 0, 'intervalSaveFailed'));
    const a = deferred();
    const persistA = vi.fn(() => a.promise);
    const persistB = vi.fn(async () => {});

    let pa!: Promise<boolean>;
    let pb!: Promise<boolean>;
    act(() => {
      pa = result.current.save(1, persistA);
      pb = result.current.save(2, persistB);
    });
    await act(async () => {});
    expect(persistA).toHaveBeenCalledTimes(1);
    expect(persistB).not.toHaveBeenCalled();

    await act(async () => {
      a.resolve();
      await pa;
      await pb;
    });
    expect(persistB).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('an older save failing late does not roll back or flag a failure when a newer save succeeds', async () => {
    const setValue = vi.fn();
    const { result } = renderHook(() => useRollbackSave<number>(setValue, 0, 'intervalSaveFailed'));
    const a = deferred();
    let pa!: Promise<boolean>;
    let pb!: Promise<boolean>;
    act(() => {
      pa = result.current.save(1, () => a.promise);
      pb = result.current.save(2, async () => {});
    });
    await act(async () => {
      a.reject(new Error('late failure'));
      await pa;
      await pb;
    });
    // 画面は新しい操作（2）のまま。古い失敗で 0 へ巻き戻したり、失敗表示を出したりしない。
    expect(setValue).not.toHaveBeenCalled();
    expect(result.current.saveFailed).toBe(false);
  });

  it('newer save failing after an older one succeeded rolls back to the older saved value (DB, saved and screen agree)', async () => {
    const setValue = vi.fn();
    const { result } = renderHook(() => useRollbackSave<number>(setValue, 0, 'intervalSaveFailed'));
    const a = deferred();
    let pa!: Promise<boolean>;
    let pb!: Promise<boolean>;
    act(() => {
      pa = result.current.save(1, () => a.promise);
      pb = result.current.save(2, async () => {
        throw new Error('b failed');
      });
    });
    await act(async () => {
      a.resolve();
      await pa;
      await pb;
    });
    // A は DB に保存済み。B の失敗は初期値(0)でなく A(1) へ戻す。
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledWith(1);
    expect(result.current.saveFailed).toBe(true);
  });

  it('a later successful save clears the failure notice', async () => {
    const setValue = vi.fn();
    const { result } = renderHook(() => useRollbackSave<number>(setValue, 0, 'intervalSaveFailed'));
    await act(async () => {
      await result.current.save(1, async () => {
        throw new Error('x');
      });
    });
    expect(result.current.saveFailed).toBe(true);
    await act(async () => {
      await result.current.save(2, async () => {});
    });
    expect(result.current.saveFailed).toBe(false);
  });

  it('after unmount, a failed save is announced through the app-level notice with the target-specific key', async () => {
    const setValue = vi.fn();
    const listener = vi.fn();
    const off = subscribeFailureNotice(listener);
    const { result, unmount } = renderHook(() =>
      useRollbackSave<number>(setValue, 0, 'languageSaveFailed'),
    );
    const d = deferred();
    let p!: Promise<boolean>;
    act(() => {
      p = result.current.save(1, () => d.promise);
    });
    unmount();
    await act(async () => {
      d.reject(new Error('x'));
      await p;
    });
    expect(setValue).toHaveBeenCalledWith(0);
    expect(listener).toHaveBeenCalledWith('languageSaveFailed');
    off();
  });

  it('while mounted, the inline notice is used and the app-level notice is not fired', async () => {
    const listener = vi.fn();
    const off = subscribeFailureNotice(listener);
    const { result } = renderHook(() => useRollbackSave<number>(vi.fn(), 0, 'exifSaveFailed'));
    await act(async () => {
      await result.current.save(1, async () => {
        throw new Error('x');
      });
    });
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});
