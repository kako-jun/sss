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
 * `select_and_scan` / `rescan_last_directory`（および `ScanGuard` を共有する `reset_all_data`）が返す
 * エラーコードを表示文言へ変換する。`path` は呼び出し元が渡した対象ディレクトリ
 * （バックエンドは文字列にパスを埋め込み直さないため、フロントが自分の知っている
 * 値を補う）。未知のコード（想定外の内部エラー等）はそのまま返す（ログ相当の
 * 英語文言でも実害は小さいためフォールバックとして許容する）。
 */
export function resolveScanErrorMessage(raw: string, path: string): string {
  const { code, detail } = splitBackendError(raw);
  // #93: バックエンドは `directoryNotFound:{選んだパス}` のように実際に拒否したパスを
  // detail で返す。あればそれを優先する（選択に失敗したとき画面に残っている旧フォルダを出さない）。
  const shownPath = detail || path;
  switch (code) {
    case 'scanInProgress':
      return t('errorScanInProgress');
    case 'dialogInProgress':
      return t('errorDialogInProgress');
    case 'directoryNotFound':
      return t('errorDirectoryNotFound', { path: shownPath });
    case 'directoryUnsafe':
      return t('errorDirectoryUnsafe', { path: shownPath });
    case 'noLastDirectory':
      return t('errorNoLastDirectory');
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

/**
 * `pick_image` が返すエラーコードを表示文言へ変換する（#87）。既知コード以外
 * （コピー失敗などの内部エラー）は従来どおり汎用の失敗文言にする。
 */
export function resolvePickErrorMessage(raw: string): string {
  const { code } = splitBackendError(raw);
  switch (code) {
    case 'pathNotManaged':
      return t('errorPathNotManaged');
    case 'notMediaFile':
      return t('errorNotMediaFile');
    // #115: コピー失敗の原因（バックエンド `pick::pick_io_error_code` のコード）
    case 'pickPermissionDenied':
      return t('errorPickPermissionDenied');
    case 'pickDiskFull':
      return t('errorPickDiskFull');
    case 'pickDestinationMissing':
      return t('errorPickDestinationMissing');
    case 'imageFileNotFound':
      return t('errorPickSourceMissing');
    default:
      return t('pickCopyFailed');
  }
}

/**
 * `open_in_explorer` が返すエラーコードを表示文言へ変換する（#92）。既知コード以外は
 * 汎用の失敗文言にする。
 */
export function resolveOpenInExplorerErrorMessage(raw: string): string {
  const { code } = splitBackendError(raw);
  switch (code) {
    case 'pathNotManaged':
      return t('errorOpenNotManaged');
    case 'imageFileNotFound':
      return t('errorImageFileNotFound');
    default:
      return t('openInExplorerFailed');
  }
}

/**
 * `exclude_image` が返すエラーコードを表示文言へ変換する（#92）。既知コード以外は
 * 従来どおり汎用の除外失敗文言にする。
 */
export function resolveExcludeErrorMessage(raw: string): string {
  const { code } = splitBackendError(raw);
  switch (code) {
    case 'pathNotManaged':
      return t('errorExcludeNotManaged');
    default:
      return t('excludeFailed');
  }
}

/** `select_share_directory` が返すエラーコードを表示文言へ変換する（#87）。 */
export function resolveShareDirectoryErrorMessage(raw: string): string {
  const { code } = splitBackendError(raw);
  switch (code) {
    case 'shareDirectoryInvalid':
      return t('errorShareDirectoryInvalid');
    case 'dialogInProgress':
      return t('errorDialogInProgress');
    default:
      return t('errorShareDirectorySaveFailed');
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

/**
 * 起動時の自動スキャン失敗（`App.tsx`の`directoryError`）専用の変換（#82レビュー
 * nit）。既知のエラーコードは `errorDirectoryNotFound` 等それ自体が既に状況を
 * 説明する完成した文（例:「指定したフォルダが見つかりません: {path}」）なので、
 * さらに `startupDirectoryRejected`（「前回のフォルダに接続できませんでした:
 * {reason}」）で二重に包まない。未知のコード（想定外の内部エラー等、それ単体では
 * 文脈が分からない断片）だけ `startupDirectoryRejected` で前置きを付ける。
 */
export function resolveStartupDirectoryError(raw: string, directory: string): string {
  const { code, detail } = splitBackendError(raw);
  const shownPath = detail || directory;
  switch (code) {
    case 'scanInProgress':
      return t('errorScanInProgress');
    case 'directoryNotFound':
      return t('errorDirectoryNotFound', { path: shownPath });
    case 'directoryUnsafe':
      return t('errorDirectoryUnsafe', { path: shownPath });
    case 'noLastDirectory':
      return t('errorNoLastDirectory');
    default:
      return t('startupDirectoryRejected', { reason: raw });
  }
}
