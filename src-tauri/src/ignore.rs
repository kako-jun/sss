use globset::{Glob, GlobSet, GlobSetBuilder};
use std::collections::HashMap;
use std::path::Path;

/// DB `ignore_rules.rule_type` 列の値。未知の文字列は `Glob` にフォールバックする
/// （古いDBに将来のバージョンの列値が残っていた場合の安全側）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleType {
    /// gitignore風のglobパターン（末尾 `/` はディレクトリ名照合として特別扱いする）
    Glob,
    /// 撮影日（YYYY-MM-DD）による除外
    Date,
}

impl RuleType {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuleType::Glob => "glob",
            RuleType::Date => "date",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "date" => RuleType::Date,
            _ => RuleType::Glob,
        }
    }
}

/// 除外ルール1件（DBの1行に対応）
#[derive(Debug, Clone)]
pub struct IgnoreRule {
    pub pattern: String,
    pub rule_type: RuleType,
}

impl IgnoreRule {
    pub fn glob(pattern: impl Into<String>) -> Self {
        IgnoreRule {
            pattern: pattern.into(),
            rule_type: RuleType::Glob,
        }
    }

    pub fn date(date: impl Into<String>) -> Self {
        IgnoreRule {
            pattern: date.into(),
            rule_type: RuleType::Date,
        }
    }
}

/// 末尾 `/` のディレクトリ指定パターンを「祖先ディレクトリのいずれかの名前が一致」
/// 判定用の glob に正規化する。
///
/// 例:
/// - `"**/.thumbnails/"` → `"**/.thumbnails/**"`
/// - `"@eaDir/"`         → `"**/@eaDir/**"`
/// - `"**/.**/"`         → `"**/.**/**"`（`.` で始まる任意のディレクトリ名）
///
/// 末尾が `/` でなければ `None`（ディレクトリ指定パターンではない＝通常のglob）。
pub fn normalize_dir_pattern(pattern: &str) -> Option<String> {
    let trimmed = pattern.trim();
    if trimmed.len() <= 1 || !trimmed.ends_with('/') {
        return None;
    }
    let middle = trimmed.trim_end_matches('/');
    let middle = middle.strip_prefix("**/").unwrap_or(middle);
    let middle = middle.strip_prefix('/').unwrap_or(middle);
    if middle.is_empty() {
        return None;
    }
    Some(format!("**/{middle}/**"))
}

/// glob として妥当かどうかを検証する際に使うパターン文字列を返す
/// （末尾 `/` のディレクトリ指定パターンは、実際にビルドする正規化後の形で検証する）。
pub fn glob_check_pattern(pattern: &str) -> String {
    normalize_dir_pattern(pattern).unwrap_or_else(|| pattern.to_string())
}

/// パス文字列中から `YYYY-MM-DD` または `YYYYMMDD` 形式の日付を抽出する
/// （前後が数字で連続していないこと・月日が妥当範囲であることを確認する）。
/// EXIF撮影日がDBに未取得の画像に対するフォールバック用。
pub fn extract_date_from_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let len = bytes.len();

    let digits_at = |i: usize, n: usize| -> Option<u32> {
        if i + n > len {
            return None;
        }
        let mut value: u32 = 0;
        for k in 0..n {
            let b = bytes[i + k];
            if !b.is_ascii_digit() {
                return None;
            }
            value = value * 10 + u32::from(b - b'0');
        }
        Some(value)
    };
    let is_digit_at = |i: usize| i < len && bytes[i].is_ascii_digit();
    let valid_date = |y: u32, m: u32, d: u32| {
        (1970..=2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)
    };

    for i in 0..len {
        // 直前が数字なら、より長い数値列の途中なので候補にしない
        if i > 0 && is_digit_at(i - 1) {
            continue;
        }
        let Some(y) = digits_at(i, 4) else { continue };

        // "YYYY-MM-DD"
        if bytes.get(i + 4) == Some(&b'-') {
            if let (Some(m), Some(d)) = (digits_at(i + 5, 2), digits_at(i + 8, 2)) {
                if bytes.get(i + 7) == Some(&b'-') && !is_digit_at(i + 10) && valid_date(y, m, d) {
                    return Some(format!("{y:04}-{m:02}-{d:02}"));
                }
            }
        }

        // "YYYYMMDD"
        if let (Some(m), Some(d)) = (digits_at(i + 4, 2), digits_at(i + 6, 2)) {
            if !is_digit_at(i + 8) && valid_date(y, m, d) {
                return Some(format!("{y:04}-{m:02}-{d:02}"));
            }
        }
    }
    None
}

pub struct IgnoreFilter {
    /// 通常のglobルール（末尾 `/` でないもの）。フルパス・各パスコンポーネントの
    /// 両方でマッチ判定する（後方互換: `private` のようなフォルダ名単体パターンも
    /// 階層途中で効く）。
    globset: Option<GlobSet>,
    /// 末尾 `/` のディレクトリ指定ルールを正規化した glob（スキャンルートからの
    /// 相対パスに対して判定する）。
    dir_globset: Option<GlobSet>,
    /// 撮影日除外ルール（YYYY-MM-DD文字列）
    date_rules: Vec<String>,
    /// パス文字列 → 撮影日（YYYY-MM-DD）。DBに保存済みの撮影日（表示時にEXIFから
    /// 取得・保存されたもの）。日付除外ルールの判定で最優先に使う。
    captured_dates: HashMap<String, String>,
}

impl IgnoreFilter {
    /// DBの `(pattern, rule_type)` から除外ルールを作成する（撮影日は未取得扱い）。
    pub fn from_patterns(patterns: &[String]) -> Self {
        let rules: Vec<IgnoreRule> = patterns.iter().map(IgnoreRule::glob).collect();
        Self::from_rules(&rules)
    }

    /// ルール一覧から除外ルールを作成する（撮影日は未取得扱い＝パス文字列中の日付のみで判定）。
    pub fn from_rules(rules: &[IgnoreRule]) -> Self {
        Self::from_rules_with_captured_dates(rules, HashMap::new())
    }

    /// ルール一覧 + 撮影日マップ（スキャン時、DBに保存済みの撮影日）から除外ルールを作成する。
    pub fn from_rules_with_captured_dates(
        rules: &[IgnoreRule],
        captured_dates: HashMap<String, String>,
    ) -> Self {
        let mut glob_builder = GlobSetBuilder::new();
        let mut has_glob = false;
        let mut dir_builder = GlobSetBuilder::new();
        let mut has_dir = false;
        let mut date_rules = Vec::new();

        for rule in rules {
            let pattern = rule.pattern.trim();
            if pattern.is_empty() {
                continue;
            }

            match rule.rule_type {
                RuleType::Date => {
                    date_rules.push(pattern.to_string());
                }
                RuleType::Glob => {
                    if let Some(normalized) = normalize_dir_pattern(pattern) {
                        match Glob::new(&normalized) {
                            Ok(glob) => {
                                dir_builder.add(glob);
                                has_dir = true;
                            }
                            Err(e) => {
                                eprintln!("Invalid directory pattern '{pattern}': {e}");
                            }
                        }
                    } else {
                        match Glob::new(pattern) {
                            Ok(glob) => {
                                glob_builder.add(glob);
                                has_glob = true;
                            }
                            Err(e) => {
                                eprintln!("Invalid pattern '{pattern}': {e}");
                            }
                        }
                    }
                }
            }
        }

        let globset = if has_glob {
            match glob_builder.build() {
                Ok(gs) => Some(gs),
                Err(e) => {
                    eprintln!("Failed to build globset: {e}");
                    None
                }
            }
        } else {
            None
        };

        let dir_globset = if has_dir {
            match dir_builder.build() {
                Ok(gs) => Some(gs),
                Err(e) => {
                    eprintln!("Failed to build directory globset: {e}");
                    None
                }
            }
        } else {
            None
        };

        IgnoreFilter {
            globset,
            dir_globset,
            date_rules,
            captured_dates,
        }
    }

    /// ファイルパスが除外対象かチェックする。
    ///
    /// `scan_root` はディレクトリ指定ルール（末尾 `/`）の判定に使う相対パスの基点。
    /// スキャンルート自体がドットディレクトリ配下にある場合（例: `~/.photos/` を
    /// スキャン）でも、ルートより上の成分でルール（例: 全ドットフォルダ除外）が
    /// 誤って全除外の原因にならないよう、判定は `path` を `scan_root` から見た
    /// 相対パスに変換してから行う。
    pub fn is_ignored(&self, path: &Path, scan_root: &Path) -> bool {
        // 通常glob: フルパス
        if let Some(ref globset) = self.globset {
            if globset.is_match(path) {
                return true;
            }
            // 通常glob: 各パスコンポーネント単位（フォルダ名単体パターンの後方互換）
            for component in path.components() {
                if let Some(s) = component.as_os_str().to_str() {
                    if globset.is_match(s) {
                        return true;
                    }
                }
            }
        }

        // ディレクトリ指定ルール: スキャンルートからの相対パスで判定
        if let Some(ref dir_globset) = self.dir_globset {
            let relative = path.strip_prefix(scan_root).unwrap_or(path);
            if dir_globset.is_match(relative) {
                return true;
            }
        }

        // 撮影日除外: DBに保存済みの撮影日を最優先。未取得ならパス文字列中の日付で代替。
        if !self.date_rules.is_empty() {
            let path_str = path.to_string_lossy();
            let date = self
                .captured_dates
                .get(path_str.as_ref())
                .cloned()
                .or_else(|| extract_date_from_path(&path_str));
            if let Some(date) = date {
                if self.date_rules.contains(&date) {
                    return true;
                }
            }
        }

        false
    }

    /// スキャンルートの文脈が無い呼び出し元向け（例: 複数スキャン履歴をまたぐ
    /// 「最近表示した画像」一覧）。`path` をそのまま「相対パス」として扱う
    /// （空文字列を prefix にした strip_prefix は常に成功し `path` をそのまま返すため、
    /// 実質的に旧来のフルパス判定と同じ挙動になる）。
    pub fn is_ignored_anywhere(&self, path: &Path) -> bool {
        self.is_ignored(path, Path::new(""))
    }

    /// パターンが設定されているかチェック（テスト用）
    #[cfg(test)]
    pub fn has_patterns(&self) -> bool {
        self.globset.is_some() || self.dir_globset.is_some() || !self.date_rules.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ignore_filter_basic() {
        let patterns = vec![
            "*.tmp".to_string(),
            "**/private/**".to_string(),
            "**/2023-05-15/**".to_string(),
            "screenshot_*.png".to_string(),
        ];

        let filter = IgnoreFilter::from_patterns(&patterns);
        assert!(filter.has_patterns());

        let root = Path::new("/photos");

        // .tmpファイルは除外
        assert!(filter.is_ignored(Path::new("/photos/test.tmp"), root));

        // privateフォルダは除外
        assert!(filter.is_ignored(Path::new("/photos/private/image.jpg"), root));

        // 特定の日付フォルダは除外
        assert!(filter.is_ignored(Path::new("/photos/2023-05-15/image.jpg"), root));

        // スクリーンショットは除外
        assert!(filter.is_ignored(Path::new("/photos/screenshot_001.png"), root));

        // 通常のファイルは含める
        assert!(!filter.is_ignored(Path::new("/photos/image.jpg"), root));
    }

    #[test]
    fn test_empty_ignore_filter() {
        let patterns: Vec<String> = vec![];

        let filter = IgnoreFilter::from_patterns(&patterns);
        assert!(!filter.has_patterns());
        assert!(!filter.is_ignored_anywhere(Path::new("/photos/image.jpg")));
    }

    /// #61 問題1: 末尾 `/` の既定ルールが実際にディレクトリ配下のファイルを除外すること。
    /// `@eaDir`（Synologyサムネ）・`.thumbnails`・任意のドットフォルダ（`**/.**/`）。
    #[test]
    fn trailing_slash_default_rules_exclude_nested_files() {
        let rules = vec![
            IgnoreRule::glob("**/.thumbnails/"),
            IgnoreRule::glob("**/@eaDir/"),
            IgnoreRule::glob("**/.**/"),
        ];
        let filter = IgnoreFilter::from_rules(&rules);
        let root = Path::new("/photos");

        assert!(filter.is_ignored(Path::new("/photos/@eaDir/thumb.jpg"), root));
        assert!(filter.is_ignored(Path::new("/photos/sub/@eaDir/nested/thumb.jpg"), root));
        assert!(filter.is_ignored(Path::new("/photos/.thumbnails/x.jpg"), root));
        // ドットフォルダ包括ルール（.thumbnails 以外の任意のドットフォルダ）
        assert!(filter.is_ignored(Path::new("/photos/.git/config.jpg"), root));
        assert!(filter.is_ignored(Path::new("/photos/.hidden/deep/a.jpg"), root));

        // 通常のファイル・フォルダは除外されない
        assert!(!filter.is_ignored(Path::new("/photos/normal/a.jpg"), root));
        // ファイル名自体が候補文字列と一致するだけ（祖先ディレクトリではない）は対象外
        assert!(!filter.is_ignored(Path::new("/photos/eaDir_report.jpg"), root));
    }

    /// #61 問題1補足: スキャンルート自体がドットディレクトリ配下にあっても、
    /// ルートより上の成分のせいで全除外にならないこと（相対パスで判定するため）。
    #[test]
    fn dot_dir_rule_does_not_exclude_everything_when_scan_root_itself_is_dotted() {
        let rules = vec![IgnoreRule::glob("**/.**/")];
        let filter = IgnoreFilter::from_rules(&rules);
        let root = Path::new("/Users/x/.photos");

        // ルート自身がドットフォルダでも、ルート配下の通常ファイルは除外されない
        assert!(!filter.is_ignored(Path::new("/Users/x/.photos/a.jpg"), root));
        // ルート配下にさらにドットフォルダがあれば、それは除外される
        assert!(filter.is_ignored(Path::new("/Users/x/.photos/.trash/a.jpg"), root));
    }

    /// #61 問題4: globのメタ文字を含むファイル名は `IgnoreRule::glob` + `globset::escape`
    /// で登録すれば自分自身にちゃんとマッチする（file_operations 側でescapeして渡す想定）。
    #[test]
    fn escaped_metachar_pattern_matches_itself() {
        let literal_path = "/photos/dir [2020]/photo[1].jpg";
        let escaped = globset::escape(literal_path);
        let rules = vec![IgnoreRule::glob(escaped)];
        let filter = IgnoreFilter::from_rules(&rules);
        let root = Path::new("/photos");

        assert!(filter.is_ignored(Path::new(literal_path), root));
        assert!(!filter.is_ignored(Path::new("/photos/dir [2020]/other.jpg"), root));
    }

    /// #61 問題2/3: 撮影日除外は「DBに保存済みの撮影日」を最優先で使う。
    #[test]
    fn date_rule_matches_captured_date_regardless_of_filename() {
        let rules = vec![IgnoreRule::date("2023-05-15")];
        let mut captured = HashMap::new();
        captured.insert("/photos/IMG_0001.jpg".to_string(), "2023-05-15".to_string());
        let filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured);
        let root = Path::new("/photos");

        // ファイル名に日付が全く含まれていなくても、DBの撮影日で除外される
        assert!(filter.is_ignored(Path::new("/photos/IMG_0001.jpg"), root));
        // 別の日付の画像は除外されない
        assert!(!filter.is_ignored(Path::new("/photos/IMG_0002.jpg"), root));
    }

    /// #61 撮影日フォールバック: DBに撮影日が未取得の画像は、パス文字列中の
    /// 日付表記（YYYY-MM-DD / YYYYMMDD）でも代替マッチする。
    #[test]
    fn date_rule_falls_back_to_date_in_path_when_not_captured_yet() {
        let rules = vec![IgnoreRule::date("2023-05-15")];
        let filter = IgnoreFilter::from_rules(&rules);
        let root = Path::new("/photos");

        assert!(filter.is_ignored(Path::new("/photos/2023-05-15/a.jpg"), root));
        assert!(filter.is_ignored(Path::new("/photos/IMG_20230515_120000.jpg"), root));
        assert!(!filter.is_ignored(Path::new("/photos/IMG_20230516_120000.jpg"), root));
        // 日付が全く読み取れない・無関係なファイルは除外されない
        assert!(!filter.is_ignored(Path::new("/photos/IMG_0001.jpg"), root));
    }

    #[test]
    fn extract_date_from_path_handles_both_formats_and_rejects_noise() {
        assert_eq!(
            extract_date_from_path("/a/2023-05-15/b.jpg"),
            Some("2023-05-15".to_string())
        );
        assert_eq!(
            extract_date_from_path("/a/IMG_20230515_120000.jpg"),
            Some("2023-05-15".to_string())
        );
        // 妥当な日付でない数値列は誤検出しない
        assert_eq!(extract_date_from_path("/a/99999999.jpg"), None);
        assert_eq!(extract_date_from_path("/a/IMG_0001.jpg"), None);
        // より長い数字列の内部一致は無視する（前後が数字で連続）
        assert_eq!(extract_date_from_path("/a/1202305150001.jpg"), None);
    }

    #[test]
    fn normalize_dir_pattern_extracts_name_regardless_of_prefix() {
        assert_eq!(
            normalize_dir_pattern("**/.thumbnails/"),
            Some("**/.thumbnails/**".to_string())
        );
        assert_eq!(
            normalize_dir_pattern("@eaDir/"),
            Some("**/@eaDir/**".to_string())
        );
        assert_eq!(
            normalize_dir_pattern("**/.**/"),
            Some("**/.**/**".to_string())
        );
        // 末尾 / が無ければ通常glob扱い（None）
        assert_eq!(normalize_dir_pattern("**/Thumbs.db"), None);
        assert_eq!(normalize_dir_pattern("*.tmp"), None);
    }
}
