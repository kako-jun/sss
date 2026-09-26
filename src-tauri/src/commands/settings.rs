use crate::commands::types::AppState;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

/// 設定を保存
#[tauri::command]
pub fn save_setting(
    app: AppHandle,
    state: State<AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_setting(&key, &value)
        .map_err(|e| format!("Failed to save setting: {e}"))?;
    drop(db);

    // ピック先ディレクトリが変更された場合、次回起動を待たずに asset scope へ許可する
    // （「ピック済み」タブのサムネイル表示に必要）
    if key == "share_directory_path" {
        if let Err(e) = app
            .asset_protocol_scope()
            .allow_directory(Path::new(&value), true)
        {
            eprintln!("Failed to allow asset scope for {value}: {e}");
        }
    }

    Ok(())
}

/// 設定を取得
#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_setting(&key)
        .map_err(|e| format!("Failed to get setting: {e}"))
}

/// 最後に選択したディレクトリパスを取得
#[tauri::command]
pub async fn get_last_directory_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let path = db
        .get_setting("last_directory_path")
        .map_err(|e| format!("Database error: {e}"))?;
    Ok(path)
}
