import { RefreshCw } from 'lucide-react';
import { useT } from '../../lib/i18n';

/**
 * 取得失敗の表示（#115）。「本当に空」の空状態（「〜はありません」）とは見た目も文言も
 * 区別し、再試行ボタンを必ず添える。
 */
export function LoadError({
  onRetry,
  message,
  testId = 'load-error',
}: {
  onRetry: () => void;
  /** 省略時は汎用の「読み込みに失敗しました」。 */
  message?: string;
  testId?: string;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      data-testid={testId}
      className="p-4 bg-black/30 rounded-lg text-center space-y-3"
    >
      <p className="text-red-400/80 text-sm">{message ?? t('loadFailed')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/8 hover:bg-white/15 text-white/60 hover:text-white/80 rounded-lg transition-colors text-sm"
      >
        <RefreshCw className="w-4 h-4" aria-hidden="true" />
        {t('retryButton')}
      </button>
    </div>
  );
}

/**
 * 保存・削除などの操作失敗の通知（#115）。セクションごとに1か所だけ出し、同じ失敗が
 * 続いても積み上げない（メッセージを置き換えるだけ。state が同じなら再描画もされない）。
 * 設定の取得失敗（再試行付き）は `onRetry` を渡す。
 */
export function InlineError({
  message,
  onRetry,
  testId = 'inline-error',
}: {
  message: string | null;
  onRetry?: () => void;
  testId?: string;
}) {
  const t = useT();
  if (!message) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-red-400/80"
    >
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="underline underline-offset-2 text-red-400/80 hover:text-red-300"
        >
          {t('retryButton')}
        </button>
      )}
    </div>
  );
}
