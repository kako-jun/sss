import { useEffect } from 'react';
import type { RefObject } from 'react';
import { isFocusVisible } from '../lib/keyboardShortcuts';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex !== -1,
  );
}

/**
 * モーダル用の最小フォーカストラップ（#66 a11y）。
 *
 * - 開いた瞬間、コンテナ内の最初のフォーカス可能要素（無ければコンテナ自身）へ
 *   フォーカスを移す。
 * - コンテナ内でTab/Shift+Tabがコンテナの外へ出ないように先頭/末尾で折り返す。
 * - 閉じたら、キーボード操作で開かれた場合だけモーダルを開く前にフォーカス
 *   していた要素へフォーカスを戻す。マウスクリックで開かれた場合はその要素を
 *   blurする（#66レビューmust2(c): 歯車アイコンをマウスでクリックして設定を
 *   開き、ESCで閉じると、旧実装は同じ歯車ボタンへフォーカスを戻していた。
 *   その状態でSpaceを押すと、ボタンのネイティブなクリック相当の挙動が働き
 *   設定が再度開いてしまっていた。マウス操作で得たフォーカスは
 *   `:focus-visible`にならないため、開いた瞬間にこれを判定しておき、
 *   キーボード操作で開かれた時だけ復帰する）。
 *
 * `Settings`（設定モーダル）・`ShortcutsOverlay`（ショートカット一覧）の両方から
 * 使う共通ロジック。Escapeでの閉じ方は呼び出し元（`App.tsx`のキーボードハンドラ）
 * が担当するため、ここでは扱わない。
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const openedViaKeyboard = isFocusVisible(previouslyFocused);

    const focusFirst = () => {
      const [first] = getFocusable(container);
      (first ?? container).focus();
    };
    // モーダルの開閉アニメーション(framer motion)のマウント直後は要素の寸法が
    // 未確定なことがあるため、次のマイクロタスクで確実にDOMが揃ってからフォーカスする。
    const raf = requestAnimationFrame(focusFirst);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener('keydown', handleKeyDown);
      // 閉じた時点でまだDOM上にある場合だけ操作する（アンマウント済みなら何もしない）。
      if (openedViaKeyboard) {
        previouslyFocused?.focus?.();
      } else {
        // マウス操作で開かれた場合はフォーカスを戻さずblurする（must2(c)）。
        previouslyFocused?.blur?.();
      }
    };
  }, [isOpen, containerRef]);
}
