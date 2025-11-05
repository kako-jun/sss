use crate::database::Database;
use crate::playlist::Playlist;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// アプリケーション状態
pub struct AppState {
    pub db: Mutex<Database>,
    pub playlist: Mutex<Option<Playlist>>,
    pub directory_path: Mutex<Option<PathBuf>>,
    pub cache_dir: PathBuf,
    pub _keep_awake: keepawake::AwakeHandle,
}

/// スキャン進捗情報
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub total_files: usize,
    pub new_files: usize,
    pub deleted_files: usize,
    pub duration_ms: u128,
}

/// 統計情報
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_images: i32,
    pub displayed_images: i32,
}
