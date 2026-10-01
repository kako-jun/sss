// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAsyncLoad } from './useAsyncLoad';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useAsyncLoad (#115)', () => {
  it('goes loading -> ready with the loaded data', async () => {
    const { result } = renderHook(() => useAsyncLoad(async () => [1, 2], 'x'));
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: [1, 2] }));
  });

  it('a rejected loader becomes the error state (not an empty ready state)', async () => {
    const { result } = renderHook(() =>
      useAsyncLoad(async () => Promise.reject(new Error('x')), 'x'),
    );
    await waitFor(() => expect(result.current.state.status).toBe('error'));
  });

  it('a loader that throws synchronously also becomes the error state', async () => {
    const { result } = renderHook(() =>
      useAsyncLoad<number[]>(() => {
        throw new Error('sync');
      }, 'x'),
    );
    await waitFor(() => expect(result.current.state.status).toBe('error'));
  });

  it('reload recovers from an error, and a stale response from before the reload is ignored', async () => {
    let call = 0;
    let resolveFirst!: (v: number[]) => void;
    const loader = vi.fn(() => {
      call++;
      if (call === 1) return Promise.reject(new Error('first'));
      if (call === 2)
        return new Promise<number[]>((res) => {
          resolveFirst = res;
        });
      return Promise.resolve([3]);
    });
    const { result } = renderHook(() => useAsyncLoad(loader, 'x'));
    await waitFor(() => expect(result.current.state.status).toBe('error'));

    act(() => result.current.reload()); // call 2: 保留
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    act(() => result.current.reload()); // call 3: 即時に解決
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: [3] }));
    // 古い応答(call 2)が後から届いても上書きしない
    await act(async () => resolveFirst([2]));
    expect(result.current.state).toEqual({ status: 'ready', data: [3] });
  });

  it('update changes ready data and is a no-op otherwise', async () => {
    const { result } = renderHook(() => useAsyncLoad(async () => [1], 'x'));
    act(() => result.current.update((p) => [...p, 9])); // loading 中は何もしない
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.update((p) => [...p, 2]));
    expect(result.current.state).toEqual({ status: 'ready', data: [1, 2] });
  });
});
