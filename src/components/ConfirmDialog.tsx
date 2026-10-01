import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  const messageRef = useRef<HTMLDivElement>(null);
  // 本文がスクロール領域からあふれていて、まだ下に続きがあるか（フェードの手がかり用）。
  const [moreBelow, setMoreBelow] = useState(false);
  // 既定フォーカス: useFocusTrap が開いた直後（rAF）に最初のフォーカス可能要素へ移す。
  // キャンセルを DOM 上の先頭ボタンにしているので、既定でキャンセルにフォーカスが当たる
  // （ボタンの並びを変える時はこの前提と ConfirmDialog.test.tsx を合わせること）。
  useFocusTrap(panelRef, true);

  // 段落（\n\n 区切り）が2つ以上なら最終段落をスクロール外に固定する。1つだけなら全文が本文。
  const paragraphs = request ? request.message.split('\n\n') : [''];
  const finalParagraph = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : null;
  const body =
    finalParagraph === null ? (request?.message ?? '') : paragraphs.slice(0, -1).join('\n\n');

  // 本文があふれる場合のみ、↑↓/PageUp/PageDown/Home/End で本文をスクロールする
  // （本文を tabIndex=0 にするとフォーカス順で既定フォーカス＝キャンセルを奪うため、
  //  キーハンドラ方式。Tab/Enter/Space/Esc は従来どおり）。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = messageRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const page = Math.max(el.clientHeight - 24, 24);
    const line = 24;
    switch (e.key) {
      case 'ArrowDown':
        el.scrollTop += line;
        break;
      case 'ArrowUp':
        el.scrollTop -= line;
        break;
      case 'PageDown':
        el.scrollTop += page;
        break;
      case 'PageUp':
        el.scrollTop -= page;
        break;
      case 'Home':
        el.scrollTop = 0;
        break;
      case 'End':
        el.scrollTop = el.scrollHeight;
        break;
      default:
        return;
    }
    e.preventDefault();
    updateMoreBelow();
  };

  const updateMoreBelow = () => {
    const el = messageRef.current;
    if (!el) return;
    setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  };
  useEffect(() => {
    updateMoreBelow();
    window.addEventListener('resize', updateMoreBelow);
    return () => window.removeEventListener('resize', updateMoreBelow);
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
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        tabIndex={-1}
        className="bg-neutral-950 rounded-2xl shadow-2xl p-7 max-w-md w-full mx-8 border border-white/10 !outline-none flex flex-col max-h-[calc(100vh-2rem)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h2 id="confirm-dialog-title" className="sr-only">
          {t('confirmDialogTitle')}
        </h2>
        {/* 長い本文でも窓が低いとき（800x400, 360x300 等）ボタンが画面外へ出ないよう、
            本文だけをスクロールさせてボタン行は常に見せる。破壊的操作の警告になる最終段落
            （「この操作は取り消せません。…」）はスクロール領域の外（ボタン行の直上）に固定し、
            スクロールしなくても・キーボードだけでも必ず読めるようにする。
            wrapper が aria-describedby の対象。flex コンテナ内の空白だけのテキストは描画されず、
            textContent では段落間に元の "\n\n" が残る。 */}
        <div id="confirm-dialog-message" className="min-h-0 flex flex-col">
          <div className="relative min-h-0 flex flex-col">
            <div
              ref={messageRef}
              tabIndex={-1}
              onScroll={updateMoreBelow}
              className="min-h-0 overflow-y-auto text-sm text-white/70 whitespace-pre-line leading-relaxed !outline-none"
            >
              {body}
            </div>
            {/* 続きが下にあるときだけ出す、本文下端のフェード（「まだ読み切っていない」手がかり）。 */}
            {moreBelow && (
              <div
                data-testid="confirm-dialog-more"
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-transparent"
              />
            )}
          </div>
          {finalParagraph !== null && (
            <>
              {'\n\n'}
              <p
                data-testid="confirm-dialog-final"
                className="mt-4 shrink-0 text-sm text-white/70 whitespace-pre-line leading-relaxed"
              >
                {finalParagraph}
              </p>
            </>
          )}
        </div>
        <div className="mt-6 shrink-0 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => settleConfirmDialog(false)}
            className="shrink-0 whitespace-nowrap px-4 py-2 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded-lg transition-colors text-sm"
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
