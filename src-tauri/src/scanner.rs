use crate::ignore::IgnoreFilter;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

/// 画像ファイルの拡張子
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

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
    pub fn new(sssignore_path: &Path) -> Self {
        let ignore_filter = IgnoreFilter::from_file(sssignore_path);
        ImageScanner { ignore_filter }
    }

    /// フォルダをスキャン（差分検出なし）
    pub fn scan_folder(&self, folder: &Path) -> Result<Vec<FileMetadata>, String> {
        let start_time = std::time::Instant::now();

        // ディレクトリが存在するかチェック
        if !folder.exists() {
            return Err(format!("Folder does not exist: {:?}", folder));
        }

        if !folder.is_dir() {
            return Err(format!("Path is not a directory: {:?}", folder));
        }

        // WalkDirでファイルエントリを収集
        let entries: Vec<_> = WalkDir::new(folder)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| self.is_image_file(e.path()))
            .filter(|e| !self.ignore_filter.is_ignored(e.path()))
            .collect();

        println!("Found {} image files in {:?}", entries.len(), start_time.elapsed());

        // 並列でメタデータを取得
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

                Some(FileMetadata {
                    path: path.to_string_lossy().to_string(),
                    modified_time,
                    file_size: metadata.len() as i64,
                })
            })
            .collect();

        println!("Processed metadata in {:?}", start_time.elapsed());

        Ok(files)
    }

    /// フォルダをスキャン（差分検出あり）
    pub fn scan_folder_incremental(
        &self,
        folder: &Path,
        previous_files: Vec<(String, i64, i64)>,
    ) -> Result<ScanResult, String> {
        let start_time = std::time::Instant::now();

        // 前回のファイルをHashMapに変換
        let mut previous_map: HashMap<String, (i64, i64)> = previous_files
            .into_iter()
            .map(|(path, mtime, size)| (path, (mtime, size)))
            .collect();

        // 現在のファイルをスキャン
        let current_files = self.scan_folder(folder)?;

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

        println!(
            "Scan completed: {} total, {} new, {} deleted, {} unchanged in {}ms",
            current_files.len(),
            new_files.len(),
            deleted_files.len(),
            unchanged_count,
            duration_ms
        );

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_image_file() {
        let scanner = ImageScanner::new(Path::new(""));

        assert!(scanner.is_image_file(Path::new("test.jpg")));
        assert!(scanner.is_image_file(Path::new("test.JPG")));
        assert!(scanner.is_image_file(Path::new("test.png")));
        assert!(scanner.is_image_file(Path::new("test.webp")));
        assert!(!scanner.is_image_file(Path::new("test.txt")));
        assert!(!scanner.is_image_file(Path::new("test")));
    }
}
