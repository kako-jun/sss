import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 取得状態。`error` は「取得に失敗した」状態で、`ready` のデータが空配列などの
 * 「本当に空」とは別物として扱うためのもの（#115: 失敗が空表示に化けるのを防ぐ）。
 */
export type AsyncLoadState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: T };

export interface AsyncLoad<T> {
  state: AsyncLoadState<T>;
  /** 再取得する（再試行ボタン・取得し直しの両方で使う）。読み込み中表示に戻す。 */
  reload: () => void;
  /** 取得済みデータを更新する（削除後に一覧から外す等）。`ready` でないときは何もしない。 */
  update: (updater: (prev: T) => T) => void;
}

/**
 * 設定画面の各セクションが「マウント時に取得→失敗したら再試行」を共通の形で扱うための hook（#115）。
 * 失敗は `console.error` に流すだけにせず `status: 'error'` として返し、呼び出し側が
 * エラー表示（`LoadError`）と再試行ボタンを出す。
 */
export function useAsyncLoad<T>(loader: () => Promise<T>, label: string): AsyncLoad<T> {
  const [state, setState] = useState<AsyncLoadState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let cancelled = false;
    loaderRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((err) => {
        console.error(`Failed to load ${label}:`, err);
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, label]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const update = useCallback((updater: (prev: T) => T) => {
    setState((prev) =>
      prev.status === 'ready' ? { status: 'ready', data: updater(prev.data) } : prev,
    );
  }, []);

  return { state, reload, update };
}
