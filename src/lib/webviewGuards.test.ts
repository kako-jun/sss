// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import {
  installWebviewGuards,
  isBlockedBrowserShortcut,
  isContextMenuAllowedTarget,
} from './webviewGuards';

// #116: WebView 既定の右クリック/ブラウザ系ショートカットの抑止。

function key(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('isContextMenuAllowedTarget', () => {
  it('input / textarea / contentEditable は許可、それ以外は不許可', () => {
    expect(isContextMenuAllowedTarget(document.createElement('input'))).toBe(true);
    expect(isContextMenuAllowedTarget(document.createElement('textarea'))).toBe(true);
    const ce = document.createElement('div');
    // jsdom は isContentEditable を実装しないので直接定義する。
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    expect(isContextMenuAllowedTarget(ce)).toBe(true);
    expect(isContextMenuAllowedTarget(document.createElement('div'))).toBe(false);
    expect(isContextMenuAllowedTarget(document.createElement('button'))).toBe(false);
    expect(isContextMenuAllowedTarget(null)).toBe(false);
  });
});

describe('isBlockedBrowserShortcut', () => {
  it.each([
    ['F5', {}],
    ['F12', {}],
    ['F3', {}],
    ['F7', {}],
    ['r', { ctrlKey: true }],
    ['R', { ctrlKey: true, shiftKey: true }],
    ['r', { metaKey: true }],
    ['I', { ctrlKey: true, shiftKey: true }],
    ['J', { ctrlKey: true, shiftKey: true }],
    ['u', { ctrlKey: true }],
    ['p', { ctrlKey: true }],
    ['s', { ctrlKey: true }],
    ['f', { ctrlKey: true }],
    ['g', { ctrlKey: true }],
    ['o', { ctrlKey: true }],
    ['+', { ctrlKey: true, shiftKey: true }],
    ['=', { ctrlKey: true }],
    ['-', { ctrlKey: true }],
    ['0', { ctrlKey: true }],
    ['ArrowLeft', { altKey: true }],
    ['ArrowRight', { altKey: true }],
  ])('%s %j は抑止する', (k, mods) => {
    expect(isBlockedBrowserShortcut(key({ key: k, ...mods }))).toBe(true);
  });

  it.each([
    // アプリ自前のショートカット（#66）と確認モーダルのキー（#119）は触らない。
    ['f', {}],
    ['F', { shiftKey: true }],
    ['F11', {}],
    [' ', {}],
    ['?', { shiftKey: true }],
    ['ArrowLeft', {}],
    ['ArrowRight', {}],
    ['Escape', {}],
    ['Tab', {}],
    ['Tab', { shiftKey: true }],
    ['Enter', {}],
    // 入力欄の Ctrl+A/C/V/X/Z は通常どおり使える。
    ['a', { ctrlKey: true }],
    ['c', { ctrlKey: true }],
    ['v', { ctrlKey: true }],
    ['x', { ctrlKey: true }],
    ['z', { ctrlKey: true }],
    // 修飾キー無しの通常入力。
    ['r', {}],
    ['-', {}],
    ['0', {}],
  ])('%s %j は抑止しない', (k, mods) => {
    expect(isBlockedBrowserShortcut(key({ key: k, ...mods }))).toBe(false);
  });
});

describe('installWebviewGuards', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.innerHTML = '';
  });

  function fire(target: Element | Document, ev: Event): boolean {
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }
  const ctx = () => new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

  it('本番: 入力欄以外の右クリックは preventDefault、input/textarea では呼ばない', () => {
    cleanup = installWebviewGuards(document, { dev: false });
    const div = document.createElement('div');
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    document.body.append(div, input, area);
    expect(fire(div, ctx())).toBe(true);
    expect(fire(document.body, ctx())).toBe(true);
    expect(fire(input, ctx())).toBe(false);
    expect(fire(area, ctx())).toBe(false);
  });

  it('本番: ブラウザ系ショートカットは preventDefault、自前ショートカットは触らず伝播も止めない', () => {
    cleanup = installWebviewGuards(document, { dev: false });
    expect(fire(document.body, key({ key: 'F5' }))).toBe(true);
    expect(fire(document.body, key({ key: 'r', ctrlKey: true }))).toBe(true);
    expect(fire(document.body, key({ key: 'F12' }))).toBe(true);
    expect(fire(document.body, key({ key: '-', ctrlKey: true }))).toBe(true);

    let reached = 0;
    const spy = () => reached++;
    document.addEventListener('keydown', spy);
    for (const k of ['f', 'F11', ' ', '?', 'ArrowLeft', 'Escape', 'Tab', 'Enter']) {
      expect(fire(document.body, key({ key: k }))).toBe(false);
    }
    // 抑止対象でも stopPropagation はしない（後段のハンドラへ届く）。
    fire(document.body, key({ key: 'F5' }));
    document.removeEventListener('keydown', spy);
    expect(reached).toBe(9);
  });

  it('本番: Ctrl+ホイール（ズーム/ピンチ）は preventDefault、通常のホイールは触らない', () => {
    cleanup = installWebviewGuards(document, { dev: false });
    const w = (ctrlKey: boolean) =>
      new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey, deltaY: 10 });
    expect(fire(document.body, w(true))).toBe(true);
    expect(fire(document.body, w(false))).toBe(false);
  });

  it('開発時: 何も抑止しない（devtools・再読み込みを妨げない）', () => {
    cleanup = installWebviewGuards(document, { dev: true });
    expect(fire(document.body, ctx())).toBe(false);
    expect(fire(document.body, key({ key: 'F5' }))).toBe(false);
    expect(fire(document.body, key({ key: 'F12' }))).toBe(false);
    expect(fire(document.body, key({ key: 'r', ctrlKey: true }))).toBe(false);
  });

  it('解除関数で抑止が止まる', () => {
    const off = installWebviewGuards(document, { dev: false });
    off();
    expect(fire(document.body, ctx())).toBe(false);
    expect(fire(document.body, key({ key: 'F5' }))).toBe(false);
  });
});
