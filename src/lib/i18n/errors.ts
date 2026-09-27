import { t } from './t';

/**
 * バックエンドのユーザー向けエラーはエラーコード（＋`code:detail`形式の任意の
 * 詳細）で返る（#80）。旧実装は日本語決め打ちの文言をそのまま返し、フロントは
 * それをそのまま画面に出していた（言語切替に追従できない）。
 *
 * `code:detail` の区切りは最初の `:` のみで割る（`detail` 自体に `:` が
 * 含まれていてもコード名は固定の識別子なので誤分割しない）。
 */
function splitBackendError(raw: string): { code: string; detail?: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { code: raw };
  return { code: raw.slice(0, idx), detail: raw.slice(idx + 1) };
}

/**
 * `scan_directory`（および `ScanGuard` を共有する `reset_all_data`）が返す
 * エラーコードを表示文言へ変換する。`path` は呼び出し元が渡した対象ディレクトリ
 * （バックエンドは文字列にパスを埋め込み直さないため、フロントが自分の知っている
 * 値を補う）。未知のコード（想定外の内部エラー等）はそのまま返す（ログ相当の
 * 英語文言でも実害は小さいためフォールバックとして許容する）。
 */
export function resolveScanErrorMessage(raw: string, path: string): string {
  const { code } = splitBackendError(raw);
  switch (code) {
    case 'scanInProgress':
      return t('errorScanInProgress');
    case 'directoryNotFound':
      return t('errorDirectoryNotFound', { path });
    case 'directoryUnsafe':
      return t('errorDirectoryUnsafe', { path });
    default:
      return raw;
  }
}

/** `add_ignore_pattern` が返すエラーコードを表示文言へ変換する。 */
export function resolveAddPatternErrorMessage(raw: string): string {
  const { code, detail } = splitBackendError(raw);
  switch (code) {
    case 'patternEmpty':
      return t('errorPatternEmpty');
    case 'invalidPattern':
      return t('errorInvalidPattern', { detail: detail ?? '' });
    case 'addIgnoreRuleFailed':
      return t('errorAddIgnoreRuleFailed');
    default:
      return t('addPatternFailedGeneric');
  }
}

/** `reset_all_data`（`reset_core`）が返すエラーコードを表示文言へ変換する。 */
export function resolveResetAllDataErrorMessage(raw: string): string {
  const { code } = splitBackendError(raw);
  switch (code) {
    case 'scanInProgress':
      return t('errorScanInProgress');
    case 'dbResetFailed':
      return t('errorDbResetFailed');
    default:
      return raw;
  }
}
