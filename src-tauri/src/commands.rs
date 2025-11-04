use crate::database::Database;
use crate::image_processor::{get_exif_info, get_image_dimensions, ImageInfo};
use crate::playlist::Playlist;
use crate::scanner::ImageScanner;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub db: Mutex<Database>,
    pub playlist: Mutex<Option<Playlist>>,
    pub folder_path: Mutex<Option<PathBuf>>,
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
) -> Result<ScanProgress, String> {
    let folder = PathBuf::from(&folder_path);

    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    // .sssignoreのパス
    let sssignore_path = folder.join(".sssignore");

    // スキャナーを作成
    let scanner = ImageScanner::new(&sssignore_path);

    // データベースから前回のファイルメタデータを取得
    let db = state.db.lock().unwrap();
    let previous_files = db.get_all_file_metadata().unwrap_or_default();
    drop(db);

    // 差分スキャンを実行
    let scan_result = scanner.scan_folder_incremental(&folder, previous_files)?;

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
    *state.folder_path.lock().unwrap() = Some(folder);

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
        if let Some(image_path) = playlist.advance() {
            let path_str = image_path.clone();
            drop(playlist_lock);

            // 表示回数を増やす
            let db = state.db.lock().unwrap();
            let _ = db.increment_display_count(&path_str);
            drop(db);

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
        if !playlist.can_go_back() {
            return Ok(None);
        }

        if let Some(image_path) = playlist.go_back() {
            let path_str = image_path.clone();
            drop(playlist_lock);

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

    // ファイルサイズ
    let file_size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    // 画像サイズ
    let (width, height) = get_image_dimensions(path).unwrap_or((0, 0));

    // EXIF情報
    let exif = get_exif_info(path).ok();

    // データベースから統計情報を取得
    let db = state.db.lock().unwrap();
    let (display_count, last_displayed) = db.get_image_stats(image_path).unwrap_or((0, None));
    drop(db);

    Ok(Some(ImageInfo {
        path: image_path.to_string(),
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

/// 現在のプレイリスト状態を取得
#[tauri::command]
pub async fn get_playlist_info(state: State<'_, AppState>) -> Result<Option<(usize, usize)>, String> {
    let playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref playlist) = *playlist_lock {
        Ok(Some((playlist.current_position(), playlist.total_count())))
    } else {
        Ok(None)
    }
}
