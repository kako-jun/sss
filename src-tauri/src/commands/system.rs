use tauri::{AppHandle, Manager};

/// アプリケーションを終了
#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}

/// すべての設定とデータを初期化（データベースとキャッシュを削除）
#[tauri::command]
pub async fn reset_all_data(app: AppHandle) -> Result<(), String> {
    // データベースファイルのパスを取得
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let db_path = app_data_dir.join("sss.db");
    let cache_dir = app_data_dir.join("cache");

    // データベースファイルを削除
    if db_path.exists() {
        std::fs::remove_file(&db_path)
            .map_err(|e| format!("Failed to delete database: {}", e))?;
    }

    // キャッシュディレクトリを削除
    if cache_dir.exists() {
        std::fs::remove_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to delete cache directory: {}", e))?;
    }

    Ok(())
}
