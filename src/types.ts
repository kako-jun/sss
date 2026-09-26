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
  // apply_exif_rotation設定のスナップショット。回転はフロントのimage-orientation CSSで
  // 行うため、img要素はこれに応じてfrom-image/noneを切り替える必要がある（#60）。
  applyRotation: boolean;
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
}

// 統計情報
export interface Stats {
  totalImages: number;
  displayedImages: number;
}

// 最近表示した画像
export interface RecentImage {
  path: string;
  displayCount: number;
  lastDisplayed: string;
}
