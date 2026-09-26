use crate::cache_worker::clear_cache_dir;
use crate::commands::types::AppState;
use tauri::{AppHandle, Manager, State};

/// アプリケーションを終了（DB書き込み完了を待ってから安全に終了）
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// すべての設定とデータを初期化（データベースとキャッシュを削除）
#[tauri::command]
pub async fn reset_all_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
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

    // キャッシュの中身を削除する（ディレクトリ自体は残す。#60）。
    // cache_dir は起動時に asset scope へ許可済みで、実行中の CacheWorker もこの
    // パスへ書き続けるため、ディレクトリ自体を消すと以後のキャッシュ書込が失敗する。
    // アプリ稼働中に呼ばれるため中身を1件ずつ削除するとワーカーの新規書込と競合しうる。
    // 起動時クリアと同じ rename→再作成の手順（`clear_cache_dir`）でレースを避ける。
    clear_cache_dir(&app_data_dir, &cache_dir);

    // 失敗セットもクリアする（nit）。キャッシュを丸ごと作り直すのに、過去の失敗記録が
    // 居座って同じ画像が以後ずっと再試行されなくなるのを防ぐ。
    state.cache_worker.clear_failed();

    Ok(())
}
