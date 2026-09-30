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
  closeTooltip: '閉じる',

  // === キーボードショートカット一覧（#66） ===
  shortcutsButtonTooltip: 'ショートカット一覧 (?)',
  shortcutsTitle: 'キーボードショートカット',
  shortcutSpace: '一時停止 / 再開',
  shortcutNavigate: '前へ / 次へ',
  shortcutFullscreen: 'フルスクリーン切り替え',
  shortcutEscape: '終了（設定中は閉じる）',
  shortcutHelp: 'このヘルプを表示',
  shortcutPhotoClick: '写真上: 一時停止 / 再開',
  shortcutPhotoWheel: '写真上: 前へ / 次へ（横スワイプも可）',
  // #66視覚刷新: ようこそ画面の下部に添える「?」バッジ隣の説明文（バッジ自体は
  // JSX側の固定"?"表示。文言はバッジに続く説明部分だけを持つ）。
  shortcutsHintWelcome: 'ショートカット一覧を表示',

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
  locationMapAlt: '位置情報の地図',
  // #66 視覚刷新: ファイルサイズ・表示回数・最終表示日時は本文に常設せず、
  // ファイル名のtitleツールチップにまとめて表示する。
  displayCountTooltip: '表示回数: {count}回',
  lastDisplayedTooltip: '最終表示: {when}',
  pickCopyDone: 'コピー完了: {path}',
  pickCopyFailed: 'エラー: コピー失敗',
  excludeFailed: 'エラー: 除外失敗',
  // #78: 除外/ピック直後の控えめなトースト（数秒だけ「取り消す」を出す）
  undoButton: '取り消す',
  undoExcludeDone: '除外を取り消しました',
  undoExcludeNothing: '戻すものはありませんでした',
  undoPickDone: 'ピックを取り消しました',
  undoFailed: 'エラー: 取り消せませんでした',
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
  settingsTabsLabel: '設定タブ',
  tabScan: 'フォルダ',
  tabOptions: 'オプション',
  tabExclude: '除外ルール',
  tabPick: 'ピック',
  tabHistory: '履歴',
  tabStats: '統計グラフ',
  tabInfo: '情報',

  // === 設定画面: 入力（スキャン） ===
  directorySelectionTitle: 'フォルダ選択',
  // #66視覚刷新: 見出し＋説明＋コントロールの一貫した縦リズムのための説明文。
  directorySelectionDescription:
    '10万枚規模でも数秒で起動できるよう、前回からの変更分だけを検出します',
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
  displayIntervalDescription: '次の写真・動画に切り替わるまでの秒数（5〜60秒）',
  exifRotationLabel: 'EXIF回転情報に従って画像を自動回転',
  videoSectionTitle: '動画',
  videoAudioLabel: '動画の音声を再生する',
  videoAudioDescription: 'オフのときは無音で再生します',
  videoMaxDurationLabel: '動画の最大再生時間',
  videoMaxDurationDescription: '長い動画は、この時間で次の写真・動画へ進みます',
  videoMaxDurationUnlimited: '無制限',
  videoMaxDurationSeconds: '{count}秒',
  videoMaxDurationMinutes: '{count}分',
  pickDestinationTitle: 'ピック先フォルダ',

  // === 設定画面: 除外ルール ===
  excludeRulesTitle: '除外ルール',
  excludeRulesDescription: 'スライドショーから除外する写真・動画の条件を管理します',
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
  seriesFileCount: 'ファイル数',
  axisDisplayCount: '表示回数',
  noStatsData: 'データがありません。スキャンを実行してください。',
  statViewedLabel: '表示済み',
  statAverageLabel: '平均表示回数',
  statRangeLabel: '最少〜最多',
  fairnessEvenBadge: '均等（差は1回以内）',
  fairnessSpreadBadge: '最多と最少の差 {n}回',
  chartMeanLabel: '平均 {value}',
  chartTooltipTimes: '{count}回表示',
  chartTooltipFiles: '{files}ファイル（{percent}%）',
  chartAriaLabel: '表示回数の分布グラフ。{files}ファイル、最少{min}回、最多{max}回、平均{mean}回',
  viewAsTable: '表で見る',
  tableColumnShare: '割合',
  displayCountDistributionTitle: '画像ごとの表示回数',
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
  dangerZoneDescription: '元に戻せない操作です。実行前によく確認してください',
  resetSettingsButton: '設定を初期化',
  resettingSettingsLabel: '初期化中...',
  confirmResetAllData:
    '全ての設定、プレイリスト、表示履歴を完全に削除して初期化しますか？\n\nこの操作は取り消せません。完了後アプリが再起動します。',
  resettingMessage: '初期化しています。完了後アプリが再起動します。',
  resetErrorPrefix: 'エラー: {detail}',
  errorDbResetFailed: 'データベースの初期化に失敗しました',

  // === 言語設定 ===
  languageLabel: '言語',
  // #82レビュー2巡目nit: en側の'Auto (system)'と長さ・トーンを揃えて短縮。
  languageAuto: '自動（システム）',
  languageJa: '日本語',
  languageEn: 'English',
} as const;
