use crate::commands::types::AppState;
use crate::image_processor::get_exif_info;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

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

/// シェアマーク機能：画像をPictures/sssフォルダにコピー
#[tauri::command]
pub async fn share_image(image_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let source_path = Path::new(&image_path);

    if !source_path.exists() {
        return Err("Image file does not exist".to_string());
    }

    // コピー先ディレクトリを取得（設定から、なければデフォルト）
    let db = state.db.lock().unwrap();
    let share_directory = match db
        .get_setting("share_directory_path")
        .map_err(|e| e.to_string())?
    {
        Some(path) => PathBuf::from(path),
        None => {
            // デフォルト: Pictures/sss
            let pictures_dir = if cfg!(windows) {
                std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
            } else {
                std::env::var("HOME").map(|p| PathBuf::from(p).join("Pictures"))
            }
            .map_err(|_| "Failed to get home directory".to_string())?;

            pictures_dir.join("sss")
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
        let stem = dest_path.file_stem().unwrap().to_string_lossy();
        let ext = dest_path.extension().unwrap_or_default().to_string_lossy();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        share_directory.join(format!("{}_{}.{}", stem, timestamp, ext))
    } else {
        dest_path
    };

    // ファイルをコピー
    fs::copy(&source_path, &final_dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;

    Ok(final_dest_path.to_string_lossy().to_string())
}

/// 除外機能：画像を.sssignoreに追加
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

    // .sssignoreのパス
    let ignore_path = if cfg!(windows) {
        std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join(".sssignore"))
    } else {
        std::env::var("HOME").map(|p| PathBuf::from(p).join(".sssignore"))
    }
    .map_err(|_| "Failed to get home directory".to_string())?;

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

    // .sssignoreに追記
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ignore_path)
        .map_err(|e| format!("Failed to open .sssignore: {}", e))?;

    writeln!(file, "{}", pattern).map_err(|e| format!("Failed to write to .sssignore: {}", e))?;

    // プレイリストから該当画像を削除（ファイル除外の場合のみ即座に削除）
    if exclude_type == "file" {
        let mut playlist_lock = state.playlist.lock().unwrap();
        if let Some(ref mut playlist) = *playlist_lock {
            playlist.update_images(vec![], vec![image_path.clone()]);
            println!("Removed {} from playlist", image_path);
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
