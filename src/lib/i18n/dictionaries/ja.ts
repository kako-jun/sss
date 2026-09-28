/**
 * 日本語辞書（#80）。
 *
 * キー → 文言のフラットなオブジェクト（ネストしない。`en.ts` と同じキー集合に
 * なることを `messages.test.ts` が検証する）。`{param}` 形式のプレースホルダは
 * `t(key, params)` が置換する。
 */
export const ja = {
  // === アプリ全体 ===
  windowTitle: 'sss - 写真スライドショー',
  exitTooltip: 'ESCで終了',
  settingsTitle: '設定',
  switchToWindowMode: 'ウィンドウモードに切り替え',
  switchToFullscreen: 'フルスクリーンに戻す',
  windowModeLabel: 'ウィンドウモード',
  fullscreenLabel: 'フルスクリーン',
  genericErrorTitle: 'エラーが発生しました',

  // === 起動時の案内画面（#65） ===
  welcomeTitle: 'ようこそ SSS へ',
  welcomeSubtitle: '写真フォルダを選択してスライドショーを始めましょう',
  selectFolder: 'フォルダを選択',
  openSettings: '設定を開く',
  loadingPlaylist: 'プレイリストを読み込んでいます...',
  pleaseWait: 'しばらくお待ちください',
  emptyPlaylistTitle: '表示できる写真がありません',
  emptyPlaylistSubtitle:
    '除外ルールで全て除外されているか、フォルダに対象ファイルがありません。設定から確認してください。',
  directoryUnreachableTitle: '前回のフォルダを読めません',
  directoryUnreachableSubtitle: '接続を確認するか、設定から別のフォルダを選んでください',
  rootUnavailable: 'フォルダに接続できません。再接続をお待ちください...',
  loadFailedGaveUp: '複数の写真の読み込みに失敗しました。フォルダの状態を確認してください。',
  startupDirectoryRejected: '前回のフォルダに接続できませんでした: {reason}',

  // === 起動シーケンスの状態表示（src/lib/startup.ts） ===
  statusLoadingSettings: '設定を読み込んでいます...',
  statusCheckingLastFolder: '前回フォルダを確認しています...',
  statusRestoringState: '前回の状態を復元しています...',
  statusLoadingImages: '画像を読み込んでいます...',
  statusScanningDirectory: 'フォルダをスキャンしています...',
  statusScanComplete: 'スキャン完了: {count}ファイル検出',

  // === オーバーレイUI ===
  menuTooltip: 'メニュー',
  pickTooltip: 'ピック（コピー）',
  previousTooltip: '前へ (←)',
  nextTooltip: '次へ (→)',
  pauseTooltip: '一時停止',
  playTooltip: '再生',
  openInFileManager: 'ファイルマネージャーで開く',
  viewPicks: 'ピックを見る',
  excludeMenuLabel: '除外',
  excludeByDate: '撮影日付で除外',
  excludeByDirectory: 'フォルダを除外',
  excludeByFile: 'ファイルを除外',
  noLocationInfo: '位置情報なし',
  noDateTime: '日時不明',
  locationMapAlt: '位置情報の地図',
  pickCopyDone: 'コピー完了: {path}',
  pickCopyFailed: 'エラー: コピー失敗',
  excludeFailed: 'エラー: 除外失敗',
  excludeAddedFile: '除外パターン追加: {pattern}',
  excludeAddedNeedsRescan: '除外パターン追加: {pattern} (変更を反映するには再スキャンしてください)',

  // === 設定画面: 共通 ===
  loadingLabel: '読み込み中...',
  selectButtonLabel: '選択',
  secondsUnit: '{value}秒',
  // #82レビューnit: IntervalSectionの「秒」単独表示は`secondsUnit`に空文字を
  // 渡す代用でなく専用キーにする。
  secondsUnitOnly: '秒',

  // === 設定画面: タブ ===
  tabScan: 'フォルダ',
  tabOptions: 'オプション',
  tabExclude: '除外ルール',
  tabPick: 'ピック',
  tabHistory: '履歴',
  tabStats: '統計グラフ',
  tabInfo: '情報',

  // === 設定画面: 入力（スキャン） ===
  directorySelectionTitle: 'フォルダ選択',
  scanningLabel: 'スキャン中...',
  scanLabel: 'スキャン',
  scanResultTitle: 'スキャン結果',
  fileCountLabel: 'ファイル数:',
  newFilesLabel: '新規:',
  deletedFilesLabel: '削除:',
  durationLabel: '処理時間:',
  readErrorsLabel: '読み取りエラー:',
  errorCountValue: '{count}件',
  keptAsUnknownNote: '（不明として保持、削除しません）',
  pleaseSelectDirectoryFirst: '先にフォルダを選択してください',
  failedToSelectDirectory: 'フォルダの選択に失敗しました',
  failedToScanDirectory: 'フォルダのスキャンに失敗しました',
  errorScanInProgress: 'スキャン実行中です。完了までお待ちください。',
  errorDirectoryNotFound: '指定したフォルダが見つかりません: {path}',
  errorDirectoryUnsafe: 'セキュリティ上の理由でこのフォルダは使用できません: {path}',
  selectDirectoryDialogTitle: '写真フォルダを選択',

  // === 設定画面: オプション ===
  displayIntervalTitle: '表示間隔',
  exifRotationLabel: 'EXIF回転情報に従って画像を自動回転',
  pickDestinationTitle: 'ピック先フォルダ',

  // === 設定画面: 除外ルール ===
  excludeRulesTitle: '除外ルール',
  noExcludeRules: '除外ルールはありません',
  dateRuleTag: '撮影日',
  removeTooltip: '解除',
  addPatternPlaceholder: 'パターンを入力（例: **/thumbs/）',
  addButtonLabel: '追加',
  errorPatternEmpty: 'パターンを入力してください',
  errorInvalidPattern: '無効なパターンです: {detail}',
  errorAddIgnoreRuleFailed: '除外ルールの追加に失敗しました',
  addPatternFailedGeneric: 'パターンの追加に失敗しました',

  // === 設定画面: ピック ===
  pickListTitle: 'ピック一覧',
  noPickedPhotos: 'ピックした写真はありません',
  deleteTooltip: '削除',
  // #82レビューshould5: ピック削除は実ファイルの削除であることと、元の写真は
  // 残ることを明示する（実挙動と文言を一致させる）。
  confirmDeletePickedPhoto: 'ピックフォルダのコピーを削除しますか？元の写真は残ります。',

  // === 設定画面: 履歴 ===
  recentHistoryTitle: '最近の表示履歴（最新100件）',
  noHistoryItems: '表示履歴はありません',
  excludeThisPhoto: 'この写真を除外',
  excludeThisDate: 'この日付を除外',
  excludeThisFolder: 'このフォルダを除外',

  // === 設定画面: 統計グラフ ===
  seriesFileId: 'ファイルID',
  seriesDisplayCount: '表示回数',
  axisFileIdSorted: 'ファイルID (A-Z順)',
  noStatsData: 'データがありません。スキャンを実行してください。',
  viewedFilesCountLabel: '1回でも表示済みのファイル数:',
  displayCountPerImageTitle: '画像ごとの表示回数',
  fairnessExplanation:
    '完全平等ランダムアルゴリズムが正しく動作していれば、全てのファイルが均等に表示されます',
  resettingLabel: 'リセット中...',
  resetDisplayCountsButton: '表示回数をリセット',
  confirmResetDisplayCounts: 'すべての画像の表示回数をリセットしますか？',

  // === 設定画面: 情報 ===
  appDescription: '10万枚以上の写真を公平に表示するスライドショーアプリ',
  versionLabel: 'バージョン: {version}',
  viewOnGitHub: 'GitHubで見る',
  dangerZoneTitle: '危険な操作',
  resetSettingsButton: '設定を初期化',
  resettingSettingsLabel: '初期化中...',
  confirmResetAllData:
    '全ての設定、プレイリスト、表示履歴を完全に削除して初期化しますか？\n\nこの操作は取り消せません。完了後アプリが再起動します。',
  resettingMessage: '初期化しています。完了後アプリが再起動します。',
  resetErrorPrefix: 'エラー: {detail}',
  errorDbResetFailed: 'データベースの初期化に失敗しました',

  // === 言語設定 ===
  languageLabel: '言語',
  languageAuto: '自動（OSの設定に従う）',
  languageJa: '日本語',
  languageEn: 'English',
} as const;
