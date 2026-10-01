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
});
