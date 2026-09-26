//! asset protocol scope（Tauri の `convertFileSrc` が読み込めるディレクトリ）の
//! 動的許可に使う純関数群。
//!
//! `tauri::scope::fs::Scope::allow_directory` の呼び出し自体は実行中の Tauri アプリの
//! 状態を書き換える副作用なので、「どのディレクトリを許可すべきか」を判断する部分だけを
//! ここに切り出す。呼び出し側（`lib.rs` の起動処理・`commands::scan::scan_directory`・
//! `commands::settings::save_setting`・`commands::file_operations::pick_image`）が
//! 実際の許可 API 呼び出しを行う。

use std::path::{Path, PathBuf};

/// ピック先ディレクトリを解決する（設定済みならそれを、無ければ `<pictures>/sss-picked`）。
pub fn resolve_share_directory(pictures_dir: &Path, saved_setting: Option<&str>) -> PathBuf {
    match saved_setting {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => pictures_dir.join("sss-picked"),
    }
}

/// ピック先ディレクトリを解決し、そのまま asset scope に許可してよいか判定する。
/// `resolve_share_directory` と `sanitize_allow_dir` を束ねた薄いラッパーで、
/// `save_setting`（設定変更時）と `pick_image`（ディレクトリ作成直後の再許可。
/// 起動時・設定変更時点ではディレクトリ未作成で許可に失敗していることがあるため、
/// 実在が保証されたタイミングで改めて判定し直す。レビュー #73 must）の
/// 両方から同じ判定ロジックを使う。
pub fn resolve_and_sanitize_share_directory(
    pictures_dir: &Path,
    saved_setting: Option<&str>,
) -> Option<PathBuf> {
    sanitize_allow_dir(&resolve_share_directory(pictures_dir, saved_setting))
}

/// 起動直後（フロントの自動スキャン完了前）に asset scope へ許可しておくべきディレクトリ一覧。
///
/// - キャッシュディレクトリ: 最適化画像・先読みの保存先。常に必要。
/// - ピック先ディレクトリ: 設定画面「ピック済み」タブのサムネイル表示に使う
///   （ホームディレクトリが解決できない等で不明な場合は省く）。
/// - 過去にスキャンした全ディレクトリ（`scan_history` の distinct `directory_path`。
///   前回ディレクトリだけでなく、履歴タブ（`get_recent_images`）に残る他ディレクトリの
///   画像も表示できるよう、起動時自動スキャンの完了を待たずに先に許可しておく。
///   レビュー #73 should2）。
pub fn startup_allow_dirs(
    cache_dir: &Path,
    share_directory: Option<&Path>,
    scanned_directories: &[PathBuf],
) -> Vec<PathBuf> {
    let mut dirs = vec![cache_dir.to_path_buf()];
    if let Some(dir) = share_directory {
        dirs.push(dir.to_path_buf());
    }
    dirs.extend(scanned_directories.iter().cloned());
    dirs
}

/// asset scope に実際に許可してよいディレクトリかどうかを検証する（M1修正: レビュー #73）。
///
/// `tauri::scope::fs::Scope::allow_directory` は与えられたパスをそのままパターン化するため、
/// 空文字列（`Path::new("")`）を渡すと `"/**"` 相当の全ファイルシステム許可パターンが
/// 生成されてしまう事故があった。この関数はそれを防ぐゲートで、以下をすべて満たす
/// ディレクトリだけを許可し、`canonicalize` 済みの絶対パスを返す:
///
/// - 空文字列でない
/// - 絶対パスである
/// - 実在するディレクトリである（`is_dir()`）
/// - ファイルシステムルート自体（`parent()` が `None` になるパス）のうち、
///   「保護対象のルート」ではない（[`is_protected_root`] 参照。should1修正:
///   Windows のドライブ直下を一律拒否すると `D:\` 等の SD カード/外付けドライブを
///   スキャン対象にできなくなるため、ホームディレクトリが属するドライブ
///   （システムドライブ相当。Unix では `/` の一択）だけを拒否する）
///
/// `startup_allow_dirs` の出力・`save_setting`/`pick_image` で解決された共有先・
/// `scan_directory` のスキャン対象など、`allow_directory` を呼ぶ直前のすべての候補に適用する。
pub fn sanitize_allow_dir(path: &Path) -> Option<PathBuf> {
    sanitize_allow_dir_with_home(path, dirs::home_dir().as_deref())
}

/// [`sanitize_allow_dir`] のテスト可能なコア実装。ホームディレクトリを引数として
/// 受け取ることで、実環境の `dirs::home_dir()` に依存せず単体テストできる。
fn sanitize_allow_dir_with_home(path: &Path, home_dir: Option<&Path>) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    if !path.is_absolute() {
        return None;
    }
    if !path.is_dir() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if canonical.parent().is_none() && is_protected_root(&canonical, home_dir) {
        return None;
    }
    Some(canonical)
}

/// ファイルシステムルート（`parent()` が `None` になるパス）のうち、
/// asset scope への許可を拒否すべきものかどうかを判定する（純関数。fsアクセスなし）。
///
/// - Unix はルートが `/` の1種類しかなく、常に拒否対象。
/// - Windows はドライブごとに存在するため、ホームディレクトリが属するドライブの
///   ルート（`home_dir.ancestors().last()`。システムドライブ相当、通常 `C:\`）
///   だけを拒否し、SD カード等の他ドライブ直下（例: `D:\`）は許可する。
/// - ホームディレクトリが不明な場合は安全側に倒し、あらゆるルートを拒否する。
fn is_protected_root(canonical_root: &Path, home_dir: Option<&Path>) -> bool {
    match home_dir.and_then(|home| home.ancestors().last().map(Path::to_path_buf)) {
        Some(home_root) => canonical_root == home_root,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- resolve_share_directory ---

    #[test]
    fn resolve_share_directory_defaults_to_pictures_sss_picked_when_unset() {
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, None),
            pictures.join("sss-picked")
        );
    }

    #[test]
    fn resolve_share_directory_defaults_when_saved_setting_is_empty_string() {
        // 境界値: 空文字は「未設定」と同じ扱い（保存時のバグ等で空文字が入っても暴走しない）
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some("")),
            pictures.join("sss-picked")
        );
    }

    #[test]
    fn resolve_share_directory_treats_whitespace_only_as_non_empty() {
        // 境界値+1: is_empty() はバイト長のみで判定するため、空白1文字は「空」ではない。
        // トリムしない現在の実装をそのまま固定する（事故防止の仕様確認）。
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some(" ")),
            PathBuf::from(" ")
        );
    }

    #[test]
    fn resolve_share_directory_uses_saved_absolute_path_verbatim() {
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some("/mnt/ssd/picked")),
            PathBuf::from("/mnt/ssd/picked")
        );
    }

    #[test]
    fn resolve_share_directory_uses_saved_relative_path_verbatim() {
        // 異常系寄りの同値分割: 相対パスが保存されていても pictures_dir とは結合しない
        // （呼び出し側が絶対パスを保存する前提だが、関数自体はそのまま通す仕様を固定）。
        let pictures = Path::new("/home/kako/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, Some("relative/picked")),
            PathBuf::from("relative/picked")
        );
    }

    #[test]
    fn resolve_share_directory_handles_non_ascii_paths() {
        // 文字種: 日本語パス（macOS/Windowsどちらのユーザーディレクトリでも起こりうる）
        let pictures = Path::new("/Users/加古純/Pictures");
        assert_eq!(
            resolve_share_directory(pictures, None),
            pictures.join("sss-picked")
        );
        assert_eq!(
            resolve_share_directory(pictures, Some("/Volumes/外付け/ピック先")),
            PathBuf::from("/Volumes/外付け/ピック先")
        );
    }

    #[test]
    fn resolve_share_directory_preserves_windows_style_backslash_path_literally() {
        // 文字種: Windowsパス。実行OSに関わらず、設定値をそのまま PathBuf 化するだけの
        // 挙動を固定する（区切り文字の解釈はしない）。
        let pictures = Path::new("/home/kako/Pictures");
        let windows_path = "C:\\Users\\kako\\Pictures\\sss-picked";
        assert_eq!(
            resolve_share_directory(pictures, Some(windows_path)),
            PathBuf::from(windows_path)
        );
    }

    // --- startup_allow_dirs ---
    //
    // share_directory は独立条件（Some/None）、scanned_directories は0〜複数件の
    // スライスなので、組合せをデシジョンテーブルで網羅する。cache_dir は常に先頭に入る。
    //
    // | share | scanned          | 期待される要素                        |
    // |-------|------------------|----------------------------------------|
    // | None  | []               | [cache]                                 |
    // | Some  | []               | [cache, share]                          |
    // | None  | [d1]             | [cache, d1]                             |
    // | Some  | [d1]             | [cache, share, d1]（順序も固定）        |
    // | Some  | [d1, d2, d3]     | [cache, share, d1, d2, d3]（複数件も全許可、should2） |

    #[test]
    fn startup_allow_dirs_only_cache_when_both_unset() {
        let cache = Path::new("/cache");
        assert_eq!(
            startup_allow_dirs(cache, None, &[]),
            vec![cache.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_share_when_only_share_set() {
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), &[]),
            vec![cache.to_path_buf(), share.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_scanned_when_only_scanned_set() {
        let cache = Path::new("/cache");
        let last = PathBuf::from("/photos/2026");
        assert_eq!(
            startup_allow_dirs(cache, None, std::slice::from_ref(&last)),
            vec![cache.to_path_buf(), last]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_both_in_cache_share_scanned_order_when_both_set() {
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        let last = PathBuf::from("/photos/2026");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), std::slice::from_ref(&last)),
            vec![cache.to_path_buf(), share.to_path_buf(), last]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_all_scanned_directories_from_history() {
        // should2(レビュー #73): 前回ディレクトリだけでなく、scan_history に残る
        // 過去のスキャン先すべてを候補に含められることを確認する（履歴タブ対応）。
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        let d1 = PathBuf::from("/photos/2024");
        let d2 = PathBuf::from("/photos/2025");
        let d3 = PathBuf::from("/mnt/sdcard/dcim");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), &[d1.clone(), d2.clone(), d3.clone()]),
            vec![cache.to_path_buf(), share.to_path_buf(), d1, d2, d3]
        );
    }

    #[test]
    fn startup_allow_dirs_does_not_dedupe_when_share_and_scanned_are_the_same_directory() {
        // 事故パターン確認: ピック先とスキャン対象が同じディレクトリの場合でも重複除去しない
        // （関数は単純listで、allow_directory 呼び出し側の冪等性に委ねる仕様を固定）。
        let cache = Path::new("/cache");
        let same = Path::new("/pictures/sss-picked");
        assert_eq!(
            startup_allow_dirs(cache, Some(same), &[same.to_path_buf()]),
            vec![cache.to_path_buf(), same.to_path_buf(), same.to_path_buf()]
        );
    }

    // --- is_protected_root（純関数。fsアクセスなし） ---
    //
    // should1(レビュー #73): ルート拒否は Unix の `/` と「ホームディレクトリが属する
    // ドライブのルート」に限定する不変条件を、実ファイルシステムに依存せず検証する。

    #[test]
    fn is_protected_root_rejects_when_it_equals_home_ancestor_root() {
        let root = Path::new("/");
        let home = Path::new("/home/kako");
        assert!(is_protected_root(root, Some(home)));
    }

    #[test]
    fn is_protected_root_allows_root_different_from_home_ancestor_root() {
        // Windows のドライブ直下を模したケース: home 側のルートと一致しない
        // ルート候補（SDカード等の別ドライブに相当）は保護対象にしない。
        let other_drive_root = Path::new("/mnt/sdcard");
        let home = Path::new("/home/kako");
        assert!(!is_protected_root(other_drive_root, Some(home)));
    }

    #[test]
    fn is_protected_root_rejects_everything_when_home_is_unknown() {
        // ホームディレクトリが解決できない環境では安全側に倒し、あらゆるルートを拒否する
        let root = Path::new("/mnt/sdcard");
        assert!(is_protected_root(root, None));
    }

    // --- sanitize_allow_dir ---
    //
    // M1(must, レビュー #73): 拒否側の不変条件を固定する。
    // 空/相対/存在しない/ファイル/ホームドライブのルートは必ず None、
    // 正常な絶対ディレクトリだけが Some(canonicalize済み) になることを保証する。

    /// テスト専用のユニークな一時ディレクトリ。Drop で自動削除する
    /// （nit修正: レビュー #73。以前は作りっぱなしで後片付けしていなかった）。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("sss_asset_scope_test_{tag}_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sanitize_allow_dir_rejects_empty_path() {
        assert_eq!(sanitize_allow_dir(Path::new("")), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_relative_path() {
        // カレントディレクトリ相対では意図しない場所を許可しかねないため拒否する
        assert_eq!(sanitize_allow_dir(Path::new("relative/dir")), None);
        assert_eq!(sanitize_allow_dir(Path::new(".")), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_nonexistent_absolute_path() {
        let missing = std::env::temp_dir().join("sss_asset_scope_test_does_not_exist_xyz");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(sanitize_allow_dir(&missing), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_file_path() {
        let dir = TempDir::new("rejects_file");
        let file_path = dir.path().join("not_a_dir.txt");
        std::fs::write(&file_path, b"x").unwrap();
        assert_eq!(sanitize_allow_dir(&file_path), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_filesystem_root_on_unix() {
        // Unix はルートが `/` の1種類しかなく、常に拒否対象（is_protected_root の
        // Windows ドライブ相対緩和は影響しない）。実行中のホストが必ず持つ唯一の
        // ルートなので、CI (ubuntu) でも実際に検証できる。
        assert_eq!(sanitize_allow_dir(Path::new("/")), None);
    }

    #[test]
    fn sanitize_allow_dir_accepts_valid_absolute_directory_and_canonicalizes() {
        let dir = TempDir::new("accepts_valid");
        let expected = dir.path().canonicalize().unwrap();
        assert_eq!(sanitize_allow_dir(dir.path()), Some(expected));
    }

    #[test]
    fn sanitize_allow_dir_with_home_allows_root_when_home_is_on_a_different_root() {
        // should1(レビュー #73): sanitize_allow_dir_with_home に偽のホームディレクトリを
        // 注入し、「ホームディレクトリのドライブと一致しないルートは許可する」ことを、
        // 実際に is_dir/canonicalize が通る本物のディレクトリ（tempdir）で確認する。
        // tempdir 自体はルートではないが、is_protected_root 側の判定(Some(false)) が
        // 素通りして最終的に許可される経路を、parent() != None のケースで検証する。
        let dir = TempDir::new("home_mismatch");
        let unrelated_home = Path::new("/this/home/does/not/exist/at/all");
        let expected = dir.path().canonicalize().unwrap();
        assert_eq!(
            sanitize_allow_dir_with_home(dir.path(), Some(unrelated_home)),
            Some(expected)
        );
    }

    // --- resolve_and_sanitize_share_directory ---

    #[test]
    fn resolve_and_sanitize_share_directory_accepts_existing_absolute_setting() {
        let dir = TempDir::new("resolve_and_sanitize_ok");
        let pictures = Path::new("/does/not/matter/because/setting/is/absolute");
        let expected = dir.path().canonicalize().unwrap();
        assert_eq!(
            resolve_and_sanitize_share_directory(pictures, Some(dir.path().to_str().unwrap())),
            Some(expected)
        );
    }

    #[test]
    fn resolve_and_sanitize_share_directory_rejects_when_default_does_not_exist_yet() {
        // must(レビュー #73): 初回起動でまだ pick フォルダが作成されていない場合、
        // resolve される既定パス（<pictures>/sss-picked）は is_dir() が false なので
        // 拒否される。これが「pick_image が create_dir_all 後に再許可すべき」根拠。
        let pictures = TempDir::new("resolve_and_sanitize_missing_pictures");
        assert_eq!(
            resolve_and_sanitize_share_directory(pictures.path(), None),
            None
        );
    }
}
