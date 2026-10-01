import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  getConfirmDialogRequest,
  registerConfirmDialogHost,
  settleConfirmDialog,
  subscribeConfirmDialog,
} from '../lib/confirmDialog';

/**
 * アプリ内の確認モーダル（#119）。`confirmDialog()` から開く。App 直下に1つだけ置く。
 *
 * - `role="alertdialog"` / `aria-modal` / `aria-describedby`（本文）。
 * - 既定フォーカスはキャンセル側。ESC・背景クリック=キャンセル。
 * - ESC は document の capture で先取りして伝播を止める（App のグローバル ESC
 *   ハンドラが設定を閉じたり exit_app を呼んだりしないように）。
 * - 設定モーダル（transform 祖先）の内側から開いても fixed が viewport 基準に
 *   なるよう body へ portal する（DESIGN.md「Fixed-Position Overlays …」）。
 */
export function ConfirmDialogHost() {
  const request = useSyncExternalStore(
    subscribeConfirmDialog,
    getConfirmDialogRequest,
    getConfirmDialogRequest,
  );
  useEffect(() => registerConfirmDialogHost(), []);
  if (!request) return null;
  return createPortal(<ConfirmDialogView key={request.id} />, document.body);
}

function ConfirmDialogView() {
  const t = useT();
  const request = useSyncExternalStore(
    subscribeConfirmDialog,
    getConfirmDialogRequest,
    getConfirmDialogRequest,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(panelRef, true);

  // useFocusTrap は最初のフォーカス可能要素へ rAF で移すが、DOM 順をキャンセル先頭に
  // しているので既定でキャンセルに当たる。マウント直後にも明示して取りこぼしを防ぐ。
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      settleConfirmDialog(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  if (!request) return null;

  return (
    <div
      data-testid="confirm-dialog-backdrop"
      className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-[60]"
      onClick={() => settleConfirmDialog(false)}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-describedby="confirm-dialog-message"
        tabIndex={-1}
        className="bg-neutral-950 rounded-2xl shadow-2xl p-7 max-w-md w-full mx-8 border border-white/10 !outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <p
          id="confirm-dialog-message"
          className="text-sm text-white/70 whitespace-pre-line leading-relaxed"
        >
          {request.message}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => settleConfirmDialog(false)}
            className="px-4 py-2 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded-lg transition-colors text-sm"
          >
            {t('cancelButton')}
          </button>
          <button
            type="button"
            onClick={() => settleConfirmDialog(true)}
            className="px-4 py-2 bg-red-950/60 hover:bg-red-900/60 text-red-400/70 hover:text-red-400/90 rounded-lg transition-colors text-sm"
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
