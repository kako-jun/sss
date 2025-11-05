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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|_app, argv, cwd| {
            println!("Already running instance detected");
            println!("Args: {:?}, CWD: {:?}", argv, cwd);
        }))
        .setup(|app| {
            // スクリーンセーバーとディスプレイスリープを抑制（クロスプラットフォーム対応）
            // sleep(false)によりノートPC蓋閉じ時のシステムスリープは許可
            let keep_awake = keepawake::Builder::default()
                .display(true) // ディスプレイをオンに保つ（スライドショー表示のため）
                .idle(true) // アイドルスリープを防ぐ
                .sleep(false) // 明示的なスリープは許可（ノートPC蓋閉じ時など）
                .reason("Slideshow running")
                .app_name("Smart Slide Show")
                .create()
                .expect("Failed to initialize keep awake");
            println!("Screen saver prevention enabled (system sleep allowed)");

            // データベースパスを取得
            let app_data_dir = app
                .path()
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
                _keep_awake: keep_awake,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan::scan_folder,
            commands::scan::init_playlist,
            commands::image::get_next_image,
            commands::image::get_previous_image,
            commands::file_operations::open_in_explorer,
            commands::stats::get_stats,
            commands::stats::get_playlist_info,
            commands::settings::get_last_folder_path,
            commands::system::exit_app,
            commands::settings::save_setting,
            commands::settings::get_setting,
            commands::file_operations::share_image,
            commands::file_operations::exclude_image,
            commands::stats::get_display_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
