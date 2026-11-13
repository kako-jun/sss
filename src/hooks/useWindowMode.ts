import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Translate } from '../lib/i18n';

/**
 * ウィンドウモード（フルスクリーン / ウィンドウ）の状態とその切替。
 *
 * - 状態は OS の実態と同期する（起動時の取得 + onResized での再取得。Tauri v2 に
 *   フルスクリーン専用イベントが無いため onResized で近似）。
 * - 切替が失敗したら `notifyFailure` で通知し、片方だけ成功した場合に表示と OS の
 *   実態がずれないよう実態から再同期する（#103）。
 *
 * - 装飾（タイトルバー）の実態も `isDecorated()` で同期する（#164）。Wayland では装飾なしで
 *   作成したウィンドウに実行時 `setDecorations(true)` を呼んでも装飾が付かないことがある。
 *   その場合 `needsDragRegion`（ウィンドウモードなのに装飾が無い）が true になり、呼び出し側が
 *   アプリ内のドラッグ領域を出してウィンドウを移動できるようにする。
 *
 * 返す `toggleWindowMode` は毎レンダー作り直される（`isFullscreen` を閉じ込めるため）。
 * 一度だけ登録するリスナーから呼ぶ側は ref 経由で最新を読むこと。
 */
export function useWindowMode(
  t: Translate,
  notifyFailure: (text: string) => void,
  notifyCleared: () => void,
): { isFullscreen: boolean; needsDragRegion: boolean; toggleWindowMode: () => Promise<void> } {
  // 起動時の設定値（全画面）に合わせた初期値
  const [isFullscreen, setIsFullscreen] = useState(true);
  // 装飾の実態。null = 未確定。確定するまで needsDragRegion を出さない（起動時の2つの非同期取得の
  // 解決順で一瞬帯が出るのを防ぐ。取得できなければ未確定のまま = 帯なしの現状維持）（#164）
  const [isDecorated, setIsDecorated] = useState<boolean | null>(null);
  // isDecorated 応答の世代。古い応答が新しい応答を上書きしないよう、最新の世代だけ反映する
  const decoratedSeq = useRef(0);

  // フルスクリーン状態をOSの実態と同期
  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();
    // 装飾の実態を取得（取得できなければ現状維持）
    const syncDecorated = () => {
      const seq = ++decoratedSeq.current;
      Promise.resolve()
        .then(() => win.isDecorated())
        .then((v) => {
          if (!cancelled && seq === decoratedSeq.current) setIsDecorated(v);
        })
        .catch(() => {});
    };
    syncDecorated();
    // 初期値を実態から取得
    win
      .isFullscreen()
      .then((v) => {
        if (!cancelled) setIsFullscreen(v);
      })
      .catch(() => {});
    // OSによるフルスクリーン変化を検知して同期
    let cleanup: (() => void) | null = null;
    const listenerPromise = win
      .onResized(() => {
        syncDecorated();
        win
          .isFullscreen()
          .then((v) => {
            if (!cancelled) setIsFullscreen(v);
          })
          .catch(() => {});
      })
      .then((fn) => {
        cleanup = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // 非同期登録が完了してからクリーンアップ（Strict Mode での漏れを防ぐ）
      listenerPromise.finally(() => cleanup?.());
    };
  }, []);

  const toggleWindowMode = async () => {
    try {
      const win = getCurrentWindow();
      const next = !isFullscreen;
      await win.setFullscreen(next);
      // ウィンドウモード時はタイトルバーを表示してウィンドウを掴めるようにする
      // フルスクリーン時は decorations を非表示に戻す
      await win.setDecorations(!next);
      setIsFullscreen(next);
      // Wayland では setDecorations(true) が効かないことがあるため、成否ではなく実態を読む（#164）
      const seq = ++decoratedSeq.current;
      const decorated = await win.isDecorated().catch(() => !next);
      if (seq === decoratedSeq.current) setIsDecorated(decorated);
      notifyCleared();
    } catch (err) {
      console.error('Failed to toggle window mode:', err);
      notifyFailure(t('windowModeToggleFailed'));
      // 片方だけ成功した場合に表示とOSの実態がずれないよう、実態から再同期する
      try {
        const win = getCurrentWindow();
        const actual = await win.isFullscreen();
        setIsFullscreen(actual);
        // setFullscreen だけ成功した部分失敗に備え、装飾も実態に合わせる（失敗は握りつぶす）
        await win.setDecorations(!actual).catch((decErr) => {
          console.error('Failed to re-sync window decorations:', decErr);
        });
        // 再試行で装飾の実態が変わりうるので読み直す。読めなければ未確定（帯なし）に戻す
        const seq = ++decoratedSeq.current;
        const decorated = await win.isDecorated().catch(() => null);
        if (seq === decoratedSeq.current) setIsDecorated(decorated);
      } catch (syncErr) {
        // 実態も取れなければ現状維持
        console.error('Failed to re-sync window mode:', syncErr);
      }
    }
  };

  return {
    isFullscreen,
    needsDragRegion: !isFullscreen && isDecorated === false,
    toggleWindowMode,
  };
}
