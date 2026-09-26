use crate::commands::types::{AppState, Stats};
use tauri::State;

/// 統計情報を取得
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<Stats, String> {
    // #61レビュー nit: 総数はプレイリスト（除外ルール適用後の「含める集合」）の件数に
    // 揃える。以前は `file_metadata` の全件数（`get_total_image_count`）を使っており、
    // 除外ルールで対象外になったファイルまで数に含まれ、ExcludeRulesSection での
    // 除外操作の結果とGraphSectionの表示が食い違っていた。未スキャン時は0。
    let (total_images, member_paths) = {
        let playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        match playlist_lock.as_ref() {
            Some(playlist) => (playlist.total_count() as i32, playlist.current_paths()),
            None => (0, std::collections::HashSet::new()),
        }
    };

    // #63 PR#77レビュー2巡目 nit: displayed_imagesは「現在のディレクトリ配下」だけでなく
    // 「現在のプレイリスト（除外ルール適用後の含める集合）のメンバー」だけを数える。
    // ディレクトリ配下限定だけ（前回のS2修正）だと、表示した後に除外ルールが付いた
    // ファイル（`image_stats`には`display_count > 0`が残るが、プレイリストのメンバー
    // ではなくなっている）がまだ数に含まれてしまい、`displayed_images`が
    // `total_images`（プレイリストの総数）を超えてしまう矛盾したケースがあった。
    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let displayed_images = match &directory {
        Some(dir) => {
            let counts = db
                .get_all_display_counts_under(&dir.to_string_lossy())
                .map_err(|e| format!("Database error: {e}"))?;
            counts
                .iter()
                .filter(|(path, count)| *count > 0 && member_paths.contains(path))
                .count() as i32
        }
        None => 0,
    };

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
///
/// #63 PR#77レビューS2: `get_stats`の`displayed_images`と同じ理由で、現在の
/// ディレクトリ配下だけに限定する。未スキャン時は空配列。
#[tauri::command]
pub async fn get_display_stats(state: State<'_, AppState>) -> Result<Vec<(String, i32)>, String> {
    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match &directory {
        Some(dir) => db
            .get_all_display_counts_under(&dir.to_string_lossy())
            .map_err(|e| format!("Failed to get display stats: {e}")),
        None => Ok(Vec::new()),
    }
}
