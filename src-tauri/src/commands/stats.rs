use crate::commands::types::{AppState, Stats};
use tauri::State;

/// 統計情報を取得
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<Stats, String> {
    let db = state.db.lock().unwrap();

    let total_images = db
        .get_total_image_count()
        .map_err(|e| format!("Database error: {}", e))?;

    let displayed_images = db
        .get_displayed_image_count()
        .map_err(|e| format!("Database error: {}", e))?;

    Ok(Stats {
        total_images,
        displayed_images,
    })
}

/// 現在のプレイリスト状態を取得 (position, total, canGoBack)
#[tauri::command]
pub async fn get_playlist_info(
    state: State<'_, AppState>,
) -> Result<Option<(usize, usize, bool)>, String> {
    let playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref playlist) = *playlist_lock {
        Ok(Some((
            playlist.current_position(),
            playlist.total_count(),
            playlist.can_go_back(),
        )))
    } else {
        Ok(None)
    }
}

/// 統計データを取得（グラフ用）
#[tauri::command]
pub async fn get_display_stats(state: State<'_, AppState>) -> Result<Vec<(String, i32)>, String> {
    let db = state.db.lock().unwrap();
    db.get_all_display_counts()
        .map_err(|e| format!("Failed to get display stats: {}", e))
}
