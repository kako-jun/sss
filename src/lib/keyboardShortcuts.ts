/**
 * グローバルなキーボードショートカット（`App.tsx`）が、テキスト入力中の
 * キー入力を誤って奪わないための判定（#66 問題1、#66レビューmust/should）。
 *
 * 設定モーダルを開いている間のESCは通常モーダルを閉じるが、自由テキストを
 * 打ち込める欄（text/search/url/email/password等のinputとtextarea、
 * contentEditable）にフォーカスがある間はESCを奪わない。checkbox/range/number
 * などの非テキスト系inputは対象外（#66レビューshould: これらの上でESCを
 * 押した時にモーダルが閉じないのは、テキスト編集中でないのに操作を奪う方が
 * 不自然なため）。
 */
const FREE_TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'tel']);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT') {
    // type未指定のinputはHTML仕様上 既定で"text"（HTMLInputElement.typeも'text'を返す）。
    const type = (target as HTMLInputElement).type || 'text';
    return FREE_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * `:focus-visible` を安全に判定する（#66レビューmust2）。未対応環境や無効な
 * セレクタで`matches()`が例外を投げても落ちないようtry/catchする。
 *
 * jsdom（vitestのテスト環境）は`:focus-visible`の実計算を実装しておらず、
 * 常にfalseを返す既知の制約がある。実際のフォーカス可視性の検証は実ブラウザ
 * e2e（`npm run e2e`）が担当し、単体テストは`Element.prototype.matches`を
 * 個別にスタブして両方の分岐を確認する。
 */
export function isFocusVisible(el: Element | null | undefined): boolean {
  if (!el) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * meta/ctrl/altのいずれかを伴うキー入力か（#66レビューmust2）。Cmd+F（ブラウザの
 * 検索）等、OS/ブラウザ標準のショートカットとの衝突を避けるため、修飾キー付きの
 * 入力はアプリ側のショートカットとして扱わない。Shiftは対象外（`?`はUS配列で
 * Shift+/のため）。
 */
export function hasModifierKey(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}
