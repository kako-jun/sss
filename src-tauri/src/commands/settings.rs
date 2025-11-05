use crate::commands::types::AppState;
use tauri::State;

/// 設定を保存
#[tauri::command]
pub fn save_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_setting(&key, &value)
        .map_err(|e| format!("Failed to save setting: {}", e))
}

/// 設定を取得
#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_setting(&key)
        .map_err(|e| format!("Failed to get setting: {}", e))
}

/// 最後に選択したフォルダパスを取得
#[tauri::command]
pub async fn get_last_folder_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    let path = db
        .get_setting("last_folder_path")
        .map_err(|e| format!("Database error: {}", e))?;
    Ok(path)
}
