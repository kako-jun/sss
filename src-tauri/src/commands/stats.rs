use crate::commands::types::{AppState, Stats};
use tauri::State;

/// 統計情報を取得
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<Stats, String> {
    // #61レビュー nit: 総数はプレイリスト（除外ルール適用後の「含める集合」）の件数に
    // 揃える。以前は `file_metadata` の全件数（`get_total_image_count`）を使っており、
    // 除外ルールで対象外になったファイルまで数に含まれ、ExcludeRulesSection での
    // 除外操作の結果とGraphSectionの表示が食い違っていた。未スキャン時は0。
    let total_images = {
        let playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        playlist_lock
            .as_ref()
            .map(|playlist| playlist.total_count())
            .unwrap_or(0) as i32
    };

    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let displayed_images = db
        .get_displayed_image_count()
        .map_err(|e| format!("Database error: {e}"))?;

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
    let playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());

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
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.get_all_display_counts()
        .map_err(|e| format!("Failed to get display stats: {e}"))
}
