use crate::cache_worker::CacheWorker;
use crate::database::Database;
use crate::playlist::Playlist;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

/// アプリケーション状態
pub struct AppState {
    pub db: Mutex<Database>,
    pub playlist: Mutex<Option<Playlist>>,
    pub directory_path: Mutex<Option<PathBuf>>,
    pub cache_dir: PathBuf,
    /// 画像最適化キャッシュを作る単一ワーカースレッド（#60）。表示・先読み要求はここに積む。
    pub cache_worker: CacheWorker,
    /// スクリーンセーバー抑制ハンドル。初期化に失敗した環境（D-Bus 無し等）では `None`
    pub _keep_awake: Option<keepawake::AwakeHandle>,
    /// `scan_directory` の二重実行防止フラグ（#61レビュー nit）。
    /// `commands::scan::ScanGuard` が `compare_exchange` で操作する。
    pub scan_in_progress: AtomicBool,
}

/// スキャン進捗情報
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub total_files: usize,
    pub new_files: usize,
    pub deleted_files: usize,
    pub duration_ms: u128,
    /// 走査中に発生したエラーの件数（`WalkDir`読み取りエラー＋ファイル単位の
    /// メタデータ/mtime取得エラー。1970年より前のmtimeを含む）。#63。
    pub error_count: usize,
    /// エラーの代表例（最大5件、`"{path}: {message}"`形式）。UIにそのまま表示する。#63。
    pub error_examples: Vec<String>,
}

/// 統計情報
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_images: i32,
    pub displayed_images: i32,
}
