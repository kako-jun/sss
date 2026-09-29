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
 *   フォーカスを移す。ただし`openedViaMouse`がtrueの場合はコンテナ自身へ
 *   フォーカスする（#66レビュー3巡目should、下記参照）。
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
 * `openedViaMouse`（#66レビュー3巡目should）: 呼び出し元が「このモーダルを
 * 開いた操作がマウスクリックだったか」を伝える（例: `onClick`の
 * `event.detail > 0`。キーボードでのEnter/Space起動によるclickは`detail===0`）。
 * これがtrueの間は、最初のフォーカス可能要素（多くの場合は閉じるボタン）では
 * なくコンテナ自身にフォーカスする。理由: 開いた直後に
 * `requestAnimationFrame`経由で遅延実行されるこの`.focus()`呼び出しは、
 * 直前のクリック操作とは時間的に切り離された「プログラム的な」フォーカスに
 * なる。実ブラウザ(Chromium系)はこの手の遅延フォーカスに対し、直前の入力
 * モダリティがマウスであっても`:focus-visible`をtrueと判定し（キーボードで
 * 開いた場合と区別できず）、マウスで開いたはずの設定/ショートカット一覧の
 * 閉じるボタンに毎回フォーカスリングが出てしまっていた。コンテナ自身は
 * 呼び出し元で`outline-none`を付けているため、フォーカスしても見た目に
 * 変化が起きない。キーボードで開いた場合（`openedViaMouse=false`）は
 * 従来通り最初のフォーカス可能要素（閉じるボタン）にフォーカスし、
 * そこに正しくリングが出る。
 *
 * `Settings`（設定モーダル）・`ShortcutsOverlay`（ショートカット一覧）の両方から
 * 使う共通ロジック。Escapeでの閉じ方は呼び出し元（`App.tsx`のキーボードハンドラ）
 * が担当するため、ここでは扱わない。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  openedViaMouse: boolean = false,
): void {
  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const openedViaKeyboard = isFocusVisible(previouslyFocused);

    const focusFirst = () => {
      if (openedViaMouse) {
        container.focus();
        return;
      }
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
      // コンテナ自身にフォーカスがある状態（openedViaMouse時の初期状態）から
      // Tab/Shift+Tabを押した場合も、先頭/末尾として扱う（#66レビュー3巡目
      // should）。そうしないと、Shift+Tabがコンテナより手前のDOM順にある
      // 背景側の要素へ抜けてしまう恐れがある。
      const atBoundaryOrOutside = active === container || !container.contains(active);
      if (e.shiftKey) {
        if (active === first || atBoundaryOrOutside) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || atBoundaryOrOutside) {
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
  }, [isOpen, containerRef, openedViaMouse]);
}
