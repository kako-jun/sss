import type { MessageKey } from './i18n';

/**
 * 画面上部の失敗通知（App のトースト）へ届ける小さな通知経路（#115）。
 *
 * セクション内の通知（`InlineError`）は、そのセクションがアンマウントされた後（設定を閉じた後に
 * 遅れて完了した保存の失敗など）には見えない。そうした「巻き戻しだけが起きて理由が分からない」
 * 失敗を、アンマウントに依存しない App のトーストにも出すために使う。購読者が居なければ何もしない
 * （単体で描画するコンポーネントのテスト用）。文言は辞書キーで受け、購読側が現在のロケールで解決する。
 */
type Listener = (key: MessageKey) => void;

const listeners = new Set<Listener>();

export function subscribeFailureNotice(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyFailure(key: MessageKey): void {
  for (const listener of [...listeners]) listener(key);
}
