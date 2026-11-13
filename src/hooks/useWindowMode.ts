import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Translate } from '../lib/i18n';
import { isWaylandSession } from '../lib/tauri';

/**
 * ウィンドウモード（フルスクリーン / ウィンドウ）の状態とその切替。
 *
 * - 状態は OS の実態と同期する（起動時の取得 + onResized での再取得。Tauri v2 に
 *   フルスクリーン専用イベントが無いため onResized で近似）。
 * - 切替が失敗したら `notifyFailure` で通知し、片方だけ成功した場合に表示と OS の
 *   実態がずれないよう実態から再同期する（#103）。
 *
 * - `needsDragRegion`（#164）: ウィンドウモードなのに OS のタイトルバーが使えないとき true に
 *   なり、呼び出し側がアプリ内のドラッグ領域を出してウィンドウを移動できるようにする。
 *   - Wayland（起動時に `isWaylandSession()` で1回だけ判定）: ウィンドウモード中は常に true。
 *     tao は Wayland で装飾なしのウィンドウを作るとき空のカスタムタイトルバーを入れるため、
 *     後から `setDecorations(true)` を呼んでも見た目は空の帯のままなのに `isDecorated()` は
 *     true を返す。`isDecorated()` では判定できない。判定に失敗したら false（現状維持）。
 *   - それ以外: `isDecorated()` が false のときだけ true（装飾が付く x11/Windows/macOS では出ない）。
 * - フルスクリーン状態と装飾の実態は常に「両方読んでから同時に」反映する。片方だけ先に反映
 *   されると、装飾ありの環境でも一瞬帯が出るため（起動時・onResized・切替のすべて）。
 *   切替中は onResized の同期を止め、切替の最後に読んだ実態で確定させる。
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
  // 装飾の実態。null = 未確定（取得前・取得失敗）。未確定の間は（非 Wayland で）帯を出さない（#164）
  const [isDecorated, setIsDecorated] = useState<boolean | null>(null);
  // Wayland バックエンドか（#164）。起動時に1回だけ取得し、失敗時は false（現状維持）
  const [isWayland, setIsWayland] = useState(false);
  // 実態取得の世代。古い応答が新しい応答を上書きしないよう、最新の世代だけ反映する
  const syncSeq = useRef(0);
  // 進行中の切替の数。0 より大きい間は onResized の同期を止める（途中状態を拾わない）
  const toggling = useRef(0);
  // アンマウント後に state を更新しない
  const mounted = useRef(false);

  // フルスクリーン状態・装飾の実態を OS と同期
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const win = getCurrentWindow();

    Promise.resolve()
      .then(() => isWaylandSession())
      .then((v) => {
        if (!cancelled) setIsWayland(v === true);
      })
      .catch(() => {});

    // 両方を読んでから同時に反映する。読めなかった方は fullscreen=現状維持 / 装飾=未確定
    const syncFromOs = () => {
      const seq = ++syncSeq.current;
      Promise.all([readFullscreen(win), readDecorated(win)]).then(([fs, dec]) => {
        if (cancelled || seq !== syncSeq.current) return;
        if (fs !== undefined) setIsFullscreen(fs);
        setIsDecorated(dec);
      });
    };
    syncFromOs();
    // OSによるフルスクリーン変化を検知して同期（切替中は切替側が最後に確定させる）
    let cleanup: (() => void) | null = null;
    const listenerPromise = win
      .onResized(() => {
        if (toggling.current > 0) return;
        syncFromOs();
      })
      .then((fn) => {
        cleanup = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      mounted.current = false;
      // 非同期登録が完了してからクリーンアップ（Strict Mode での漏れを防ぐ）
      listenerPromise.finally(() => cleanup?.());
    };
  }, []);

  const toggleWindowMode = async () => {
    const win = getCurrentWindow();
    toggling.current += 1;
    // 切替前に発行済みの onResized 由来の応答を無効にする
    ++syncSeq.current;
    try {
      const next = !isFullscreen;
      await win.setFullscreen(next);
      // ウィンドウモード時はタイトルバーを表示してウィンドウを掴めるようにする
      // フルスクリーン時は decorations を非表示に戻す
      await win.setDecorations(!next);
      // Wayland では setDecorations(true) の成否・isDecorated() が見た目と一致しないことがあるため、
      // 装飾の実態は読み直す（読めなければ未確定）。フルスクリーン状態と同時に反映する（#164）
      const seq = ++syncSeq.current;
      const decorated = await readDecorated(win);
      if (mounted.current && seq === syncSeq.current) {
        setIsFullscreen(next);
        setIsDecorated(decorated);
      }
      notifyCleared();
    } catch (err) {
      console.error('Failed to toggle window mode:', err);
      notifyFailure(t('windowModeToggleFailed'));
      // 片方だけ成功した場合に表示とOSの実態がずれないよう、実態から再同期する
      try {
        const actual = await win.isFullscreen();
        // setFullscreen だけ成功した部分失敗に備え、装飾も実態に合わせる（失敗は握りつぶす）
        await win.setDecorations(!actual).catch((decErr) => {
          console.error('Failed to re-sync window decorations:', decErr);
        });
        // 再試行で装飾の実態が変わりうるので読み直す。読めなければ未確定（帯なし）
        const seq = ++syncSeq.current;
        const decorated = await readDecorated(win);
        if (mounted.current && seq === syncSeq.current) {
          setIsFullscreen(actual);
          setIsDecorated(decorated);
        }
      } catch (syncErr) {
        // 実態も取れなければ現状維持
        console.error('Failed to re-sync window mode:', syncErr);
      }
    } finally {
      toggling.current -= 1;
    }
  };

  return {
    isFullscreen,
    needsDragRegion: !isFullscreen && (isWayland || isDecorated === false),
    toggleWindowMode,
  };
}

type AppWindow = ReturnType<typeof getCurrentWindow>;

/** フルスクリーン状態の実態。読めなければ undefined（呼び出し側で現状維持） */
function readFullscreen(win: AppWindow): Promise<boolean | undefined> {
  return Promise.resolve()
    .then(() => win.isFullscreen())
    .catch(() => undefined);
}

/** 装飾の実態。読めなければ null（未確定）。同期 throw も拾う */
function readDecorated(win: AppWindow): Promise<boolean | null> {
  return Promise.resolve()
    .then(() => win.isDecorated())
    .catch(() => null);
}
