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
    //
    // アプリ稼働中に呼ばれるため、中身を1件ずつ削除するとワーカーの新規書込と競合しうる
    // （レビュー must5 と同じ理由。起動時クリアと同様、rename→再作成でレースを避ける）。
    if cache_dir.exists() {
        let trash_dir = app_data_dir.join(format!(
            "cache-trash-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        match std::fs::rename(&cache_dir, &trash_dir) {
            Ok(()) => {
                std::thread::spawn(move || {
                    if let Err(e) = std::fs::remove_dir_all(&trash_dir) {
                        eprintln!(
                            "Failed to remove stale cache trash {}: {e}",
                            trash_dir.display()
                        );
                    }
                });
            }
            Err(e) => {
                eprintln!("Failed to move cache directory to trash for reset: {e}");
            }
        }
        if let Err(e) = std::fs::create_dir_all(&cache_dir) {
            eprintln!("Failed to recreate cache directory after reset: {e}");
        }
    }

    Ok(())
}
