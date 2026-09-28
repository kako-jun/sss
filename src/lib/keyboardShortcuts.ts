/**
 * グローバルなキーボードショートカット（`App.tsx`）が、テキスト入力中の
 * キー入力を誤って奪わないための判定（#66 問題1）。
 *
 * 設定モーダルを開いている間のESCは通常モーダルを閉じるが、入力欄
 * （input/textarea/contentEditable）にフォーカスがある間はブラウザの既定動作
 * （テキストの取消等）に任せ、モーダルを閉じたりアプリを終了したりしない。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // `!!`: 仕様上isContentEditableは常にboolean値だが、テスト環境(jsdom)は
  // このプロパティを実装しておらずundefinedを返すため、明示的にboolean化する。
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!target.isContentEditable;
}
