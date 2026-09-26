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
    /// 前回は追跡していたが今回のスキャン範囲外（ディレクトリ系除外で枝刈りされた
    /// 配下）だったため、存在するかどうか不明なパス。「削除」とは区別し、
    /// `file_metadata`/`image_stats` を消す対象にしない（#61レビュー S-a）。
    pub unknown_files: Vec<String>,
    pub total_count: usize,
    pub new_count: usize,
    pub deleted_count: usize,
    pub unknown_count: usize,
    pub duration_ms: u128,
}

/// 画像スキャナー。
///
/// #61 レビュー M2/S1: 撮影日ルールは一切適用しない（EXIFが必要でファイル単位でしか
/// 判定できないため、生スキャン後の別段階で行う）。ただし #61 レビュー S-a により、
/// ディレクトリ指定の除外ルール（末尾 `/` 等）は `WalkDir::filter_entry` で枝ごと
/// 刈り、配下のファイルは `file_metadata` 登録・EXIF読み対象から外す（`@eaDir`・
/// ドットフォルダ配下が10万件規模で全部stat/EXIF読みされることを防ぐ）。刈られた
/// 配下のうち前回追跡していたファイルは「削除」ではなく「不明」として扱う
/// （`unknown_files`）。ファイル単位のglob/日付ルールの適用は、この結果を受け取った
/// 呼び出し元（`commands/scan.rs`）が「プレイリストに含めるかどうか」を決める
/// 別の段階として行う。これにより、既存のファイルに新しい除外ルールが付いても
/// 「削除」とは区別され、`image_stats`/`file_metadata` の履歴が消えない。
pub struct ImageScanner;

impl Default for ImageScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageScanner {
    /// スキャナーを作成
    pub fn new() -> Self {
        ImageScanner
    }

    /// ディレクトリをスキャン（進捗コールバック付き）。
    ///
    /// `walk_filter` はディレクトリ系除外ルール（末尾 `/` 等、`should_prune_dir`）の
    /// 判定にのみ使う。日付ルールは無視される（`should_prune_dir` 自体が日付ルールを
    /// 見ない）。ファイル単位のglob/日付ルールはここでは適用しない
    /// （呼び出し元が別段階で行う。#61レビュー S-a）。
    pub fn scan_directory_with_progress<F>(
        &self,
        directory: &Path,
        walk_filter: &IgnoreFilter,
        mut progress_callback: F,
    ) -> Result<Vec<FileMetadata>, String>
    where
        F: FnMut(usize, usize) + Send + Sync,
    {
        // ディレクトリが存在するかチェック
        if !directory.exists() {
            return Err(format!("Directory does not exist: {directory:?}"));
        }

        if !directory.is_dir() {
            return Err(format!("Path is not a directory: {directory:?}"));
        }

        // WalkDirでファイルエントリを収集。filter_entry でディレクトリ系除外に
        // 一致する枝を刈り、配下へ一切降りない（#61レビュー S-a）。
        // depth==0（スキャンルート自身）は絶対に刈らない（ルート名がたまたま
        // 除外パターンに一致しても、スキャン全体が空になる事故を防ぐ）。
        let entries: Vec<_> = WalkDir::new(directory)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                if e.file_type().is_dir() {
                    !walk_filter.should_prune_dir(e.path(), directory)
                } else {
                    true
                }
            })
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| self.is_media_file(e.path()))
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
                if count.is_multiple_of(100) || count == total {
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

    /// ディレクトリをスキャン（差分検出あり、進捗コールバック付き）。
    ///
    /// 前回追跡していたが今回のスキャン結果に無いパスは、`walk_filter`
    /// （日付ルールを除く）で除外判定し、一致すれば「不明」（ディレクトリ系除外で
    /// 枝刈りされ存在確認できていない）として `deleted_files` から除外する
    /// （#61レビュー S-a: 除外は削除ではないという原則を、枝刈りされて生スキャンにすら
    /// 現れないケースにも一貫して適用する）。
    pub fn scan_directory_incremental_with_progress<F>(
        &self,
        directory: &Path,
        previous_files: Vec<(String, i64, i64)>,
        walk_filter: &IgnoreFilter,
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
        let current_files =
            self.scan_directory_with_progress(directory, walk_filter, progress_callback)?;

        let mut new_files = Vec::new();

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
                    }
                }
            }
        }

        // previous_map に残っているもの（今回の生スキャンで見つからなかったパス）を
        // 「確定削除」と「不明（ディレクトリ系除外で枝刈りされ未確認）」に分ける。
        let mut deleted_files = Vec::new();
        let mut unknown_files = Vec::new();
        for path in previous_map.keys() {
            if walk_filter.is_ignored(Path::new(path), directory) {
                unknown_files.push(path.clone());
            } else {
                deleted_files.push(path.clone());
            }
        }

        let duration_ms = start_time.elapsed().as_millis();

        Ok(ScanResult {
            total_count: current_files.len(),
            new_count: new_files.len(),
            deleted_count: deleted_files.len(),
            unknown_count: unknown_files.len(),
            files: current_files,
            new_files,
            deleted_files,
            unknown_files,
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
        let scanner = ImageScanner::new();

        assert!(scanner.is_image_file(Path::new("test.jpg")));
        assert!(scanner.is_image_file(Path::new("test.JPG")));
        assert!(scanner.is_image_file(Path::new("test.png")));
        assert!(scanner.is_image_file(Path::new("test.webp")));
        assert!(!scanner.is_image_file(Path::new("test.txt")));
        assert!(!scanner.is_image_file(Path::new("test")));
    }

    #[test]
    fn test_is_video_file() {
        let scanner = ImageScanner::new();

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
        let scanner = ImageScanner::new();

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
