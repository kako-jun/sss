use crate::ignore::IgnoreFilter;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

/// 代表例として結果/UIに残すエラーの最大件数（#63）。
/// 10万件規模で大量のエラーが出ても、結果を肥大化させず「件数＋代表例」に留める。
const MAX_ERROR_EXAMPLES: usize = 5;

/// 画像ファイルの拡張子（対応形式の正本。ピック一覧・サムネイル生成もこれを参照する、#67）
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

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

/// `ScanError` の発生源（#63 PR#77レビュー S3）。不明判定（前回追跡していたパスが
/// 今回エラーの影響下にあるか）を、ファイル単位は完全一致・ディレクトリ単位は祖先
/// 一致で判定を分けるために使う。ディレクトリ単位のエラー1件に対して配下が
/// 何万件あっても、判定コストは「1エラーあたりO(1)集合構築＋1候補パスあたり
/// O(パスの深さ)の祖先探索」に収まる（以前は候補パス×エラー件数の
/// `starts_with`総当たりでO(P×E)だった）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanErrorScope {
    /// ファイル単位の `fs::metadata`/`mtime` 取得エラー。`path` はそのファイル自身。
    File,
    /// `WalkDir` がディレクトリ自体を読めなかった（権限拒否等）。配下は生スキャン
    /// 結果に一切現れないため、`path` を祖先に持つ全パスが影響を受ける。
    Directory,
}

/// 走査中に発生した1件のエラー（`WalkDir` の読み取りエラー、または個々のファイルの
/// `fs::metadata`/`mtime` 取得エラー）。`path` はエラーの起きたファイル/ディレクトリ
/// （`WalkDir` のエラーで取得できない場合はスキャンルート自身）。#63。
#[derive(Debug, Clone)]
pub struct ScanError {
    pub path: PathBuf,
    pub message: String,
    pub scope: ScanErrorScope,
}

/// スキャン結果
#[derive(Debug)]
pub struct ScanResult {
    pub files: Vec<FileMetadata>,
    /// 前回は存在しなかった（パス自体が初めて見つかった）ファイル。
    pub new_files: Vec<String>,
    /// 前回から存在するが `mtime` が変わったファイル（#62: `new_files` とは区別する。
    /// 同じパスのまま内容だけ変わったファイルはプレイリスト上は既存メンバーの
    /// ままでよく、`perform_scan` の集合差分でも「新規」扱いされない。ここでの区別は
    /// 主に統計・テストの正確性のため）。
    pub modified_files: Vec<String>,
    pub deleted_files: Vec<String>,
    /// 前回は追跡していたが今回のスキャン範囲外（ディレクトリ系除外で枝刈りされた
    /// 配下、または今回のエラーで存在確認できなかった配下）だったため、存在するかどうか
    /// 不明なパス。「削除」とは区別し、`file_metadata`/`image_stats` を消す対象にしない
    /// （#61レビュー S-a、#63でエラーサブツリーにも適用範囲を拡張）。
    pub unknown_files: Vec<String>,
    /// `unknown_files` のうち、今回のスキャンエラー（`ScanError`）が原因のもの
    /// （ディレクトリ系除外の枝刈りによるものは含まない）だけを集めた部分集合
    /// （#63 PR#77レビュー M2）。ディレクトリ系除外による不明は「意図して対象外に
    /// した」ものなのでプレイリストから外れてよいが、エラー由来の不明は一時的な
    /// 読み取り失敗の可能性が高く、除外ルールとは無関係にプレイリストの所属
    /// （シャッフル位置・履歴）を維持すべきという区別を、呼び出し元
    /// （`commands::scan::perform_scan` Stage4）がプレイリスト反映時に使う。
    pub error_unknown_files: Vec<String>,
    pub total_count: usize,
    pub new_count: usize,
    pub modified_count: usize,
    pub deleted_count: usize,
    pub unknown_count: usize,
    pub duration_ms: u128,
    /// 走査中に発生したエラーの総数（`WalkDir` の読み取りエラー＋個々のファイルの
    /// メタデータ/mtime取得エラー。1970年より前のmtimeでの `duration_since` 失敗を含む）。#63。
    pub error_count: usize,
    /// エラーの代表例（最大 `MAX_ERROR_EXAMPLES` 件、`"{path}: {message}"` 形式）。#63。
    pub error_examples: Vec<String>,
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
    ///
    /// #63: `WalkDir` の読み取りエラー（権限拒否等）と、個々のファイルの
    /// `fs::metadata`/`mtime` 取得エラー（1970年より前のmtimeで `duration_since` が
    /// 失敗するケースを含む）は、以前は黙って結果から除外されていた（=そのファイルが
    /// 「消えた」ように見えてしまい、差分スキャンで誤って削除扱いになりかねなかった）。
    /// これらは `errors` として集めて呼び出し元に返し、進捗コールバックも成功/失敗に
    /// 関わらず必ず処理件数を進める（以前はエラー発生時に早期returnしてしまい、進捗が
    /// `total` まで届かず最終進捗イベントが発火しないことがあった）。
    pub fn scan_directory_with_progress<F>(
        &self,
        directory: &Path,
        walk_filter: &IgnoreFilter,
        mut progress_callback: F,
    ) -> Result<(Vec<FileMetadata>, Vec<ScanError>), String>
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
        //
        // #63: 読み取りエラー（`Err`）は `filter_map(|e| e.ok())` で黙って捨てず、
        // `walk_errors` として集める。エラーの起きたパスは「不明」（不明サブツリー）
        // として扱われ、`deleted_files` には混ざらない。
        let mut entries = Vec::new();
        let mut walk_errors: Vec<ScanError> = Vec::new();
        for entry_result in WalkDir::new(directory)
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
        {
            match entry_result {
                Ok(entry) => {
                    if entry.file_type().is_file() && self.is_media_file(entry.path()) {
                        entries.push(entry);
                    }
                }
                Err(err) => {
                    let path = err
                        .path()
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| directory.to_path_buf());
                    walk_errors.push(ScanError {
                        path: path.clone(),
                        message: err.to_string(),
                        scope: ScanErrorScope::Directory,
                    });
                }
            }
        }

        let total = entries.len();

        // 初回の進捗報告
        progress_callback(0, total);

        // 並列でメタデータを取得（進捗報告付き）
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex as StdMutex};

        let processed = Arc::new(AtomicUsize::new(0));
        let callback = Arc::new(StdMutex::new(progress_callback));

        enum FileOutcome {
            Ok(FileMetadata),
            Err(ScanError),
        }

        let outcomes: Vec<FileOutcome> = entries
            .par_iter()
            .map(|entry| {
                let path = entry.path();

                let outcome = match fs::metadata(path) {
                    Ok(metadata) => match metadata.modified() {
                        Ok(modified) => match modified.duration_since(SystemTime::UNIX_EPOCH) {
                            Ok(duration) => FileOutcome::Ok(FileMetadata {
                                path: path.to_string_lossy().to_string(),
                                modified_time: duration.as_secs() as i64,
                                file_size: metadata.len() as i64,
                            }),
                            // #63: mtimeが1970-01-01より前（負のUNIX時刻）だと
                            // `duration_since`が失敗する。以前はここで`?`により
                            // ファイルごと黙って結果から除外していた。
                            Err(_) => FileOutcome::Err(ScanError {
                                path: path.to_path_buf(),
                                message: "modified time is before 1970-01-01 (UNIX epoch)"
                                    .to_string(),
                                scope: ScanErrorScope::File,
                            }),
                        },
                        Err(e) => FileOutcome::Err(ScanError {
                            path: path.to_path_buf(),
                            message: format!("failed to read modified time: {e}"),
                            scope: ScanErrorScope::File,
                        }),
                    },
                    Err(e) => FileOutcome::Err(ScanError {
                        path: path.to_path_buf(),
                        message: format!("failed to read metadata: {e}"),
                        scope: ScanErrorScope::File,
                    }),
                };

                // #63: 成功/失敗に関わらず必ず処理件数を進める（100ファイルごと、および
                // 最後の1件で進捗を報告）。以前は成功時にしか進めておらず、エラーが
                // 混ざると `count` が `total` に到達せず最終進捗イベントが発火しなかった。
                let count = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if count.is_multiple_of(100) || count == total {
                    if let Ok(mut cb) = callback.lock() {
                        cb(count, total);
                    }
                }

                outcome
            })
            .collect();

        let mut files = Vec::with_capacity(outcomes.len());
        let mut errors = walk_errors;
        for outcome in outcomes {
            match outcome {
                FileOutcome::Ok(f) => files.push(f),
                FileOutcome::Err(e) => errors.push(e),
            }
        }

        Ok((files, errors))
    }

    /// ディレクトリをスキャン（差分検出あり、進捗コールバック付き）。
    ///
    /// 前回追跡していたが今回のスキャン結果に無いパスは、`walk_filter`
    /// （日付ルールを除く）で除外判定し、一致すれば「不明」（ディレクトリ系除外で
    /// 枝刈りされ存在確認できていない）として `deleted_files` から除外する
    /// （#61レビュー S-a: 除外は削除ではないという原則を、枝刈りされて生スキャンにすら
    /// 現れないケースにも一貫して適用する）。
    ///
    /// #63: 今回の走査でエラーが起きたパス（`WalkDir` の読み取りエラー、または
    /// ファイル単位の `fs::metadata`/`mtime` 取得エラー）の配下も同様に「不明」として
    /// `deleted_files` から除外する。エラーで一時的に見えなかっただけのファイルを
    /// 誤って確定削除しないため。
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
        let (current_files, scan_errors) =
            self.scan_directory_with_progress(directory, walk_filter, progress_callback)?;

        let mut new_files = Vec::new();
        let mut modified_files = Vec::new();

        // 新規ファイルと変更されたファイルを区別して検出（#62: 呼び出し元
        // `perform_scan` がプレイリストへの反映を「含めるべき集合」との
        // パス差分で行うため、modified はプレイリストに新規追加されない。
        // ここでの区別は統計・テストの正確性のため）。
        for file in &current_files {
            match previous_map.remove(&file.path) {
                None => {
                    // 新規ファイル（前回は存在しなかったパス）
                    new_files.push(file.path.clone());
                }
                Some((prev_mtime, _prev_size)) => {
                    if prev_mtime != file.modified_time {
                        // 既存パスのまま内容が変わったファイル
                        modified_files.push(file.path.clone());
                    } else {
                        // 変更なし
                    }
                }
            }
        }

        // previous_map に残っているもの（今回の生スキャンで見つからなかったパス）を
        // 「確定削除」と「不明（ディレクトリ系除外で枝刈りされた、またはエラーで
        // 未確認）」に分ける。
        // #61レビュー nit: `is_ignored`（ファイル単位のglobも含む）ではなく
        // `has_pruned_ancestor_dir`（祖先ディレクトリの枝刈りだけ）で判定する。
        // filter_entry はディレクトリしか刈らずファイルは常に列挙するため、
        // ファイル単位のglobで除外されていただけのファイルが本当に消えていた場合は
        // 確定削除として扱う（不明扱いにしてfile_metadata/image_statsを温存しない）。
        // #63: 加えて、今回エラーになったパス自身、またはその配下（エラーがディレクトリの
        // 場合）にあるファイルも「不明」として扱う。
        //
        // #63 PR#77レビュー S3: 以前は候補パス(P件)×エラー(E件)の`starts_with`総当たり
        // （O(P×E)）だった。ファイル単位エラーは完全一致の`HashSet`（O(1)）、ディレクトリ
        // 単位エラーは`Path::ancestors()`を`HashSet`で引く（O(パスの深さ)、実運用では
        // 数十以下の定数）ことで、エラー件数に依存しない判定にする。
        let file_error_paths: std::collections::HashSet<&Path> = scan_errors
            .iter()
            .filter(|e| e.scope == ScanErrorScope::File)
            .map(|e| e.path.as_path())
            .collect();
        let dir_error_paths: std::collections::HashSet<&Path> = scan_errors
            .iter()
            .filter(|e| e.scope == ScanErrorScope::Directory)
            .map(|e| e.path.as_path())
            .collect();

        let mut deleted_files = Vec::new();
        let mut unknown_files = Vec::new();
        let mut error_unknown_files = Vec::new();
        for path in previous_map.keys() {
            let path_ref = Path::new(path);
            let under_error = file_error_paths.contains(path_ref)
                || path_ref.ancestors().any(|a| dir_error_paths.contains(a));
            if under_error {
                unknown_files.push(path.clone());
                error_unknown_files.push(path.clone());
            } else if walk_filter.has_pruned_ancestor_dir(path_ref, directory) {
                unknown_files.push(path.clone());
            } else {
                deleted_files.push(path.clone());
            }
        }

        let duration_ms = start_time.elapsed().as_millis();

        let error_count = scan_errors.len();
        // PR#77レビュー nit: `walkdir::Error`（ディレクトリ単位のエラー）の`Display`は
        // 対象パスを自前で含めて表示するため、単純に `"{path}: {message}"` と組み立てると
        // パスが二重に表示されていた（例: "/x/locked: IO error for operation on
        // /x/locked: Permission denied"）。メッセージに既にパスが含まれていれば
        // メッセージだけを使い、含まれていなければ（ファイル単位のエラー等）明示的に
        // 前置する。
        let error_examples = scan_errors
            .iter()
            .take(MAX_ERROR_EXAMPLES)
            .map(|e| {
                let path_str = e.path.display().to_string();
                if e.message.contains(&path_str) {
                    e.message.clone()
                } else {
                    format!("{path_str}: {}", e.message)
                }
            })
            .collect();

        Ok(ScanResult {
            total_count: current_files.len(),
            new_count: new_files.len(),
            modified_count: modified_files.len(),
            deleted_count: deleted_files.len(),
            unknown_count: unknown_files.len(),
            files: current_files,
            new_files,
            modified_files,
            deleted_files,
            unknown_files,
            error_unknown_files,
            duration_ms,
            error_count,
            error_examples,
        })
    }

    /// 画像ファイルかチェック
    #[cfg(test)]
    fn is_image_file(&self, path: &Path) -> bool {
        is_image_path(path)
    }

    /// 動画ファイルかチェック
    #[cfg(test)]
    fn is_video_file(&self, path: &Path) -> bool {
        is_video_path(path)
    }

    /// メディアファイル（画像または動画）かチェック
    fn is_media_file(&self, path: &Path) -> bool {
        is_media_path(path)
    }
}

/// 拡張子（大文字小文字を区別しない）が `extensions` のいずれかに一致するか。
fn has_extension_in(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| extensions.contains(&ext.to_lowercase().as_str()))
}

/// 画像ファイルか（拡張子による判定。`IMAGE_EXTENSIONS` が正本、#67）
pub fn is_image_path(path: &Path) -> bool {
    has_extension_in(path, IMAGE_EXTENSIONS)
}

/// 動画ファイルか（拡張子による判定。`VIDEO_EXTENSIONS` が正本）
pub fn is_video_path(path: &Path) -> bool {
    has_extension_in(path, VIDEO_EXTENSIONS)
}

/// 画像または動画か。スキャン・ピック一覧が同じ定義を使う（#67）
pub fn is_media_path(path: &Path) -> bool {
    is_image_path(path) || is_video_path(path)
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

    /// #62: 既存パスのまま `mtime` が変わったファイルは `modified_files` に入り、
    /// `new_files` には混ざらない（呼び出し元 `perform_scan` はパス集合の差分で
    /// プレイリスト反映を行うため、modified が重複してプレイリストに追加されることは
    /// 無いが、ここでの区別自体が正しく行われることを直接検証する）。
    #[test]
    fn incremental_scan_separates_modified_from_new_files() {
        let root =
            std::env::temp_dir().join(format!("sss_scanner_modified_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let unchanged_path = root.join("unchanged.jpg");
        let changed_path = root.join("changed.jpg");
        std::fs::write(&unchanged_path, b"unchanged").unwrap();
        std::fs::write(&changed_path, b"before-edit").unwrap();

        let scanner = ImageScanner::new();
        let no_prune_filter = crate::ignore::IgnoreFilter::from_patterns(&[]);

        let (first, first_errors) = scanner
            .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
            .expect("first scan");
        assert!(
            first_errors.is_empty(),
            "正常なファイルでエラーは出ないはず"
        );
        let previous: Vec<(String, i64, i64)> = first
            .iter()
            .map(|f| (f.path.clone(), f.modified_time, f.file_size))
            .collect();

        // changed.jpg の内容とmtimeを変える。new.jpg は今回初めて現れる。
        std::fs::write(&changed_path, b"after-edit-longer-content").unwrap();
        let new_mtime = std::time::SystemTime::now() + std::time::Duration::from_secs(120);
        let file = std::fs::File::options()
            .write(true)
            .open(&changed_path)
            .unwrap();
        file.set_modified(new_mtime)
            .expect("mtimeを明示的に変更できるはず");

        let new_path = root.join("new.jpg");
        std::fs::write(&new_path, b"brand-new").unwrap();

        let result = scanner
            .scan_directory_incremental_with_progress(&root, previous, &no_prune_filter, |_, _| {})
            .expect("incremental scan");

        let changed_str = changed_path.to_string_lossy().to_string();
        let new_str = new_path.to_string_lossy().to_string();

        assert!(
            result.modified_files.contains(&changed_str),
            "mtimeが変わった既存ファイルはmodified_filesに入るはず"
        );
        assert!(
            !result.new_files.contains(&changed_str),
            "mtime変更ファイルはnew_filesに混ざってはいけない(#62)"
        );
        assert!(
            result.new_files.contains(&new_str),
            "初めて見つかったファイルはnew_filesに入るはず"
        );
        assert!(!result.modified_files.contains(&new_str));
        assert_eq!(result.modified_count, result.modified_files.len());
        assert_eq!(result.new_count, result.new_files.len());
        assert!(result.deleted_files.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// #63: mtimeが1970-01-01より前（負のUNIX時刻）のファイルは、`duration_since`が
    /// 失敗するため以前は黙って結果から除外されていた。これはエラーとして報告され、
    /// `files`には含まれないことを検証する。
    #[test]
    fn pre_1970_mtime_is_reported_as_error_not_silently_dropped() {
        let root =
            std::env::temp_dir().join(format!("sss_scanner_pre1970_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let old_path = root.join("ancient.jpg");
        let normal_path = root.join("normal.jpg");
        std::fs::write(&old_path, b"ancient").unwrap();
        std::fs::write(&normal_path, b"normal").unwrap();

        let file = std::fs::File::options()
            .write(true)
            .open(&old_path)
            .unwrap();
        let before_epoch = SystemTime::UNIX_EPOCH
            .checked_sub(std::time::Duration::from_secs(3600))
            .unwrap();
        file.set_modified(before_epoch)
            .expect("この環境ではエポック前のmtime設定に対応しているはず");

        let scanner = ImageScanner::new();
        let no_prune_filter = crate::ignore::IgnoreFilter::from_patterns(&[]);
        let (files, errors) = scanner
            .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
            .expect("scan itself succeeds even if individual files error");

        let old_str = old_path.to_string_lossy().to_string();
        let normal_str = normal_path.to_string_lossy().to_string();

        assert!(
            !files.iter().any(|f| f.path == old_str),
            "エポック前mtimeのファイルはfilesに含まれないはず"
        );
        assert!(
            files.iter().any(|f| f.path == normal_str),
            "正常なファイルは影響を受けないはず"
        );
        assert_eq!(errors.len(), 1, "エラーは1件報告されるはず");
        assert_eq!(errors[0].path, old_path);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// #63 境界テスト: エラー件数が `MAX_ERROR_EXAMPLES` を超えても、`error_examples`
    /// は先頭 `MAX_ERROR_EXAMPLES` 件に切り詰められる（結果/UIの肥大化防止）。
    /// `error_count` は切り詰めず実際の総数を保持することも合わせて検証する。
    #[test]
    fn error_examples_are_capped_at_max_while_error_count_reflects_true_total() {
        let root =
            std::env::temp_dir().join(format!("sss_scanner_error_cap_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let error_file_count = MAX_ERROR_EXAMPLES + 2;
        let before_epoch = SystemTime::UNIX_EPOCH
            .checked_sub(std::time::Duration::from_secs(3600))
            .unwrap();
        for i in 0..error_file_count {
            let p = root.join(format!("ancient_{i}.jpg"));
            std::fs::write(&p, b"x").unwrap();
            let file = std::fs::File::options().write(true).open(&p).unwrap();
            file.set_modified(before_epoch)
                .expect("この環境ではエポック前のmtime設定に対応しているはず");
        }

        let scanner = ImageScanner::new();
        let no_prune_filter = crate::ignore::IgnoreFilter::from_patterns(&[]);
        let result = scanner
            .scan_directory_incremental_with_progress(&root, vec![], &no_prune_filter, |_, _| {})
            .expect("scan itself succeeds despite per-file errors");

        assert_eq!(
            result.error_count, error_file_count,
            "error_countは切り詰めず実際の総数を保持するはず"
        );
        assert_eq!(
            result.error_examples.len(),
            MAX_ERROR_EXAMPLES,
            "error_examplesはMAX_ERROR_EXAMPLES件に切り詰められるはず"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// #63: エラーになったファイルは、差分スキャンで「削除」ではなく「不明」として
    /// 扱われる（`file_metadata`/`image_stats` を温存するため）。
    #[test]
    fn file_with_scan_error_is_unknown_not_deleted_on_incremental_scan() {
        let root = std::env::temp_dir().join(format!(
            "sss_scanner_error_unknown_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let target_path = root.join("target.jpg");
        std::fs::write(&target_path, b"content").unwrap();

        let scanner = ImageScanner::new();
        let no_prune_filter = crate::ignore::IgnoreFilter::from_patterns(&[]);

        // 1回目: 正常にスキャンできる
        let (first, first_errors) = scanner
            .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
            .expect("first scan");
        assert!(first_errors.is_empty());
        let previous: Vec<(String, i64, i64)> = first
            .iter()
            .map(|f| (f.path.clone(), f.modified_time, f.file_size))
            .collect();

        // 2回目: 同じファイルのmtimeをエポック前に変え、エラーを起こす
        let file = std::fs::File::options()
            .write(true)
            .open(&target_path)
            .unwrap();
        let before_epoch = SystemTime::UNIX_EPOCH
            .checked_sub(std::time::Duration::from_secs(60))
            .unwrap();
        file.set_modified(before_epoch)
            .expect("この環境ではエポック前のmtime設定に対応しているはず");

        let result = scanner
            .scan_directory_incremental_with_progress(&root, previous, &no_prune_filter, |_, _| {})
            .expect("incremental scan");

        let target_str = target_path.to_string_lossy().to_string();
        assert_eq!(result.error_count, 1, "エラーが1件報告されるはず");
        assert!(!result.error_examples.is_empty());
        assert!(
            result.unknown_files.contains(&target_str),
            "エラーになったファイルは不明扱いになるはず"
        );
        assert!(
            !result.deleted_files.contains(&target_str),
            "エラーになったファイルを確定削除してはいけない"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// #63 直接の回帰テスト: `WalkDir` が読み取りエラーになった**ディレクトリ配下**の
    /// 複数ファイル（サブツリー全体）が「不明」として扱われ、確定削除されないこと。
    /// 単一ファイルのmtimeエラー（上のテスト）とは異なり、こちらはディレクトリ自体を
    /// 読めない場合（権限拒否等）に、配下のファイルがそもそも生スキャンの結果に一切
    /// 現れない（`WalkDir`がread_dirに失敗し降りられない）ケースを検証する。
    /// CI（ubuntu-22.04、非rootユーザーで実行）でのみ意味を持つため`#[cfg(unix)]`とし、
    /// root権限で実行された場合はchmodが効かず前提が崩れるためテストをスキップする。
    #[test]
    #[cfg(unix)]
    fn directory_with_walkdir_error_marks_its_whole_subtree_unknown_not_deleted() {
        use std::os::unix::fs::PermissionsExt;

        // root権限で実行されるとchmod 0o000でも読めてしまい前提が崩れるためスキップする。
        if !chmod_000_actually_denies_read() {
            eprintln!("root権限で実行されているためスキップ（chmodによる権限拒否が効かない）");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "sss_scanner_locked_subtree_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let locked_dir = root.join("locked");
        std::fs::create_dir_all(&locked_dir).unwrap();
        std::fs::write(locked_dir.join("a.jpg"), b"a").unwrap();
        std::fs::write(locked_dir.join("b.jpg"), b"b").unwrap();
        std::fs::write(root.join("top.jpg"), b"top").unwrap();

        let scanner = ImageScanner::new();
        let no_prune_filter = crate::ignore::IgnoreFilter::from_patterns(&[]);

        // 1回目: 全ファイルが読める状態でベースラインを作る。
        let (first, first_errors) = scanner
            .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
            .expect("first scan");
        assert!(first_errors.is_empty());
        assert_eq!(first.len(), 3, "locked配下2件+top.jpgの3件のはず");
        let previous: Vec<(String, i64, i64)> = first
            .iter()
            .map(|f| (f.path.clone(), f.modified_time, f.file_size))
            .collect();

        // 2回目: lockedディレクトリの読み取り権限を奪う（WalkDirがread_dirに失敗する）。
        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = scanner.scan_directory_incremental_with_progress(
            &root,
            previous,
            &no_prune_filter,
            |_, _| {},
        );

        // 後片付け（remove_dir_allの前に権限を戻す）は結果に関わらず必ず行う。
        std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = result.expect("incremental scan itself succeeds despite the subtree error");

        let a_str = locked_dir.join("a.jpg").to_string_lossy().to_string();
        let b_str = locked_dir.join("b.jpg").to_string_lossy().to_string();
        let top_str = root.join("top.jpg").to_string_lossy().to_string();

        assert!(
            result.error_count >= 1,
            "lockedディレクトリの読み取りエラーが1件以上あるはず"
        );
        assert!(
            result.unknown_files.contains(&a_str) && result.unknown_files.contains(&b_str),
            "locked配下の2件はどちらも不明扱いになるはず: {:?}",
            result.unknown_files
        );
        assert!(
            !result.deleted_files.contains(&a_str) && !result.deleted_files.contains(&b_str),
            "locked配下を確定削除してはいけない: {:?}",
            result.deleted_files
        );
        assert!(
            !result.unknown_files.contains(&top_str) && !result.deleted_files.contains(&top_str),
            "エラーと無関係なtop.jpgは不明にも削除にもならないはず（変更なしのまま）"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// この環境で `chmod 0o000` が実際に読み取りを拒否するかどうかを直接試して判定する
    /// （root権限だと拒否が効かないため、`libc`のFFIを増やさず実際の効果で判定する）。
    #[cfg(unix)]
    fn chmod_000_actually_denies_read() -> bool {
        use std::os::unix::fs::PermissionsExt;
        let probe_dir = std::env::temp_dir().join(format!(
            "sss_root_probe_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&probe_dir).unwrap();
        std::fs::write(probe_dir.join("x"), b"x").unwrap();
        std::fs::set_permissions(&probe_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = std::fs::read_dir(&probe_dir).is_err();
        std::fs::set_permissions(&probe_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&probe_dir);
        denied
    }

    /// #63 PR#77レビュー nit: 読み取りエラーでファイルが1件も見つからなくても
    /// （`entries`が空）、進捗コールバックが最低1回（`(0, 0)`）は必ず呼ばれること
    /// （早期returnで呼ばれずじまいになる退行を防ぐ）。
    #[test]
    #[cfg(unix)]
    fn progress_callback_fires_even_when_root_is_unreadable_and_zero_files_found() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::Arc;

        if !chmod_000_actually_denies_read() {
            eprintln!("root権限で実行されているためスキップ（chmodによる権限拒否が効かない）");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "sss_scanner_unreadable_root_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hidden.jpg"), b"x").unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000)).unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_cb = Arc::clone(&calls);

        let scanner = ImageScanner::new();
        let no_prune_filter = crate::ignore::IgnoreFilter::from_patterns(&[]);
        let result = scanner.scan_directory_with_progress(
            &root,
            &no_prune_filter,
            move |_current, _total| {
                calls_cb.fetch_add(1, AtomicOrdering::Relaxed);
            },
        );

        // 後片付け（remove_dir_allの前に権限を戻す）は結果に関わらず必ず行う。
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (files, errors) =
            result.expect("ルート自体を開けなくてもErrにはせず空の結果+エラーで返すはず");

        assert!(files.is_empty(), "読めないので0件のはず");
        assert!(
            !errors.is_empty(),
            "ルート自体の読み取りエラーが記録されるはず"
        );
        assert!(
            calls.load(AtomicOrdering::Relaxed) >= 1,
            "0件でも進捗コールバックが最低1回(0,0)で呼ばれるはず"
        );

        std::fs::remove_dir_all(&root).unwrap();
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

    // ---- 独立QA観点表からの追加テスト（#67） ----

    #[test]
    fn media_path_needs_a_real_extension() {
        // 拡張子なし
        assert!(!is_media_path(Path::new("photo")));
        assert!(!is_media_path(Path::new("/dir/mp4")));
        // ドットファイル名 `.jpg` は拡張子ではなくファイル名（std は extension=None）
        assert!(!is_media_path(Path::new(".jpg")));
        assert!(!is_media_path(Path::new("/dir/.mp4")));
        // 末尾ドットのみ
        assert!(!is_media_path(Path::new("photo.")));
        // 通常の拡張子は大文字小文字によらず真
        assert!(is_media_path(Path::new("a.JPG")));
        assert!(is_media_path(Path::new("/dir/b.Mp4")));
    }

    #[cfg(unix)]
    #[test]
    fn media_path_with_non_utf8_extension_is_false_and_does_not_panic() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let path = Path::new(OsStr::from_bytes(b"/dir/a.\xff\xfe"));
        assert!(!is_media_path(path));
        assert!(!is_image_path(path));
        assert!(!is_video_path(path));
    }
}
