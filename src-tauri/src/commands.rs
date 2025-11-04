use crate::database::Database;
use crate::image_processor::{get_exif_info, get_image_dimensions, optimize_image_for_4k, is_video_file, ImageInfo};
use crate::playlist::Playlist;
use crate::scanner::ImageScanner;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct AppState {
    pub db: Mutex<Database>,
    pub playlist: Mutex<Option<Playlist>>,
    pub folder_path: Mutex<Option<PathBuf>>,
    pub cache_dir: PathBuf,
    pub _keep_awake: keepawake::AwakeHandle,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub total_files: usize,
    pub new_files: usize,
    pub deleted_files: usize,
    pub duration_ms: u128,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_images: i32,
    pub displayed_images: i32,
}

/// フォルダをスキャンしてプレイリストを初期化
#[tauri::command]
pub async fn scan_folder(
    folder_path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ScanProgress, String> {
    let folder = PathBuf::from(&folder_path);

    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    // .sssignoreのパス（ユーザーホームディレクトリに保存）
    let home_dir = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .map_err(|_| "Failed to get home directory")?
    } else {
        std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| "Failed to get home directory")?
    };
    let sssignore_path = home_dir.join(".sssignore");

    // .sssignoreファイルが存在しない場合はデフォルトルールを作成
    if !sssignore_path.exists() {
        let default_content = r#"# Smart Slide Show (sss) - Default Ignore Rules
# このファイルはgitignore形式で除外ルールを記述します

# サムネイルキャッシュ
**/.thumbnails/
**/Thumbs.db
**/.DS_Store

# システムファイル
**/@eaDir/
**/desktop.ini

# 隠しフォルダ（Linuxの慣例）
**/.**/

# 例：特定のフォルダを除外
# **/private/
# **/2023-05-15/

# 例：特定のファイル名パターンを除外
# screenshot_*.png
# *_draft.jpg
"#;
        if let Err(e) = fs::write(&sssignore_path, default_content) {
            eprintln!("Failed to create default .sssignore: {}", e);
        } else {
            println!("Created default .sssignore file at {:?}", sssignore_path);
        }
    }

    // スキャナーを作成
    let scanner = ImageScanner::new(&sssignore_path);

    // データベースから前回のファイルメタデータを取得
    let db = state.db.lock().unwrap();
    let previous_files = db.get_all_file_metadata().unwrap_or_default();
    drop(db);

    // 差分スキャンを実行（進捗イベント付き）
    let scan_result = scanner.scan_folder_incremental_with_progress(
        &folder,
        previous_files,
        |current, total| {
            // 進捗イベントを発行
            let _ = app.emit_all(
                "scan-progress",
                serde_json::json!({
                    "current": current,
                    "total": total
                }),
            );
        },
    )?;

    // データベースを更新
    let db = state.db.lock().unwrap();

    // 新規ファイルを追加
    for file in &scan_result.files {
        db.upsert_file_metadata(&file.path, file.modified_time, file.file_size)
            .map_err(|e| format!("Database error: {}", e))?;
    }

    // 削除されたファイルをマーク
    if !scan_result.deleted_files.is_empty() {
        db.mark_deleted(&scan_result.deleted_files)
            .map_err(|e| format!("Database error: {}", e))?;
    }

    // スキャン履歴を記録
    db.record_scan_history(
        &folder_path,
        scan_result.total_count as i32,
        scan_result.new_count as i32,
        scan_result.deleted_count as i32,
        scan_result.duration_ms as i64,
    )
    .map_err(|e| format!("Database error: {}", e))?;

    drop(db);

    // プレイリストを作成または更新
    let image_paths: Vec<String> = scan_result.files.iter().map(|f| f.path.clone()).collect();

    let mut playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref mut playlist) = *playlist_lock {
        // 既存のプレイリストを更新
        playlist.update_images(scan_result.new_files.clone(), scan_result.deleted_files.clone());
    } else {
        // 新規プレイリストを作成
        *playlist_lock = Some(Playlist::new(image_paths));
    }

    // プレイリスト状態をDBに保存
    if let Some(ref playlist) = *playlist_lock {
        let state_data = playlist.get_state();
        let db = state.db.lock().unwrap();
        let _ = db.save_playlist_state(
            state_data.current_index as i32,
            &serde_json::to_string(&state_data.shuffled_list).unwrap(),
            false,
        );
    }

    drop(playlist_lock);

    // フォルダパスを保存
    *state.folder_path.lock().unwrap() = Some(folder.clone());

    // フォルダパスをデータベースに永続化
    let db = state.db.lock().unwrap();
    let _ = db.save_setting("last_folder_path", &folder_path);
    drop(db);

    Ok(ScanProgress {
        total_files: scan_result.total_count,
        new_files: scan_result.new_count,
        deleted_files: scan_result.deleted_count,
        duration_ms: scan_result.duration_ms,
    })
}

/// プレイリストを初期化（保存された状態から復元）
#[tauri::command]
pub async fn init_playlist(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    let playlist_state = db.get_playlist_state().map_err(|e| format!("Database error: {}", e))?;

    drop(db);

    if let Some((current_index, shuffled_list_json, _is_paused)) = playlist_state {
        let shuffled_list: Vec<String> = serde_json::from_str(&shuffled_list_json)
            .map_err(|e| format!("Failed to parse playlist: {}", e))?;

        if !shuffled_list.is_empty() {
            let playlist = Playlist::from_state(shuffled_list, current_index as usize);
            let current_image = playlist.current().map(|s| s.clone());

            *state.playlist.lock().unwrap() = Some(playlist);

            return Ok(current_image);
        }
    }

    Ok(None)
}

/// 次の画像を取得（カウント+1）
#[tauri::command]
pub async fn get_next_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    let mut playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref mut playlist) = *playlist_lock {
        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        if let Some(image_path) = playlist.advance() {
            let path_str = image_path.clone();

            // 5枚先までのパスを取得（先読み用）
            let mut prefetch_paths = Vec::new();
            for i in 1..=5 {
                if let Some(path) = playlist.peek_next_n(i) {
                    prefetch_paths.push(path.clone());
                }
            }

            drop(playlist_lock);

            // 5枚先まで先読みキャッシュ（バックグラウンドで直列処理）
            let cache_dir = state.cache_dir.clone();
            prefetch_and_cache_multiple(prefetch_paths, cache_dir);

            // 表示回数を増やす
            let db = state.db.lock().unwrap();
            let _ = db.increment_display_count(&path_str);
            drop(db);

            // プレイリスト状態を保存
            let playlist_lock = state.playlist.lock().unwrap();
            if let Some(ref playlist) = *playlist_lock {
                let state_data = playlist.get_state();
                let db = state.db.lock().unwrap();
                let _ = db.save_playlist_state(
                    state_data.current_index as i32,
                    &serde_json::to_string(&state_data.shuffled_list).unwrap(),
                    false,
                );
                drop(db);
            }
            drop(playlist_lock);

            // 画像情報を取得
            get_image_info_internal(&path_str, &state)
        } else {
            Ok(None)
        }
    } else {
        Err("Playlist not initialized".to_string())
    }
}

/// 前の画像を取得（カウント増やさない）
#[tauri::command]
pub async fn get_previous_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    let mut playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref mut playlist) = *playlist_lock {
        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        if !playlist.can_go_back() {
            return Ok(None);
        }

        if let Some(image_path) = playlist.go_back() {
            let path_str = image_path.clone();

            // プレイリスト状態を保存
            let state_data = playlist.get_state();
            drop(playlist_lock);

            let db = state.db.lock().unwrap();
            let _ = db.save_playlist_state(
                state_data.current_index as i32,
                &serde_json::to_string(&state_data.shuffled_list).unwrap(),
                false,
            );
            drop(db);

            // 画像情報を取得（カウントは増やさない）
            get_image_info_internal(&path_str, &state)
        } else {
            Ok(None)
        }
    } else {
        Err("Playlist not initialized".to_string())
    }
}

/// 画像情報を取得
fn get_image_info_internal(image_path: &str, state: &State<AppState>) -> Result<Option<ImageInfo>, String> {
    let path = Path::new(image_path);

    if !path.exists() {
        return Ok(None);
    }

    // 動画ファイルかどうかを判定
    let is_video = is_video_file(path);

    // ファイルサイズ
    let file_size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    // 画像サイズ（動画の場合は0x0）
    let (width, height) = if !is_video {
        get_image_dimensions(path).unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    // 4K最適化：画像が4K(3840x2160)を超える場合はリサイズしてキャッシュ（動画は除く）
    let optimized_path = if !is_video && (width > 3840 || height > 2160) {
        // キャッシュファイル名を生成（元のファイル名のハッシュを使用）
        let hash = format!("{:x}", md5::compute(image_path));
        let cache_file = state.cache_dir.join(format!("{}.jpg", hash));

        // キャッシュが存在しない場合は作成
        if !cache_file.exists() {
            match optimize_image_for_4k(path) {
                Ok(optimized_data) => {
                    if let Err(e) = fs::write(&cache_file, optimized_data) {
                        eprintln!("Failed to write optimized image: {}", e);
                        None
                    } else {
                        println!("Created optimized image: {:?}", cache_file);
                        Some(cache_file.to_string_lossy().to_string())
                    }
                }
                Err(e) => {
                    eprintln!("Failed to optimize image: {}", e);
                    None
                }
            }
        } else {
            Some(cache_file.to_string_lossy().to_string())
        }
    } else {
        None
    };

    // EXIF情報（画像のみ）
    let exif = if !is_video {
        match get_exif_info(path) {
            Ok(info) => {
                if let Some(ref dt) = info.date_time {
                    println!("EXIF info loaded for {} - DateTime: {}", image_path, dt);
                } else {
                    println!("EXIF info loaded for {} - No DateTime field", image_path);
                }
                Some(info)
            }
            Err(e) => {
                println!("Failed to get EXIF info for {}: {}", image_path, e);
                None
            }
        }
    } else {
        None
    };

    // データベースから統計情報を取得
    let db = state.db.lock().unwrap();
    let (display_count, last_displayed) = db.get_image_stats(image_path).unwrap_or((0, None));
    drop(db);

    Ok(Some(ImageInfo {
        path: image_path.to_string(),
        optimized_path,
        is_video,
        width,
        height,
        file_size,
        exif,
        display_count,
        last_displayed,
    }))
}

/// ファイラで画像を選択状態で開く（OS別）
#[tauri::command]
pub async fn open_in_explorer(image_path: String) -> Result<(), String> {
    let path = Path::new(&image_path);

    if !path.exists() {
        return Err(format!("File does not exist: {}", image_path));
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &image_path])
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try nautilus first (GNOME), then dolphin (KDE), then fallback to xdg-open
        let folder = path.parent().ok_or("Failed to get parent folder")?;

        let result = Command::new("nautilus")
            .args(["--select", &image_path])
            .spawn();

        if result.is_err() {
            let result = Command::new("dolphin")
                .args(["--select", &image_path])
                .spawn();

            if result.is_err() {
                Command::new("xdg-open")
                    .arg(folder)
                    .spawn()
                    .map_err(|e| format!("Failed to open file manager: {}", e))?;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &image_path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    Ok(())
}

/// 統計情報を取得
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<Stats, String> {
    let db = state.db.lock().unwrap();

    let total_images = db.get_total_image_count()
        .map_err(|e| format!("Database error: {}", e))?;

    let displayed_images = db.get_displayed_image_count()
        .map_err(|e| format!("Database error: {}", e))?;

    Ok(Stats {
        total_images,
        displayed_images,
    })
}

/// 現在のプレイリスト状態を取得 (position, total, canGoBack)
#[tauri::command]
pub async fn get_playlist_info(state: State<'_, AppState>) -> Result<Option<(usize, usize, bool)>, String> {
    let playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref playlist) = *playlist_lock {
        Ok(Some((
            playlist.current_position(),
            playlist.total_count(),
            playlist.can_go_back()
        )))
    } else {
        Ok(None)
    }
}

/// 最後に選択したフォルダパスを取得
#[tauri::command]
pub async fn get_last_folder_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    let path = db.get_setting("last_folder_path")
        .map_err(|e| format!("Database error: {}", e))?;
    Ok(path)
}

/// アプリケーションを終了
#[tauri::command]
pub fn exit_app() {
    std::process::exit(0);
}

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

/// 複数の画像を先読みしてキャッシュ作成（バックグラウンドで直列処理）
fn prefetch_and_cache_multiple(image_paths: Vec<String>, cache_dir: PathBuf) {
    use std::thread;

    thread::spawn(move || {
        for image_path in image_paths {
            let path = Path::new(&image_path);

            if !path.exists() {
                continue;
            }

            // 画像サイズを取得
            let (width, height) = match get_image_dimensions(path) {
                Ok(dims) => dims,
                Err(_) => continue,
            };

            // 4Kを超える場合のみキャッシュ作成
            if width > 3840 || height > 2160 {
                let hash = format!("{:x}", md5::compute(&image_path));
                let cache_file = cache_dir.join(format!("{}.jpg", hash));

                // キャッシュが既に存在する場合はスキップ
                if !cache_file.exists() {
                    match optimize_image_for_4k(path) {
                        Ok(optimized_data) => {
                            if let Err(e) = fs::write(&cache_file, optimized_data) {
                                eprintln!("Failed to write prefetched cache: {}", e);
                            } else {
                                println!("Prefetched and cached: {:?}", cache_file);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to optimize for prefetch: {}", e);
                        }
                    }
                }
            }
        }
    });
}
