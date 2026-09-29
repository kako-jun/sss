// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { isTypingTarget, isFocusVisible, hasModifierKey } from './keyboardShortcuts';

// #66 問題1・#66レビューshould: 設定中のESCはモーダルを閉じるが、自由テキストを
// 打ち込める欄（text/search/url/email/password等のinputとtextarea、
// contentEditable）にフォーカスがある間は除外し、ブラウザの既定動作に任せる。
// checkbox/range/numberなどの非テキスト系inputは対象外（この判定はfalseになり、
// モーダルは通常通り閉じる）。
describe('isTypingTarget (#66 問題1, #66レビューshould)', () => {
  it('returns true for a plain <input> (type defaults to text)', () => {
    const input = document.createElement('input');
    expect(isTypingTarget(input)).toBe(true);
  });

  it.each(['text', 'search', 'url', 'email', 'password', 'tel'])(
    'returns true for <input type="%s">',
    (type) => {
      const input = document.createElement('input');
      input.type = type;
      expect(isTypingTarget(input)).toBe(true);
    },
  );

  it.each(['checkbox', 'range', 'number', 'radio', 'color', 'date', 'file'])(
    'returns false for <input type="%s"> (#66レビューshould)',
    (type) => {
      const input = document.createElement('input');
      input.type = type;
      expect(isTypingTarget(input)).toBe(false);
    },
  );

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

// #66レビューmust2: idle-fadeの`has-[:focus-visible]`・Spaceキーの残留フォーカス
// 判定・`useFocusTrap`のフォーカス復帰/blur判定が共通して使う。jsdomは
// `:focus-visible`の実計算を実装していないため常にfalseを返すが、`matches()`を
// スタブして両方の分岐を確認する（実ブラウザでの検証はe2eが担当）。
describe('isFocusVisible (#66レビューmust2)', () => {
  it('returns false for null/undefined', () => {
    expect(isFocusVisible(null)).toBe(false);
    expect(isFocusVisible(undefined)).toBe(false);
  });

  it('returns false in jsdom by default (documented limitation)', () => {
    const button = document.createElement('button');
    expect(isFocusVisible(button)).toBe(false);
  });

  it('returns true when matches(":focus-visible") is stubbed to true', () => {
    const button = document.createElement('button');
    vi.spyOn(button, 'matches').mockReturnValue(true);
    expect(isFocusVisible(button)).toBe(true);
  });

  it('returns false (not throw) when matches() throws', () => {
    const button = document.createElement('button');
    vi.spyOn(button, 'matches').mockImplementation(() => {
      throw new Error('not supported');
    });
    expect(isFocusVisible(button)).toBe(false);
  });
});

describe('hasModifierKey (#66レビューmust2)', () => {
  const baseEvent = { key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it('returns false when no modifier is held', () => {
    expect(hasModifierKey({ ...baseEvent } as KeyboardEvent)).toBe(false);
  });

  it('returns true for meta/ctrl/alt individually', () => {
    expect(hasModifierKey({ ...baseEvent, metaKey: true } as KeyboardEvent)).toBe(true);
    expect(hasModifierKey({ ...baseEvent, ctrlKey: true } as KeyboardEvent)).toBe(true);
    expect(hasModifierKey({ ...baseEvent, altKey: true } as KeyboardEvent)).toBe(true);
  });

  it('returns false for Shift alone (needed for "?" on US layout)', () => {
    expect(hasModifierKey({ ...baseEvent, shiftKey: true } as KeyboardEvent)).toBe(false);
  });
});
