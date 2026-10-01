import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 設定を「先に画面へ反映→保存」する UI で、保存に失敗したら最後に保存できた値へ巻き戻し、
 * 失敗を通知するための hook（#115）。保存が失敗しても成功したように見え続け、次回起動で
 * 値が戻って初めて気づく、という状態を防ぐ。
 *
 * - `setValue`: 巻き戻し時に呼ぶ（画面の state と、親への通知の両方を戻すのは呼び出し側の責務）。
 * - `initialSaved`: 読み込み前の既定値。`markLoaded` で読み込めた保存値に更新する。
 * - 連続操作: 失敗の通知・巻き戻しは「その時点で最新の操作」のものだけ行う（古い保存が遅れて
 *   失敗しても、新しい操作の表示を壊さない）。失敗通知は常に1つ（積み上げない）。
 */
export function useRollbackSave<T>(setValue: (value: T) => void, initialSaved: T) {
  const [saveFailed, setSaveFailed] = useState(false);
  const savedRef = useRef<T>(initialSaved);
  const seqRef = useRef(0);
  const setValueRef = useRef(setValue);
  useEffect(() => {
    setValueRef.current = setValue;
  });

  const markLoaded = useCallback((value: T) => {
    savedRef.current = value;
  }, []);

  const save = useCallback(async (next: T, persist: (value: T) => Promise<void>) => {
    const seq = ++seqRef.current;
    try {
      await persist(next);
      savedRef.current = next;
      if (seq === seqRef.current) setSaveFailed(false);
      return true;
    } catch (err) {
      console.error('Failed to save setting:', err);
      if (seq === seqRef.current) {
        setValueRef.current(savedRef.current);
        setSaveFailed(true);
      }
      return false;
    }
  }, []);

  return { saveFailed, save, markLoaded };
}
