import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Translate } from '../lib/emptyState';

/**
 * ウィンドウモード（フルスクリーン / ウィンドウ）の状態とその切替。
 *
 * - 状態は OS の実態と同期する（起動時の取得 + onResized での再取得。Tauri v2 に
 *   フルスクリーン専用イベントが無いため onResized で近似）。
 * - 切替が失敗したら `notifyFailure` で通知し、片方だけ成功した場合に表示と OS の
 *   実態がずれないよう実態から再同期する（#103）。
 *
 * 返す `toggleWindowMode` は毎レンダー作り直される（`isFullscreen` を閉じ込めるため）。
 * 一度だけ登録するリスナーから呼ぶ側は ref 経由で最新を読むこと。
 */
export function useWindowMode(
  t: Translate,
  notifyFailure: (text: string) => void,
  notifyCleared: () => void,
): { isFullscreen: boolean; toggleWindowMode: () => Promise<void> } {
  // 起動時の設定値（全画面）に合わせた初期値
  const [isFullscreen, setIsFullscreen] = useState(true);

  // フルスクリーン状態をOSの実態と同期
  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();
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
      } catch (syncErr) {
        // 実態も取れなければ現状維持
        console.error('Failed to re-sync window mode:', syncErr);
      }
    }
  };

  return { isFullscreen, toggleWindowMode };
}
