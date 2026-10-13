import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { OverlayUIHandle } from '../components/OverlayUI';
import { isConfirmDialogOpen } from '../lib/confirmDialog';
import { isTypingTarget, isFocusVisible, hasModifierKey } from '../lib/keyboardShortcuts';

export type KeyboardShortcutsParams = {
  canGoBack: boolean;
  isSettingsOpen: boolean;
  isShortcutsOpen: boolean;
  overlayRef: RefObject<OverlayUIHandle | null>;
  onPrevious: () => Promise<void> | void;
  onNext: () => Promise<void> | void;
  onToggleWindowMode: () => Promise<void> | void;
  onCloseSettings: () => void;
  onCloseShortcuts: () => void;
  /** `?` キー（キーボード起動として扱う）でのショートカット一覧の開閉 */
  onToggleShortcuts: () => void;
  onTogglePause: () => void;
  /** Esc での `exit_app` が失敗したとき（無反応にせず通知する） */
  onExitFailed: () => void;
};

/**
 * アプリ全体のキーボードショートカット（Esc / ← / → / ? / Space / F・F11）。
 *
 * #66レビューmust1: ハンドラが参照する値を全て「最新のref」に保持し、keydown
 * リスナー自体はマウント時に1回だけ登録する（deps=[]）。値の一部だけを deps に
 * 入れると、depsに無い値が初回レンダー時点に固定され F キーが1回しか効かなくなる
 * 等の stale closure を起こすため、構造的に無くす。
 *
 * #66レビュー2巡目must2: ref の更新は passive effect ではなくレンダー本体で直接
 * 代入する（effect だとコミット後に非同期flushされ、レンダー結果と一瞬ズレる余地が
 * あった）。
 */
export function useKeyboardShortcuts(params: KeyboardShortcutsParams): void {
  const paramsRef = useRef(params);
  // 意図的にレンダー本体で代入する（上記JSDoc参照）。
  // eslint-disable-next-line react-hooks/refs
  paramsRef.current = params;

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // #65: キーリピート(押しっぱなし)による多重発火を無視する（問題3関連）。
      if (e.repeat) return;
      // #66レビューmust2: meta/ctrl/altのいずれかを伴う場合は無視する
      // （Cmd+F/Ctrl+F等、OS/ブラウザ標準のショートカットとの衝突を避ける）。
      if (hasModifierKey(e)) return;

      // #119: 確認モーダル表示中は全ショートカットを無効化する（ESC は ConfirmDialogHost が
      // window の capture で先取りしてキャンセル扱いにする。ここへは届かない）。
      if (isConfirmDialogOpen()) return;

      const h = paramsRef.current;

      // ESCキー（#66 問題1）: 設定を開いている間は「閉じる」、それ以外は終了。
      // 自由テキストを打ち込める入力欄にフォーカスがある間はモーダルを閉じたり
      // アプリを終了したりせず、代わりにフォーカスを外す（#66レビューshould）。
      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          (e.target as HTMLElement).blur();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (h.isSettingsOpen) {
          h.onCloseSettings();
          return;
        }
        if (h.isShortcutsOpen) {
          h.onCloseShortcuts();
          return;
        }
        // #66レビューshould: オーバーレイの「…」メニュー（除外サブメニュー含む）が
        // 開いている間のESCは、それを閉じるだけにする。
        if (h.overlayRef.current?.isMenuOpen()) {
          h.overlayRef.current.closeMenu();
          return;
        }
        try {
          await invoke('exit_app');
        } catch (err) {
          console.error('Failed to exit app:', err);
          // #115: Esc を押しても何も起きない無反応にせず、上部の通知（#103）で失敗を伝える。
          h.onExitFailed();
        }
        return;
      }

      // 以降のショートカットは、設定モーダルを開いている間は入力欄との衝突を
      // 避けるため無効化する（矢印キーの既存挙動と同じ方針）。
      if (h.isSettingsOpen) return;

      // 左矢印キーで前の画像へ
      if (e.key === 'ArrowLeft' && h.canGoBack) {
        e.preventDefault();
        await h.onPrevious();
        return;
      }

      // 右矢印キーで次の画像へ
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        void h.onNext();
        return;
      }

      // #66 問題4: `?` でショートカット一覧の表示を切り替える。
      if (e.key === '?') {
        e.preventDefault();
        h.onToggleShortcuts();
        return;
      }

      if (h.isShortcutsOpen) return;

      // #66 問題4: Space で一時停止/再開をトグルする。
      // 実際にキーボードで `:focus-visible` なボタンにフォーカスしている間だけ、
      // そのボタンのネイティブなSpace起動を譲る（マウスクリック後の残留フォーカスは
      // 右上ピル/操作バーの onMouseDown ガードで発生しない。#66レビュー2巡目must1案a）。
      if (e.key === ' ' && !isTypingTarget(e.target)) {
        const activeElement = document.activeElement;
        const isKeyboardFocused =
          !!activeElement && activeElement !== document.body && isFocusVisible(activeElement);
        if (!isKeyboardFocused) {
          e.preventDefault();
          h.onTogglePause();
        }
        return;
      }

      // #66 問題4: F / F11 でフルスクリーンとウィンドウモードを切り替える。
      if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
        e.preventDefault();
        await h.onToggleWindowMode();
        return;
      }
    };

    // captureフェーズで最優先でキャッチ。
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);
}
