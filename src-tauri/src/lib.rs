//! sss バックエンドのライブラリ本体。
//!
//! Tauri アプリの起動 (`run`) と、スライドショーの芯となるモジュール群
//! (scanner / playlist / ignore / image_processor / database / commands) を公開する。
//! `main.rs` (bin) はこの `run()` を呼ぶだけの薄い殻で、結合テスト
//! (`tests/golden_e2e.rs`) はここで公開した芯を直接叩いて golden path を機械検証する。

pub mod asset_scope;
pub mod cache_worker;
pub mod commands;
pub mod database;
pub mod ignore;
pub mod image_processor;
pub mod pick;
pub mod playlist;
pub mod scanner;
pub mod thumbnail;

use asset_scope::{sanitize_allow_dir, startup_allow_dirs};
use cache_worker::CacheWorker;
use commands::file_operations::get_picked_directory;
use commands::AppState;
use database::Database;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Tauri アプリを起動する。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        // #78: ウィンドウ状態（全画面/ウィンドウ・位置・サイズ・装飾）を終了時に保存し、
        // 起動時に復元する。VISIBLE は対象外（非表示のまま復元される事故を避ける）。
        // 保存先ディスプレイが外れていれば位置は復元されずOSの既定位置に出る
        // （プラグイン側が実在モニタとの交差を確認する）。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 2つ目のインスタンス起動時は、新規ウィンドウを作らず既存ウィンドウへフォーカスする
            // （最小化されていた場合は unminimize() してから show/focus しないと前面に出てこない）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // スクリーンセーバーとディスプレイスリープを抑制（クロスプラットフォーム対応）
            // sleep(false)によりノートPC蓋閉じ時のシステムスリープは許可。
            // D-Bus が無い環境（一部のLinux等）では初期化に失敗しうるが、
            // スクリーンセーバー抑制が使えないだけでアプリ自体は起動を続ける。
            let keep_awake = keepawake::Builder::default()
                .display(true) // ディスプレイをオンに保つ（スライドショー表示のため）
                .idle(true) // アイドルスリープを防ぐ
                .sleep(false) // 明示的なスリープは許可（ノートPC蓋閉じ時など）
                .reason("Slideshow running")
                .app_name("Smart Slide Show")
                .create()
                .map_err(|e| {
                    eprintln!("Failed to initialize keep awake, continuing without it: {e}");
                })
                .ok();

            // データベースパスを取得
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data directory");

            // ディレクトリが存在しない場合は作成
            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data directory");

            let db_path = app_data_dir.join("sss.db");

            // キャッシュディレクトリ（asset scope 許可のため #59 以降ずっと
            // このパスに存在させ続ける必要がある）。
            let cache_dir = app_data_dir.join("cache");

            // 起動時のキャッシュクリア（#60）。旧実装は起動時に同期 remove_dir_all して
            // いたため、10万ファイル級のキャッシュが溜まっていると起動が遅延した。
            // cache_worker::clear_cache_dir が rename→再作成でこれを解決する
            // （詳細はその関数のドキュメントを参照。must5/should(4)/should(5)）。
            cache_worker::clear_cache_dir(&app_data_dir, &cache_dir);

            // データベースを初期化
            let db = Database::new(db_path).expect("failed to initialize database");

            // asset scope（convertFileSrc が読み込めるディレクトリ）を動的に許可する。
            // tauri.conf.json の静的 scope は空にしてあるため、表示に必要な全ディレクトリを
            // こことスキャン系コマンド（select_and_scan / rescan_last_directory）の両方で明示的に
            // 許可する（起動直後の3経路: 手動スキャン・起動時自動スキャンはスキャン側、
            // DB保存済みディレクトリの即時許可はここ）。
            //
            // sanitize_allow_dir() を必ず通す: 空文字列や相対パス・ホームドライブのルートを
            // そのまま allow_directory に渡すと、tauri の scope 実装が意図せず広いパターン
            // （最悪 "/**" 相当）を生成しうるため（レビュー #73 M1）。
            //
            // last_directory_path だけでなく scan_history の distinct directory_path も
            // まとめて候補にする（履歴タブに残る他ディレクトリの画像も表示できるように。
            // レビュー #73 should2）。
            let mut scanned_directories: Vec<PathBuf> = db
                .get_distinct_scan_directories()
                .unwrap_or_default()
                .into_iter()
                .map(PathBuf::from)
                .collect();
            if let Some(last) = db.get_setting("last_directory_path").ok().flatten() {
                let last = PathBuf::from(last);
                if !scanned_directories.contains(&last) {
                    scanned_directories.push(last);
                }
            }
            // ホームディレクトリが解決できない環境ではピック先は諦め、キャッシュ・スキャン履歴
            // だけでも許可を続ける
            let share_directory = get_picked_directory(&db).ok();

            let scope = app.asset_protocol_scope();
            for dir in
                startup_allow_dirs(&cache_dir, share_directory.as_deref(), &scanned_directories)
            {
                match sanitize_allow_dir(&dir) {
                    Some(safe_dir) => {
                        if let Err(e) = scope.allow_directory(&safe_dir, true) {
                            eprintln!(
                                "Failed to allow asset scope for {}: {e}",
                                safe_dir.display()
                            );
                        }
                    }
                    None => {
                        crate::asset_scope::log_refused_allow_dir(&dir);
                    }
                }
            }

            // 画像最適化キャッシュ用の単一ワーカースレッドを起動（#60）
            let cache_worker = CacheWorker::spawn(cache_dir.clone());

            // アプリケーション状態を設定
            app.manage(AppState {
                db: Mutex::new(db),
                playlist: Mutex::new(None),
                directory_path: Mutex::new(None),
                cache_dir,
                cache_worker,
                _keep_awake: keep_awake,
                scan_in_progress: std::sync::atomic::AtomicBool::new(false),
                last_incremented_display: Mutex::new(None),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan::select_and_scan,
            commands::scan::rescan_last_directory,
            commands::scan::restore_playlist,
            commands::image::get_next_image,
            commands::image::get_previous_image,
            commands::image::undo_display_count,
            commands::file_operations::open_in_explorer,
            commands::stats::get_playlist_info,
            commands::settings::get_last_directory_path,
            commands::system::exit_app,
            commands::system::reset_all_data,
            commands::settings::save_setting,
            commands::settings::select_share_directory,
            commands::settings::get_setting,
            commands::file_operations::pick_image,
            commands::file_operations::exclude_image,
            commands::file_operations::undo_exclude,
            commands::stats::get_display_stats,
            commands::file_operations::get_default_share_directory,
            commands::file_operations::get_share_directory,
            commands::file_operations::get_ignore_patterns,
            commands::file_operations::remove_ignore_pattern,
            commands::file_operations::add_ignore_pattern,
            commands::file_operations::get_recent_images,
            commands::file_operations::get_picked_images,
            commands::file_operations::delete_picked_image,
            commands::file_operations::get_thumbnail,
            commands::file_operations::reset_all_display_counts,
            commands::settings::get_os_locale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
