import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyFailure } from '../lib/failureNotice';
import type { MessageKey } from '../lib/i18n';

/**
 * 設定を「先に画面へ反映→保存」する UI で、保存に失敗したら最後に保存できた値へ巻き戻し、
 * 失敗を通知するための hook（#115）。保存が失敗しても成功したように見え続け、次回起動で
 * 値が戻って初めて気づく、という状態を防ぐ。
 *
 * - `setValue`: 巻き戻し時に呼ぶ（画面の state と、親への通知の両方を戻すのは呼び出し側の責務）。
 * - `initialSaved`: 読み込み前の既定値。`markLoaded` で読み込めた保存値に更新する。
 * - `failureKey`: セクションがアンマウント済みのとき（インライン通知が見えない）に、App の
 *   上部トーストへ出す文言の辞書キー。
 * - 書き込みは直列化する（前の保存が終わってから次を送る）。並行して送ると完了順が前後し、
 *   「後の保存が先に失敗して巻き戻した後、前の保存が成功して DB と画面がずれる」ことが起きる。
 *   直列なら保存済みの値（`savedRef`）は常に DB の実値と一致する。
 * - 失敗の通知・巻き戻しは「その時点で最新の操作」のものだけ行う（古い保存が失敗しても、
 *   後続の操作の結果が画面を決める）。失敗通知は常に1つ（積み上げない）。
 */
export function useRollbackSave<T>(
  setValue: (value: T) => void,
  initialSaved: T,
  failureKey: MessageKey,
) {
  const [saveFailed, setSaveFailed] = useState(false);
  const savedRef = useRef<T>(initialSaved);
  const seqRef = useRef(0);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const inFlightRef = useRef(0);
  const mountedRef = useRef(true);
  const setValueRef = useRef(setValue);
  const failureKeyRef = useRef(failureKey);
  useEffect(() => {
    setValueRef.current = setValue;
    failureKeyRef.current = failureKey;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 取得の世代管理: 取得を始めた時点の保存操作の番号を控え、取得が返ってきたときに
  // その間にユーザーが保存を始めていたら（古い DB 読み取りになるので）保存済みの値を上書きしない。
  const beginLoad = useCallback(() => seqRef.current, []);

  /** 取得できた保存値を反映する。反映した（古い取得でなかった）ときだけ true。 */
  const markLoaded = useCallback((value: T, token: number): boolean => {
    if (token !== seqRef.current) return false;
    savedRef.current = value;
    return true;
  }, []);

  const save = useCallback(async (next: T, persist: (value: T) => Promise<void>) => {
    const seq = ++seqRef.current;
    const run = async (): Promise<boolean> => {
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
          if (!mountedRef.current) notifyFailure(failureKeyRef.current);
        }
        return false;
      }
    };
    // 何も保存中でなければ即座に開始する（設定画面を閉じる直前の保存を次のtickへ遅らせない）。
    const result = inFlightRef.current === 0 ? run() : chainRef.current.then(run);
    inFlightRef.current++;
    chainRef.current = result;
    void result.finally(() => {
      inFlightRef.current--;
    });
    return result;
  }, []);

  return { saveFailed, save, beginLoad, markLoaded };
}
