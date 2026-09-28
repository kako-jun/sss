// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isTypingTarget } from './keyboardShortcuts';

// #66 問題1: 設定中のESCはモーダルを閉じるが、input/textarea/contentEditableへの
// テキスト入力中は除外し、ブラウザの既定動作に任せる。この判定の単体テスト。
describe('isTypingTarget (#66 問題1)', () => {
  it('returns true for an <input> element', () => {
    const input = document.createElement('input');
    expect(isTypingTarget(input)).toBe(true);
  });

  it('returns true for a <textarea> element', () => {
    const textarea = document.createElement('textarea');
    expect(isTypingTarget(textarea)).toBe(true);
  });

  it('returns true for a contentEditable element', () => {
    // jsdomはcontentEditable属性の反映(isContentEditableの実計算)を実装していない
    // ため、プロパティを直接スタブして判定ロジックだけを検証する。
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  it('returns false for a <button> element', () => {
    const button = document.createElement('button');
    expect(isTypingTarget(button)).toBe(false);
  });

  it('returns false for document.body', () => {
    expect(isTypingTarget(document.body)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it('returns false for a non-HTMLElement EventTarget (e.g. document)', () => {
    expect(isTypingTarget(document)).toBe(false);
  });
});
