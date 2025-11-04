use globset::{Glob, GlobSet, GlobSetBuilder};
use std::fs;
use std::path::Path;

pub struct IgnoreFilter {
    globset: Option<GlobSet>,
}

impl IgnoreFilter {
    /// .sssignoreファイルから除外ルールを読み込む
    pub fn from_file(ignore_file_path: &Path) -> Self {
        if !ignore_file_path.exists() {
            return IgnoreFilter { globset: None };
        }

        match fs::read_to_string(ignore_file_path) {
            Ok(content) => Self::from_content(&content),
            Err(e) => {
                eprintln!("Failed to read .sssignore: {}", e);
                IgnoreFilter { globset: None }
            }
        }
    }

    /// .sssignoreの内容から除外ルールを作成
    pub fn from_content(content: &str) -> Self {
        let mut builder = GlobSetBuilder::new();
        let mut has_patterns = false;

        for line in content.lines() {
            let line = line.trim();

            // コメントと空行をスキップ
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            // パターンを追加
            match Glob::new(line) {
                Ok(glob) => {
                    builder.add(glob);
                    has_patterns = true;
                }
                Err(e) => {
                    eprintln!("Invalid pattern '{}': {}", line, e);
                }
            }
        }

        if !has_patterns {
            return IgnoreFilter { globset: None };
        }

        match builder.build() {
            Ok(globset) => IgnoreFilter {
                globset: Some(globset),
            },
            Err(e) => {
                eprintln!("Failed to build globset: {}", e);
                IgnoreFilter { globset: None }
            }
        }
    }

    /// ファイルパスが除外対象かチェック
    pub fn is_ignored(&self, path: &Path) -> bool {
        if let Some(ref globset) = self.globset {
            // フルパスでチェック
            if globset.is_match(path) {
                return true;
            }

            // 各コンポーネントでチェック（フォルダ名のマッチング用）
            for component in path.components() {
                if let Some(s) = component.as_os_str().to_str() {
                    if globset.is_match(s) {
                        return true;
                    }
                }
            }

            false
        } else {
            false
        }
    }

    /// パターンが設定されているかチェック
    #[allow(dead_code)]
    pub fn has_patterns(&self) -> bool {
        self.globset.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ignore_filter_basic() {
        let content = r#"
# コメント
*.tmp

# 特定のフォルダ
**/private/**
**/2023-05-15/**

# パターンマッチ
screenshot_*.png
"#;

        let filter = IgnoreFilter::from_content(content);
        assert!(filter.has_patterns());

        // .tmpファイルは除外
        assert!(filter.is_ignored(Path::new("/photos/test.tmp")));

        // privateフォルダは除外
        assert!(filter.is_ignored(Path::new("/photos/private/image.jpg")));

        // 特定の日付フォルダは除外
        assert!(filter.is_ignored(Path::new("/photos/2023-05-15/image.jpg")));

        // スクリーンショットは除外
        assert!(filter.is_ignored(Path::new("/photos/screenshot_001.png")));

        // 通常のファイルは含める
        assert!(!filter.is_ignored(Path::new("/photos/image.jpg")));
    }

    #[test]
    fn test_empty_ignore_filter() {
        let content = r#"
# コメントのみ

"#;

        let filter = IgnoreFilter::from_content(content);
        assert!(!filter.has_patterns());
        assert!(!filter.is_ignored(Path::new("/photos/image.jpg")));
    }
}
