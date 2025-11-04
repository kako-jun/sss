// 画像情報
export interface ImageInfo {
  path: string;
  optimizedPath: string | null;  // 4K最適化された画像のパス
  imageData: string;  // base64エンコードされた画像データ
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
  cameraMake: string | null;
  cameraModel: string | null;
  width: number | null;
  height: number | null;
  focalLength: string | null;
  fNumber: string | null;
  iso: string | null;
  exposureTime: string | null;
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

// プレイリスト情報
export interface PlaylistInfo {
  currentPosition: number;
  totalCount: number;
}
