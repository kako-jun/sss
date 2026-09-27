/**
 * UI文言の集約辞書（#65）。
 *
 * i18n本体は別Issue #80で扱う予定（#65より前には着手しない）。ここでは #80 で
 * ja/en に分割しやすいよう、あらかじめ2つの構造に分けておく:
 *
 * - `uiText`: 画面の固定ラベル・見出し・案内文。「キー → 文言」のフラットな
 *   オブジェクト（ネストしない。#80でロケールごとの同じキー集合に機械的に
 *   展開できるようにするため）。
 * - `noticeMessages`: バックエンド/フロントの状態コード → 文言。
 *   `ImageNavigationResult`（#65）の `kind` や、起動シーケンスの失敗種別など、
 *   「意味のあるコード」に対応する短い日本語文を1箇所にまとめる。
 *
 * どちらも値は日本語決め打ちの `string`（#80で `Record<Locale, string>` 等に
 * 置き換える前提のプレースホルダ）。
 */

export const uiText = {
  welcomeTitle: 'ようこそ SSS へ',
  welcomeSubtitle: '写真フォルダを選択してスライドショーを始めましょう',
  selectFolder: 'フォルダを選択',
  openSettings: '設定を開く',
  loadingPlaylist: 'プレイリストを読み込んでいます...',
  pleaseWait: 'しばらくお待ちください',
  emptyPlaylistTitle: '表示できる写真がありません',
  emptyPlaylistSubtitle:
    '除外ルールで全て除外されているか、フォルダに対象ファイルがありません。設定から確認してください。',
  exitTooltip: 'ESCで終了',
  // #65レビュー: 起動時の前景スキャン（restorePlaylist失敗→scanDirectory待ち）が
  // 失敗した場合の案内タイトル。ディレクトリ自体は設定済みなので「ようこそ」とは
  // 区別する。理由の詳細は noticeMessages.startupDirectoryRejected を別行で表示する。
  directoryUnreachableTitle: '前回のフォルダを読めません',
} as const;

/**
 * 状態コード → 短い日本語文。
 *
 * - `next*` / `previous*`: `ImageNavigationResult`（バックエンド, #65）の `kind`
 *   のうち、鑑賞中の画面に何らかの通知が要るもの。
 * - `startupDirectoryRejected`: 起動時自動スキャンで前回ディレクトリへの
 *   アクセスが拒否された場合の理由表示（#65本文コメント: 「これからやること」）。
 */
export const noticeMessages = {
  rootUnavailable: 'フォルダに接続できません。再接続をお待ちください…',
  loadFailedGaveUp: '複数の写真の読み込みに失敗しました。フォルダの状態を確認してください。',
  startupDirectoryRejected: (reason: string) => `前回のフォルダに接続できませんでした: ${reason}`,
} as const;
