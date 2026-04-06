use crate::commands::types::AppState;
use crate::ignore::IgnoreFilter;
use crate::image_processor::get_exif_info;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

#[derive(serde::Serialize)]
pub struct RecentImage {
    pub path: String,
    pub display_count: i32,
    pub last_displayed: String,
}

/// デフォルトのシェアディレクトリパスを取得
#[tauri::command]
pub async fn get_default_share_directory() -> Result<String, String> {
    let pictures_dir = if cfg!(windows) {
        std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
    } else {
        std::env::var("HOME").map(|p| PathBuf::from(p).join("Pictures"))
    }
    .map_err(|_| "Failed to get home directory".to_string())?;

    let share_directory = pictures_dir.join("sss");
    Ok(share_directory.to_str().unwrap_or("").to_string())
}

/// ファイラで画像を選択状態で開く（OS別）
#[tauri::command]
pub async fn open_in_explorer(image_path: String) -> Result<(), String> {
    // チルダ（~）を展開
    let expanded_path = if image_path.starts_with("~/") || image_path == "~" {
        let home = dirs::home_dir().ok_or("Failed to get home directory")?;
        if image_path == "~" {
            home
        } else {
            home.join(&image_path[2..])
        }
    } else {
        PathBuf::from(&image_path)
    };

    let path = expanded_path.as_path();

    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    let image_path = path.to_str().ok_or("Invalid path")?.to_string();

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
        let directory = path.parent().ok_or("Failed to get parent directory")?;

        let result = Command::new("nautilus")
            .args(["--select", &image_path])
            .spawn();

        if result.is_err() {
            let result = Command::new("dolphin")
                .args(["--select", &image_path])
                .spawn();

            if result.is_err() {
                Command::new("xdg-open")
                    .arg(directory)
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

/// ピック機能：画像をPictures/sss-pickedフォルダにコピー
#[tauri::command]
pub async fn pick_image(image_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let source_path = Path::new(&image_path);

    if !source_path.exists() {
        return Err("Image file does not exist".to_string());
    }

    // コピー先ディレクトリを取得（設定から、なければデフォルト）
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let share_directory = match db
        .get_setting("share_directory_path")
        .map_err(|e| e.to_string())?
    {
        Some(path) => PathBuf::from(path),
        None => {
            // デフォルト: Pictures/sss-picked
            let pictures_dir = if cfg!(windows) {
                std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
            } else {
                std::env::var("HOME").map(|p| PathBuf::from(p).join("Pictures"))
            }
            .map_err(|_| "Failed to get home directory".to_string())?;

            pictures_dir.join("sss-picked")
        }
    };
    drop(db);

    // ディレクトリが存在しない場合は作成
    if !share_directory.exists() {
        fs::create_dir_all(&share_directory)
            .map_err(|e| format!("Failed to create share directory: {}", e))?;
    }

    // ファイル名を取得
    let file_name = source_path.file_name().ok_or("Failed to get file name")?;

    let dest_path = share_directory.join(file_name);

    // 重複チェック：同名ファイルがある場合はタイムスタンプを付与
    let final_dest_path = if dest_path.exists() {
        let stem = dest_path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = dest_path.extension().unwrap_or_default().to_string_lossy();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        share_directory.join(format!("{}_{}.{}", stem, timestamp, ext))
    } else {
        dest_path
    };

    // ファイルをコピー
    fs::copy(&source_path, &final_dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;

    Ok(final_dest_path.to_string_lossy().to_string())
}

/// 除外ルール一覧を取得
#[tauri::command]
pub async fn get_ignore_patterns(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.get_ignore_rules()
        .map_err(|e| format!("Failed to get ignore rules: {}", e))
}

/// 除外ルールを削除
#[tauri::command]
pub async fn remove_ignore_pattern(
    pattern: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.remove_ignore_rule(&pattern)
        .map_err(|e| format!("Failed to remove ignore rule: {}", e))
}

/// 除外ルールを手動追加
#[tauri::command]
pub async fn add_ignore_pattern(pattern: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.add_ignore_rule(&pattern)
        .map_err(|e| format!("Failed to add ignore rule: {}", e))
}

/// 除外機能：画像をDBのignore_rulesに追加
#[tauri::command]
pub async fn exclude_image(
    image_path: String,
    exclude_type: String, // "date", "file", "directory"
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = Path::new(&image_path);

    if !path.exists() {
        return Err("Image file does not exist".to_string());
    }

    let pattern = match exclude_type.as_str() {
        "date" => {
            // EXIFから日付を取得
            match get_exif_info(path) {
                Ok(exif) => {
                    if let Some(date_time) = exif.date_time {
                        // "YYYY:MM:DD HH:MM:SS" から "YYYY-MM-DD" を抽出
                        let date_part = date_time.split(' ').next().unwrap_or("");
                        let date = date_part.replace(':', "-");
                        format!("*{}*", date)
                    } else {
                        return Err("No EXIF date found".to_string());
                    }
                }
                Err(_) => return Err("Failed to read EXIF data".to_string()),
            }
        }
        "file" => {
            // ファイル名パターン
            path.to_string_lossy().to_string()
        }
        "directory" => {
            // ディレクトリパターン
            if let Some(parent) = path.parent() {
                format!("{}/*", parent.to_string_lossy())
            } else {
                return Err("Failed to get parent directory".to_string());
            }
        }
        _ => return Err("Invalid exclude type".to_string()),
    };

    // DB に除外ルールを追加
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.add_ignore_rule(&pattern)
        .map_err(|e| format!("Failed to add ignore rule: {}", e))?;
    drop(db);

    // プレイリストから該当画像を削除（ファイル除外の場合のみ即座に削除）
    if exclude_type == "file" {
        let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut playlist) = *playlist_lock {
            playlist.update_images(vec![], vec![image_path.clone()]);
        }
        drop(playlist_lock);
        Ok(format!("除外パターン追加: {}", pattern))
    } else {
        // 日付・ディレクトリ除外は再スキャンが必要
        Ok(format!(
            "除外パターン追加: {} (変更を反映するには再スキャンしてください)",
            pattern
        ))
    }
}

/// 最近表示した画像一覧を取得（最新100件、除外済み除く）
#[tauri::command]
pub async fn get_recent_images(state: State<'_, AppState>) -> Result<Vec<RecentImage>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());

    // 除外パターンを取得してフィルタを構築
    let patterns = db
        .get_ignore_rules()
        .map_err(|e| format!("Failed to get ignore rules: {}", e))?;
    let ignore_filter = IgnoreFilter::from_patterns(&patterns);

    // 最近表示した画像を多めに取得（除外フィルタ後に100件になるよう余裕を持つ）
    let all_recent = db
        .get_recent_images(200)
        .map_err(|e| format!("Failed to get recent images: {}", e))?;
    drop(db);

    // 除外パターンにマッチしないものだけ返す（最大100件）
    let filtered: Vec<RecentImage> = all_recent
        .into_iter()
        .filter(|(path, _, _)| !ignore_filter.is_ignored(Path::new(path)))
        .take(100)
        .map(|(path, display_count, last_displayed)| RecentImage {
            path,
            display_count,
            last_displayed,
        })
        .collect();

    Ok(filtered)
}

/// ピック済みフォルダのパスを取得するヘルパー
fn get_picked_directory(db: &crate::database::Database) -> Result<PathBuf, String> {
    match db
        .get_setting("share_directory_path")
        .map_err(|e| e.to_string())?
    {
        Some(path) => Ok(PathBuf::from(path)),
        None => {
            let pictures_dir = if cfg!(windows) {
                std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
            } else {
                std::env::var("HOME").map(|p| PathBuf::from(p).join("Pictures"))
            }
            .map_err(|_| "Failed to get home directory".to_string())?;

            Ok(pictures_dir.join("sss-picked"))
        }
    }
}

/// ピック済み画像一覧を取得（sss-pickedフォルダをスキャン）
#[tauri::command]
pub async fn get_picked_images(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let picked_dir = get_picked_directory(&db)?;
    drop(db);

    if !picked_dir.exists() {
        return Ok(Vec::new());
    }

    let image_extensions = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

    let mut images: Vec<String> = Vec::new();
    let entries =
        fs::read_dir(&picked_dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if image_extensions
                    .iter()
                    .any(|e| ext.to_ascii_lowercase() == *e)
                {
                    images.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    images.sort();
    Ok(images)
}

/// ピック済み画像を削除
#[tauri::command]
pub async fn delete_picked_image(
    image_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let picked_dir = get_picked_directory(&db)?;
    drop(db);

    let path = Path::new(&image_path);

    // 安全チェック: sss-picked フォルダ内のファイルのみ削除可能
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;
    let canonical_dir = picked_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve picked directory: {}", e))?;

    if !canonical_path.starts_with(&canonical_dir) {
        return Err("Cannot delete files outside the picked directory".to_string());
    }

    fs::remove_file(path).map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(())
}

/// 全画像の表示回数をリセット
#[tauri::command]
pub async fn reset_all_display_counts(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.reset_all_display_counts()
        .map_err(|e| format!("Failed to reset display counts: {}", e))
}
