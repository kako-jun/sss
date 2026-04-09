use crate::ignore::IgnoreFilter;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

/// 画像ファイルの拡張子
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

/// 動画ファイルの拡張子（HTMLのvideoタグでネイティブ再生可能な形式のみ）
/// avi/mkv/flv/wmv等の旧フォーマットはffmpeg同梱後に対応予定
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "ogv", "m4v"];

/// ファイルメタデータ
#[derive(Debug, Clone)]
pub struct FileMetadata {
    pub path: String,
    pub modified_time: i64,
    pub file_size: i64,
}

/// スキャン結果
#[derive(Debug)]
pub struct ScanResult {
    pub files: Vec<FileMetadata>,
    pub new_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub total_count: usize,
    pub new_count: usize,
    pub deleted_count: usize,
    pub duration_ms: u128,
}

/// 画像スキャナー
pub struct ImageScanner {
    ignore_filter: IgnoreFilter,
}

impl ImageScanner {
    /// スキャナーを作成
    pub fn new(ignore_filter: IgnoreFilter) -> Self {
        ImageScanner { ignore_filter }
    }

    /// ディレクトリをスキャン（進捗コールバック付き）
    pub fn scan_directory_with_progress<F>(
        &self,
        directory: &Path,
        mut progress_callback: F,
    ) -> Result<Vec<FileMetadata>, String>
    where
        F: FnMut(usize, usize) + Send + Sync,
    {
        let start_time = std::time::Instant::now();

        // ディレクトリが存在するかチェック
        if !directory.exists() {
            return Err(format!("Directory does not exist: {:?}", directory));
        }

        if !directory.is_dir() {
            return Err(format!("Path is not a directory: {:?}", directory));
        }

        // WalkDirでファイルエントリを収集
        let entries: Vec<_> = WalkDir::new(directory)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| self.is_media_file(e.path()))
            .filter(|e| !self.ignore_filter.is_ignored(e.path()))
            .collect();

        let total = entries.len();

        // 初回の進捗報告
        progress_callback(0, total);

        // 並列でメタデータを取得（進捗報告付き）
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let processed = Arc::new(AtomicUsize::new(0));
        let callback = Arc::new(std::sync::Mutex::new(progress_callback));

        let files: Vec<FileMetadata> = entries
            .par_iter()
            .filter_map(|entry| {
                let path = entry.path();
                let metadata = fs::metadata(path).ok()?;

                let modified_time = metadata
                    .modified()
                    .ok()?
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .ok()?
                    .as_secs() as i64;

                // 100ファイルごとに進捗を報告
                let count = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if count % 100 == 0 || count == total {
                    if let Ok(mut cb) = callback.lock() {
                        cb(count, total);
                    }
                }

                Some(FileMetadata {
                    path: path.to_string_lossy().to_string(),
                    modified_time,
                    file_size: metadata.len() as i64,
                })
            })
            .collect();

        Ok(files)
    }

    /// ディレクトリをスキャン（差分検出あり、進捗コールバック付き）
    pub fn scan_directory_incremental_with_progress<F>(
        &self,
        directory: &Path,
        previous_files: Vec<(String, i64, i64)>,
        progress_callback: F,
    ) -> Result<ScanResult, String>
    where
        F: FnMut(usize, usize) + Send + Sync,
    {
        let start_time = std::time::Instant::now();

        // 前回のファイルをHashMapに変換
        let mut previous_map: HashMap<String, (i64, i64)> = previous_files
            .into_iter()
            .map(|(path, mtime, size)| (path, (mtime, size)))
            .collect();

        // 現在のファイルをスキャン（進捗コールバック付き）
        let current_files = self.scan_directory_with_progress(directory, progress_callback)?;

        let mut new_files = Vec::new();
        let mut unchanged_count = 0;

        // 新規ファイルと変更されたファイルを検出
        for file in &current_files {
            match previous_map.remove(&file.path) {
                None => {
                    // 新規ファイル
                    new_files.push(file.path.clone());
                }
                Some((prev_mtime, _prev_size)) => {
                    if prev_mtime != file.modified_time {
                        // 変更されたファイル（新規として扱う）
                        new_files.push(file.path.clone());
                    } else {
                        // 変更なし
                        unchanged_count += 1;
                    }
                }
            }
        }

        // 削除されたファイルを検出（previous_mapに残っているもの）
        let deleted_files: Vec<String> = previous_map.keys().cloned().collect();

        let duration_ms = start_time.elapsed().as_millis();

        Ok(ScanResult {
            total_count: current_files.len(),
            new_count: new_files.len(),
            deleted_count: deleted_files.len(),
            files: current_files,
            new_files,
            deleted_files,
            duration_ms,
        })
    }

    /// 画像ファイルかチェック
    fn is_image_file(&self, path: &Path) -> bool {
        if let Some(ext) = path.extension() {
            if let Some(ext_str) = ext.to_str() {
                return IMAGE_EXTENSIONS.contains(&ext_str.to_lowercase().as_str());
            }
        }
        false
    }

    /// 動画ファイルかチェック
    fn is_video_file(&self, path: &Path) -> bool {
        if let Some(ext) = path.extension() {
            if let Some(ext_str) = ext.to_str() {
                return VIDEO_EXTENSIONS.contains(&ext_str.to_lowercase().as_str());
            }
        }
        false
    }

    /// メディアファイル（画像または動画）かチェック
    fn is_media_file(&self, path: &Path) -> bool {
        self.is_image_file(path) || self.is_video_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_image_file() {
        let scanner = ImageScanner::new(IgnoreFilter::from_patterns(&[]));

        assert!(scanner.is_image_file(Path::new("test.jpg")));
        assert!(scanner.is_image_file(Path::new("test.JPG")));
        assert!(scanner.is_image_file(Path::new("test.png")));
        assert!(scanner.is_image_file(Path::new("test.webp")));
        assert!(!scanner.is_image_file(Path::new("test.txt")));
        assert!(!scanner.is_image_file(Path::new("test")));
    }

    #[test]
    fn test_is_video_file() {
        let scanner = ImageScanner::new(IgnoreFilter::from_patterns(&[]));

        assert!(scanner.is_video_file(Path::new("test.mp4")));
        assert!(scanner.is_video_file(Path::new("test.MP4")));
        assert!(scanner.is_video_file(Path::new("test.webm")));
        assert!(scanner.is_video_file(Path::new("test.ogv")));
        assert!(scanner.is_video_file(Path::new("test.m4v")));
        // ogg は音声ファイルと曖昧なため対象外
        assert!(!scanner.is_video_file(Path::new("test.ogg")));
        assert!(!scanner.is_video_file(Path::new("test.avi")));
        assert!(!scanner.is_video_file(Path::new("test.mkv")));
        assert!(!scanner.is_video_file(Path::new("test.jpg")));
        assert!(!scanner.is_video_file(Path::new("test.txt")));
    }

    #[test]
    fn test_is_media_file() {
        let scanner = ImageScanner::new(IgnoreFilter::from_patterns(&[]));

        // 画像もメディア
        assert!(scanner.is_media_file(Path::new("test.jpg")));
        assert!(scanner.is_media_file(Path::new("test.png")));
        // 動画もメディア
        assert!(scanner.is_media_file(Path::new("test.mp4")));
        assert!(scanner.is_media_file(Path::new("test.webm")));
        // それ以外は非メディア
        assert!(!scanner.is_media_file(Path::new("test.txt")));
    }
}
