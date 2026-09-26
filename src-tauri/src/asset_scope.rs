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

// このモジュールの単体テストは別途テスト担当が追加する（#59）。
// 上記2関数は Tauri の実行時状態に依存しない純関数なので、そのままテスト可能。
