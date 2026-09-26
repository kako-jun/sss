//! asset protocol scope（Tauri の `convertFileSrc` が読み込みを許可するディレクトリ）の
//! 動的許可に使う純関数群。
//!
//! `tauri::scope::fs::Scope::allow_directory` の呼び出し自体は実行中の Tauri アプリの
//! 状態を書き換える副作用なので、「どのディレクトリを許可すべきか」を判断する部分だけを
//! ここに切り出す。呼び出し側（`lib.rs` の起動処理・`commands::scan::scan_directory`）が
//! 実際の許可 API 呼び出しを行う。

use std::path::{Path, PathBuf};

/// ピック先ディレクトリを解決する（設定済みならそれを、無ければ `<pictures>/sss-picked`）。
pub fn resolve_share_directory(pictures_dir: &Path, saved_setting: Option<&str>) -> PathBuf {
    match saved_setting {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => pictures_dir.join("sss-picked"),
    }
}

/// 起動直後（フロントの自動スキャン完了前）に asset scope へ許可しておくべきディレクトリ一覧。
///
/// - キャッシュディレクトリ: 最適化画像・先読みの保存先。常に必要。
/// - ピック先ディレクトリ: 設定画面「ピック済み」タブのサムネイル表示に使う
///   （ホームディレクトリが解決できない等で不明な場合は省く）。
/// - 前回スキャン先: DB に保存済みなら、起動時自動スキャンの完了を待たずに
///   履歴/統計表示に備えて先に許可しておく。
pub fn startup_allow_dirs(
    cache_dir: &Path,
    share_directory: Option<&Path>,
    last_directory: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = vec![cache_dir.to_path_buf()];
    if let Some(dir) = share_directory {
        dirs.push(dir.to_path_buf());
    }
    if let Some(dir) = last_directory {
        dirs.push(dir.to_path_buf());
    }
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
/// - `canonicalize` 後にファイルシステムルート自体（`/` や `C:\` 等、`parent()` が
///   `None` になるパス）ではない
///
/// `startup_allow_dirs` の出力・`save_setting` で保存された共有先・`scan_directory` の
/// スキャン対象など、`allow_directory` を呼ぶ直前のすべての候補に適用する。
pub fn sanitize_allow_dir(path: &Path) -> Option<PathBuf> {
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
    canonical.parent()?;
    Some(canonical)
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
    // share_directory / last_directory は独立した2条件（Some/None）なので、
    // 組合せをデシジョンテーブルで網羅する。cache_dir は常に先頭に入る。
    //
    // | share | last | 期待される要素            |
    // |-------|------|---------------------------|
    // | None  | None | [cache]                    |
    // | Some  | None | [cache, share]             |
    // | None  | Some | [cache, last]              |
    // | Some  | Some | [cache, share, last]（順序も固定） |

    #[test]
    fn startup_allow_dirs_only_cache_when_both_unset() {
        let cache = Path::new("/cache");
        assert_eq!(
            startup_allow_dirs(cache, None, None),
            vec![cache.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_share_when_only_share_set() {
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), None),
            vec![cache.to_path_buf(), share.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_last_when_only_last_set() {
        let cache = Path::new("/cache");
        let last = Path::new("/photos/2026");
        assert_eq!(
            startup_allow_dirs(cache, None, Some(last)),
            vec![cache.to_path_buf(), last.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_includes_both_in_cache_share_last_order_when_both_set() {
        let cache = Path::new("/cache");
        let share = Path::new("/pictures/sss-picked");
        let last = Path::new("/photos/2026");
        assert_eq!(
            startup_allow_dirs(cache, Some(share), Some(last)),
            vec![cache.to_path_buf(), share.to_path_buf(), last.to_path_buf()]
        );
    }

    #[test]
    fn startup_allow_dirs_does_not_dedupe_when_share_and_last_are_the_same_directory() {
        // 事故パターン確認: ピック先とスキャン対象が同じディレクトリの場合でも重複除去しない
        // （関数は単純listで、allow_directory 呼び出し側の冪等性に委ねる仕様を固定）。
        let cache = Path::new("/cache");
        let same = Path::new("/pictures/sss-picked");
        assert_eq!(
            startup_allow_dirs(cache, Some(same), Some(same)),
            vec![cache.to_path_buf(), same.to_path_buf(), same.to_path_buf()]
        );
    }

    // --- sanitize_allow_dir ---
    //
    // M1(must, レビュー #73): 拒否側の不変条件を固定する。
    // 空/相対/存在しない/ファイル/ファイルシステムルートは必ず None、
    // 正常な絶対ディレクトリだけが Some(canonicalize済み) になることを保証する。

    /// テスト専用のユニークな一時ディレクトリを作る（並列テストでも衝突しない）。
    fn unique_tempdir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sss_asset_scope_test_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
        let dir = unique_tempdir("rejects_file");
        let file_path = dir.join("not_a_dir.txt");
        std::fs::write(&file_path, b"x").unwrap();
        assert_eq!(sanitize_allow_dir(&file_path), None);
    }

    #[test]
    fn sanitize_allow_dir_rejects_filesystem_root() {
        // ルート自体（parent() が None）は "/**" 相当のパターンになり全FS許可になるため拒否
        assert_eq!(sanitize_allow_dir(Path::new("/")), None);
        #[cfg(windows)]
        assert_eq!(sanitize_allow_dir(Path::new("C:\\")), None);
    }

    #[test]
    fn sanitize_allow_dir_accepts_valid_absolute_directory_and_canonicalizes() {
        let dir = unique_tempdir("accepts_valid");
        let expected = dir.canonicalize().unwrap();
        assert_eq!(sanitize_allow_dir(&dir), Some(expected));
    }
}
