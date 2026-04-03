use crate::commands::types::{AppState, ScanProgress};
use crate::playlist::Playlist;
use crate::scanner::ImageScanner;
use std::fs;
use std::path::PathBuf;
use tauri::{Emitter, State};

/// ディレクトリをスキャンしてプレイリストを初期化
#[tauri::command]
pub async fn scan_directory(
    directory_path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ScanProgress, String> {
    let directory = PathBuf::from(&directory_path);

    if !directory.exists() {
        return Err(format!("Directory does not exist: {}", directory_path));
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
        }
    }

    // スキャナーを作成
    let scanner = ImageScanner::new(&sssignore_path);

    // データベースから前回のファイルメタデータを取得
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let previous_files = db.get_all_file_metadata().unwrap_or_default();
    drop(db);

    // 差分スキャンを実行（進捗イベント付き）
    let scan_result = scanner.scan_directory_incremental_with_progress(
        &directory,
        previous_files,
        |current, total| {
            // 進捗イベントを発行
            let _ = app.emit(
                "scan-progress",
                serde_json::json!({
                    "current": current,
                    "total": total
                }),
            );
        },
    )?;

    // データベースを更新
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());

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
        &directory_path,
        scan_result.total_count as i32,
        scan_result.new_count as i32,
        scan_result.deleted_count as i32,
        scan_result.duration_ms as i64,
    )
    .map_err(|e| format!("Database error: {}", e))?;

    drop(db);

    // プレイリストを作成または更新
    let image_paths: Vec<String> = scan_result.files.iter().map(|f| f.path.clone()).collect();

    let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());

    // ディレクトリパスを確認
    let current_directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let is_same_directory = current_directory
        .as_ref()
        .map(|p| p == &directory)
        .unwrap_or(false);

    if is_same_directory && playlist_lock.is_some() {
        // 同じディレクトリの場合のみ既存のプレイリストを更新
        if let Some(ref mut playlist) = *playlist_lock {
            playlist.update_images(
                scan_result.new_files.clone(),
                scan_result.deleted_files.clone(),
            );
        }
    } else {
        // 別のディレクトリまたは初回の場合は新規プレイリストを作成
        *playlist_lock = Some(Playlist::new(image_paths));
    }

    drop(playlist_lock);

    // ディレクトリパスを保存
    *state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(directory.clone());

    // ディレクトリパスをデータベースに永続化
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = db.save_setting("last_directory_path", &directory_path);
    drop(db);

    Ok(ScanProgress {
        total_files: scan_result.total_count,
        new_files: scan_result.new_count,
        deleted_files: scan_result.deleted_count,
        duration_ms: scan_result.duration_ms,
    })
}
