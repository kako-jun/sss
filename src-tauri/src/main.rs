// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod database;
mod ignore;
mod image_processor;
mod playlist;
mod scanner;

use commands::AppState;
use database::Database;
use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // データベースパスを取得
            let app_data_dir = app
                .path_resolver()
                .app_data_dir()
                .expect("failed to get app data directory");

            // ディレクトリが存在しない場合は作成
            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data directory");

            let db_path = app_data_dir.join("sss.db");
            println!("Database path: {:?}", db_path);

            // キャッシュディレクトリを削除して再作成（起動時にクリア）
            let cache_dir = app_data_dir.join("cache");
            if cache_dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&cache_dir) {
                    eprintln!("Failed to remove cache directory: {}", e);
                }
            }
            std::fs::create_dir_all(&cache_dir).expect("failed to create cache directory");
            println!("Cache directory cleared and created: {:?}", cache_dir);

            // データベースを初期化
            let db = Database::new(db_path).expect("failed to initialize database");

            // アプリケーション状態を設定
            app.manage(AppState {
                db: Mutex::new(db),
                playlist: Mutex::new(None),
                folder_path: Mutex::new(None),
                cache_dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folder,
            commands::init_playlist,
            commands::get_next_image,
            commands::get_previous_image,
            commands::open_in_explorer,
            commands::get_stats,
            commands::get_playlist_info,
            commands::get_last_folder_path,
            commands::exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
