use tauri::{AppHandle, Manager};

/// アプリケーションを終了（DB書き込み完了を待ってから安全に終了）
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// すべての設定とデータを初期化（データベースとキャッシュを削除）
#[tauri::command]
pub async fn reset_all_data(app: AppHandle) -> Result<(), String> {
    // データベースファイルのパスを取得
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let db_path = app_data_dir.join("sss.db");
    let cache_dir = app_data_dir.join("cache");

    // データベースファイルを削除
    if db_path.exists() {
        std::fs::remove_file(&db_path).map_err(|e| format!("Failed to delete database: {e}"))?;
    }

    // キャッシュの中身を削除する（ディレクトリ自体は残す）。
    // #60: cache_dir は起動時に asset scope へ許可済みで、実行中の CacheWorker も
    // このパスへ書き続けるため、ディレクトリ自体を消すと以後のキャッシュ書込が失敗する。
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(e) = result {
                eprintln!("Failed to remove cache entry {}: {e}", path.display());
            }
        }
    }

    Ok(())
}
