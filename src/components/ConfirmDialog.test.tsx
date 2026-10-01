// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ConfirmDialogHost } from './ConfirmDialog';
import { confirmDialog, isConfirmDialogOpen } from '../lib/confirmDialog';
import { setLanguageSetting } from '../lib/i18n/store';

// #119: アプリ内確認モーダルの挙動・a11y。setup.ts が window.confirm を
// Promise 版（Tauri 実機と同じ）に差し替えている。

function open(message = '本当に実行しますか？\n\n取り消せません') {
  let promise!: Promise<boolean>;
  act(() => {
    promise = confirmDialog({ message, confirmLabel: '実行' });
  });
  return promise;
}

describe('window.confirm in the test environment mirrors Tauri (#119)', () => {
  it('returns a truthy Promise, which is exactly why `if (!confirm())` passes through', () => {
    // eslint-disable-next-line no-restricted-properties -- 差し替え済みの挙動そのものを検証する
    const r = window.confirm('x') as unknown;
    expect(r).toBeInstanceOf(Promise);
    expect(!r).toBe(false);
  });
});

describe('ConfirmDialogHost (#119)', () => {
  it('resolves false when no host is mounted (fail-safe)', async () => {
    await expect(confirmDialog({ message: 'm', confirmLabel: 'ok' })).resolves.toBe(false);
  });

  it('exposes alertdialog a11y attributes and renders the message', async () => {
    render(<ConfirmDialogHost />);
    const p = open();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const msg = document.getElementById(dialog.getAttribute('aria-describedby') as string);
    expect(msg?.textContent).toBe('本当に実行しますか？\n\n取り消せません');
    expect(isConfirmDialogOpen()).toBe(true);
    fireEvent.click(screen.getByText('キャンセル'));
    await expect(p).resolves.toBe(false);
    expect(isConfirmDialogOpen()).toBe(false);
  });

  it("focuses the Cancel button by default (after useFocusTrap's rAF has run)", async () => {
    render(<ConfirmDialogHost />);
    const p = open();
    // useFocusTrap は requestAnimationFrame でフォーカスを移す。それが済む前の状態では
    // 何も保証できないので、rAF 完了を待ってから確認する。
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(document.activeElement).toBe(screen.getByText('キャンセル'));
    expect(document.activeElement).not.toBe(screen.getByText('実行'));
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });

  it('labels the dialog with a visually hidden title', async () => {
    render(<ConfirmDialogHost />);
    const p = open();
    const dialog = screen.getByRole('alertdialog');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') as string);
    expect(title?.textContent).toBe('確認');
    expect(title?.className).toContain('sr-only');
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });

  it('resolves true only for the confirm button', async () => {
    render(<ConfirmDialogHost />);
    const p = open();
    fireEvent.click(screen.getByText('実行'));
    await expect(p).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false on ESC and keeps the event from reaching document-level handlers', async () => {
    const appHandler = vi.fn();
    document.addEventListener('keydown', appHandler, true);
    render(<ConfirmDialogHost />);
    const p = open();
    fireEvent.keyDown(screen.getByText('実行'), { key: 'Escape' });
    await expect(p).resolves.toBe(false);
    expect(appHandler).not.toHaveBeenCalled();
    document.removeEventListener('keydown', appHandler, true);
  });

  it('resolves false on backdrop click but not on a click inside the panel', async () => {
    render(<ConfirmDialogHost />);
    const p = open();
    fireEvent.click(screen.getByRole('alertdialog'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'));
    await expect(p).resolves.toBe(false);
  });

  it('traps Tab inside the dialog (wraps from the last button to the first)', async () => {
    render(<ConfirmDialogHost />);
    const p = open();
    const ok = screen.getByText('実行');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('キャンセル')));
    ok.focus();
    fireEvent.keyDown(ok, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('キャンセル'));
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });

  it('localizes the Cancel label', async () => {
    setLanguageSetting('en');
    render(<ConfirmDialogHost />);
    const p = open();
    fireEvent.click(screen.getByText('Cancel'));
    await expect(p).resolves.toBe(false);
  });

  it('cancels the pending request if the host unmounts', async () => {
    const { unmount } = render(<ConfirmDialogHost />);
    const p = open();
    unmount();
    await expect(p).resolves.toBe(false);
  });

  it('pins the last paragraph outside the scroll area, and keeps the full text for aria-describedby', async () => {
    render(<ConfirmDialogHost />);
    const p = open('一段落目\n\n二段落目\n\n取り消せません');
    const dialog = screen.getByRole('alertdialog');
    const final = screen.getByTestId('confirm-dialog-final');
    expect(final.textContent).toBe('取り消せません');
    // 最終段落はスクロール領域（overflow-y-auto）の内側にない
    expect(final.closest('.overflow-y-auto')).toBeNull();
    const scroller = dialog.querySelector('.overflow-y-auto') as HTMLElement;
    expect(scroller.textContent).toBe('一段落目\n\n二段落目');
    const described = document.getElementById(dialog.getAttribute('aria-describedby') as string);
    expect(described?.textContent).toBe('一段落目\n\n二段落目\n\n取り消せません');
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });

  it('works with a single-paragraph message (no pinned paragraph)', async () => {
    render(<ConfirmDialogHost />);
    const p = open('一段落だけ');
    expect(screen.queryByTestId('confirm-dialog-final')).toBeNull();
    expect(screen.getByRole('alertdialog').querySelector('.overflow-y-auto')?.textContent).toBe(
      '一段落だけ',
    );
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });

  it('scrolls the overflowing body with arrow/Page/Home/End keys while Cancel keeps focus, and resolves nothing', async () => {
    render(<ConfirmDialogHost />);
    const settled = vi.fn();
    const p = open('長い\n\n警告').then(settled);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    const scroller = screen
      .getByRole('alertdialog')
      .querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    const cancel = screen.getByText('キャンセル');
    expect(document.activeElement).toBe(cancel);

    // fireEvent は defaultPrevented だと false を返す。スクロール系キーは必ず preventDefault する。
    expect(fireEvent.keyDown(cancel, { key: 'ArrowDown' })).toBe(false);
    expect(scroller.scrollTop).toBe(24);
    expect(fireEvent.keyDown(cancel, { key: 'PageDown' })).toBe(false);
    expect(scroller.scrollTop).toBe(24 + 76);
    expect(fireEvent.keyDown(cancel, { key: 'End' })).toBe(false);
    expect(scroller.scrollTop).toBe(500);
    expect(fireEvent.keyDown(cancel, { key: 'PageUp' })).toBe(false);
    expect(fireEvent.keyDown(cancel, { key: 'ArrowUp' })).toBe(false);
    expect(fireEvent.keyDown(cancel, { key: 'Home' })).toBe(false);
    expect(scroller.scrollTop).toBe(0);
    // スクロールと無関係なキー（Tab/Enter/Space）は奪わない
    for (const key of ['Tab', 'Enter', ' ']) {
      expect(fireEvent.keyDown(cancel, { key })).toBe(true);
    }
    // フォーカスはキャンセルのまま・ダイアログは閉じない（IPC 相当の解決も起きない）
    expect(document.activeElement).toBe(cancel);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(settled).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    await p;
  });

  it('does not hijack arrow keys when the body does not overflow', async () => {
    render(<ConfirmDialogHost />);
    const p = open('短い\n\n警告');
    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']) {
      expect(fireEvent.keyDown(screen.getByText('キャンセル'), { key })).toBe(true);
    }
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });

  it('ignores empty paragraphs (a message ending in \\n\\n still pins the real last paragraph)', async () => {
    render(<ConfirmDialogHost />);
    const p = open('本文\n\n警告\n\n');
    expect(screen.getByTestId('confirm-dialog-final').textContent).toBe('警告');
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
    const q = open('\n\n本文のみ\n\n');
    expect(screen.queryByTestId('confirm-dialog-final')).toBeNull();
    expect(screen.getByRole('alertdialog').querySelector('.overflow-y-auto')?.textContent).toBe(
      '本文のみ',
    );
    fireEvent.click(screen.getByText('キャンセル'));
    await q;
  });

  it('shows a scroll hint only while more text is below', async () => {
    render(<ConfirmDialogHost />);
    const p = open('長い\n\n警告');
    expect(screen.queryByText('矢印キーで続きを表示')).toBeNull();
    const scroller = screen
      .getByRole('alertdialog')
      .querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    fireEvent.scroll(scroller);
    expect(screen.getByText('矢印キーで続きを表示')).toBeTruthy();
    fireEvent.keyDown(screen.getByText('キャンセル'), { key: 'End' });
    expect(screen.queryByText('矢印キーで続きを表示')).toBeNull();
    fireEvent.click(screen.getByText('キャンセル'));
    await p;
  });
});
