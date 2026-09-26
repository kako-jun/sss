//! プレイリストの永続化まわりを1箇所に集約するヘルパー（#62レビューM2/S2/S3）。
//!
//! `perform_scan`（スキャン時の差分更新・起動時の復元）と `file_operations::exclude_image`
//! （即時除外）の両方が `Playlist::update_images` でメンバーシップを変更するが、
//! 変更のたびに必ずここを通して保存させることで、「保存し忘れて再起動後に
//! 消えたはずの画像が復活する/二重表示になる」という抜け（#62レビューM2）を防ぐ。

use crate::database::Database;
use crate::playlist::Playlist;
use std::path::Path;

/// ディレクトリパスを比較用に正規化する（#62レビューS2）。
///
/// 同じディレクトリでも `canonicalize` 前後・末尾区切りの有無で文字列表現が
/// 食い違うことがあるため、`canonicalize` を優先し、失敗した場合（起動直後で
/// まだ許可されていない・既に存在しない等）は末尾区切りを除去した文字列で
/// 比較する。保存・表示用の値はこの正規化前の元の文字列をそのまま使い、
/// 比較にだけこのキーを使うこと。
pub fn normalize_directory_key(path: &Path) -> String {
    let base = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    base.trim_end_matches(['/', '\\']).to_string()
}

/// プレイリストのシャッフルが確定した（`shuffled_list` 自体が変わった）ときの
/// フル保存。保存に失敗しても表示自体は継続させたいため、呼び出し元を止めずに
/// `eprintln!` でログするだけにする（#62レビューS3: `let _ =` で握りつぶさない。
/// 次にシャッフルが確定したタイミングで再度保存が試みられる）。
pub fn save_full(db: &Database, directory_path: &str, playlist: &Playlist) {
    if let Err(e) = db.save_playlist_full(
        directory_path,
        playlist.shuffled_list(),
        playlist.next_index(),
        playlist.history(),
        playlist.history_position(),
    ) {
        eprintln!("Failed to persist playlist state (full save) for {directory_path}: {e}");
    }
}

/// `advance`/`go_back` のたびに呼ぶ軽量な永続化。`shuffled_list` には触れない。
pub fn save_position(db: &Database, playlist: &Playlist) {
    if let Err(e) = db.save_playlist_position(
        playlist.next_index(),
        playlist.history(),
        playlist.history_position(),
    ) {
        eprintln!("Failed to persist playlist state (position save): {e}");
    }
}
