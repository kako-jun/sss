// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { useKeyboardShortcuts, type KeyboardShortcutsParams } from './useKeyboardShortcuts';
import { confirmDialog, registerConfirmDialogHost } from '../lib/confirmDialog';

function makeParams(over: Partial<KeyboardShortcutsParams> = {}): KeyboardShortcutsParams {
  return {
    canGoBack: true,
    isSettingsOpen: false,
    isShortcutsOpen: false,
    overlayRef: { current: null },
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onToggleWindowMode: vi.fn(),
    onCloseSettings: vi.fn(),
    onCloseShortcuts: vi.fn(),
    onToggleShortcuts: vi.fn(),
    onTogglePause: vi.fn(),
    onExitFailed: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
});

function setup(over: Partial<KeyboardShortcutsParams> = {}) {
  const params = makeParams(over);
  const hook = renderHook((p: KeyboardShortcutsParams) => useKeyboardShortcuts(p), {
    initialProps: params,
  });
  return { params, ...hook };
}

describe('useKeyboardShortcuts: dispatch', () => {
  it('ArrowRight -> onNext, ArrowLeft -> onPrevious only when canGoBack', () => {
    const { params, rerender } = setup({ canGoBack: false });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(params.onNext).toHaveBeenCalledTimes(1);
    expect(params.onPrevious).not.toHaveBeenCalled();

    rerender({ ...params, canGoBack: true });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(params.onPrevious).toHaveBeenCalledTimes(1);
  });

  it('? toggles the shortcuts overlay, even when it is already open', () => {
    const { params } = setup({ isShortcutsOpen: true });
    fireEvent.keyDown(document, { key: '?' });
    expect(params.onToggleShortcuts).toHaveBeenCalledTimes(1);
  });

  it('f / F / F11 toggle the window mode', () => {
    const { params } = setup();
    for (const key of ['f', 'F', 'F11']) fireEvent.keyDown(document, { key });
    expect(params.onToggleWindowMode).toHaveBeenCalledTimes(3);
  });

  it('Space toggles pause on the body, but not while typing in an input', () => {
    const { params } = setup();
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(params.onTogglePause).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: ' ' });
    expect(params.onTogglePause).toHaveBeenCalledTimes(1);
  });

  it('Space is left to a button that really has :focus-visible focus', () => {
    const { params } = setup();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    const spy = vi.spyOn(button, 'matches').mockImplementation((sel) => sel === ':focus-visible');
    fireEvent.keyDown(button, { key: ' ' });
    expect(params.onTogglePause).not.toHaveBeenCalled();
    // 残留フォーカス（:focus-visible でない）ならアプリの一時停止として扱う
    spy.mockImplementation(() => false);
    fireEvent.keyDown(button, { key: ' ' });
    expect(params.onTogglePause).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated keys', () => {
    const { params } = setup();
    fireEvent.keyDown(document, { key: 'a' });
    expect(params.onNext).not.toHaveBeenCalled();
    expect(params.onToggleWindowMode).not.toHaveBeenCalled();
    expect(params.onTogglePause).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts: guards', () => {
  it('ignores key repeat (held-down keys), but not a fresh press (#65)', () => {
    const { params } = setup();
    fireEvent.keyDown(document, { key: 'ArrowRight', repeat: true });
    expect(params.onNext).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'ArrowRight', repeat: false });
    expect(params.onNext).toHaveBeenCalledTimes(1);
  });

  it('ignores meta/ctrl/alt combinations such as Cmd+F, Ctrl+F and Ctrl+Escape (#66)', () => {
    const { params } = setup();
    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'f', altKey: true });
    fireEvent.keyDown(document, { key: 'Escape', ctrlKey: true });
    expect(params.onToggleWindowMode).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(params.onCloseSettings).not.toHaveBeenCalled();
  });

  it('disables everything except the modal-owned Escape while Settings is open', () => {
    const { params } = setup({ isSettingsOpen: true });
    for (const key of ['ArrowRight', 'ArrowLeft', 'f', ' ', '?']) {
      fireEvent.keyDown(document.body, { key });
    }
    expect(params.onNext).not.toHaveBeenCalled();
    expect(params.onPrevious).not.toHaveBeenCalled();
    expect(params.onToggleWindowMode).not.toHaveBeenCalled();
    expect(params.onTogglePause).not.toHaveBeenCalled();
    expect(params.onToggleShortcuts).not.toHaveBeenCalled();
  });

  it('while the shortcuts overlay is open, Space and F are disabled but ? and arrows still work', () => {
    const { params } = setup({ isShortcutsOpen: true });
    fireEvent.keyDown(document.body, { key: ' ' });
    fireEvent.keyDown(document, { key: 'f' });
    expect(params.onTogglePause).not.toHaveBeenCalled();
    expect(params.onToggleWindowMode).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(params.onNext).toHaveBeenCalledTimes(1);
  });

  it('is fully disabled while the confirm dialog is open, and works again after it closes (#119)', async () => {
    const unregister = registerConfirmDialogHost();
    const { params } = setup();
    let result!: Promise<boolean>;
    act(() => {
      result = confirmDialog({ message: 'm', confirmLabel: 'ok' });
    });
    for (const key of ['ArrowRight', 'f', ' ', '?', 'Escape']) {
      fireEvent.keyDown(document.body, { key });
    }
    await act(async () => {});
    expect(params.onNext).not.toHaveBeenCalled();
    expect(params.onToggleWindowMode).not.toHaveBeenCalled();
    expect(params.onTogglePause).not.toHaveBeenCalled();
    expect(params.onToggleShortcuts).not.toHaveBeenCalled();
    expect(params.onCloseSettings).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    unregister(); // Host の取り外しで未解決の確認はキャンセル扱いになり閉じる
    await expect(result).resolves.toBe(false);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(params.onNext).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: Escape', () => {
  it('closes Settings first, then the shortcuts overlay, without exiting', () => {
    const a = setup({ isSettingsOpen: true, isShortcutsOpen: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(a.params.onCloseSettings).toHaveBeenCalledTimes(1);
    expect(a.params.onCloseShortcuts).not.toHaveBeenCalled();
    a.unmount();

    const b = setup({ isShortcutsOpen: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(b.params.onCloseShortcuts).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('closes the overlay "..." menu instead of exiting when it is open', () => {
    const closeMenu = vi.fn();
    setup({ overlayRef: { current: { isMenuOpen: () => true, closeMenu } } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('calls exit_app when nothing is open', async () => {
    setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('exit_app');
  });

  it('reports exit_app failures instead of doing nothing (#115)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockRejectedValue(new Error('nope'));
    const { params } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});
    expect(params.onExitFailed).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('blurs a text field instead of closing/exiting', () => {
    const { params } = setup({ isSettingsOpen: true });
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
    expect(params.onCloseSettings).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts: listener lifecycle and stale closures (#66レビューmust1)', () => {
  it('registers the capture listener once and removes it on unmount', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { rerender, unmount, params } = setup();
    rerender({ ...params, canGoBack: false });
    rerender({ ...params, isSettingsOpen: true });
    const keydownAdds = add.mock.calls.filter((c) => c[0] === 'keydown');
    expect(keydownAdds).toHaveLength(1);
    expect(keydownAdds[0][2]).toBe(true);
    unmount();
    expect(remove.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(params.onNext).not.toHaveBeenCalled();
    add.mockRestore();
    remove.mockRestore();
  });

  it('always calls the latest callbacks and flags, not the first render ones', () => {
    const first = makeParams();
    const { rerender } = renderHook((p: KeyboardShortcutsParams) => useKeyboardShortcuts(p), {
      initialProps: first,
    });
    const second = makeParams({ canGoBack: false });
    rerender(second);
    fireEvent.keyDown(document, { key: 'f' });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(first.onToggleWindowMode).not.toHaveBeenCalled();
    expect(second.onToggleWindowMode).toHaveBeenCalledTimes(1);
    expect(first.onPrevious).not.toHaveBeenCalled();
    expect(second.onPrevious).not.toHaveBeenCalled(); // 最新の canGoBack=false が効く
  });
});
