// 画像情報
export interface ImageInfo {
  path: string;
  optimizedPath: string | null; // 4K最適化された画像のパス
  isVideo: boolean; // 動画ファイルかどうか
  width: number;
  height: number;
  fileSize: number;
  exif: ExifInfo | null;
  displayCount: number;
  lastDisplayed: string | null;
}

// EXIF情報
export interface ExifInfo {
  dateTime: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  width: number | null;
  height: number | null;
}

// スキャン進捗
export interface ScanProgress {
  totalFiles: number;
  newFiles: number;
  deletedFiles: number;
  durationMs: number;
  // 走査中に発生したエラーの件数（WalkDir読み取りエラー＋ファイル単位のメタデータ/mtime
  // 取得エラー。1970年より前のmtimeを含む）。#63
  errorCount: number;
  // エラーの代表例（最大5件、"{path}: {message}"形式）。#63
  errorExamples: string[];
}

// 表示回数ヒストグラムの1階級（`count` 回表示されたファイルが `files` 件、#67）
export interface DisplayCountBin {
  count: number;
  files: number;
}

// 表示回数の分布（統計グラフ用、#67）。バックエンドの `DisplayStats` と対応。
// 全ファイルの (パス, 回数) 一覧ではなく、集計済みの要約とヒストグラムだけを受け取る。
export interface DisplayStats {
  // 集計対象のファイル数（プレイリストのメンバー数）
  files: number;
  min: number;
  max: number;
  mean: number;
  // 表示回数の昇順。ファイルが1件も無い階級は含まれない（疎な表現）
  bins: DisplayCountBin[];
}

// 最近表示した画像
export interface RecentImage {
  path: string;
  displayCount: number;
  lastDisplayed: string;
}

// 設定画面サムネイルの取得結果（#67）。静止画は縮小済み JPEG のパス、動画はサムネイル無し。
export type ThumbnailResult = { kind: 'image'; path: string } | { kind: 'video' };

// 除外ルール1件（"glob": 通常のglobパターン・末尾 `/` はディレクトリ名照合。
// "date": 撮影日（YYYY-MM-DD）による除外）
export interface IgnoreRule {
  pattern: string;
  ruleType: 'glob' | 'date';
}

// `exclude_image` の結果（#80: バックエンドの `ExcludeOutcome` と対応。表示文言は
// フロント辞書側で組み立てる）。
export interface ExcludeOutcome {
  pattern: string;
  needsRescan: boolean;
}

/**
 * `get_next_image` / `get_previous_image` の結果（#65）。
 *
 * バックエンドの `ImageNavigationResult`（`#[serde(tag = "kind", content = "data",
 * rename_all = "camelCase")]`）とJSON形状を一致させたタグ付きユニオン。
 * 旧実装は成功以外を全て `null` に潰し、フロントは文字列 `'No more images'` で
 * 分岐していたが、これにより「本当に未設定」「読込失敗」「フォルダ接続不可」
 * 「空プレイリスト」「履歴の先頭（前へで境界）」を型で区別できる。
 */
export type ImageNavigationResult =
  | { kind: 'found'; data: ImageInfo }
  | { kind: 'emptyPlaylist' }
  | { kind: 'loadFailed' }
  | { kind: 'rootUnavailable' }
  | { kind: 'noHistory' };
