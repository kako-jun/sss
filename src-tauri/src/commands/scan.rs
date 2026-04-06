use crate::commands::types::{AppState, ScanProgress};
use crate::ignore::IgnoreFilter;
use crate::playlist::Playlist;
use crate::scanner::ImageScanner;
use std::path::PathBuf;
use tauri::{Emitter, State};

/// ~/.sssignore が存在する場合、内容を DB にインポートして .sssignore.bak にリネーム
fn migrate_sssignore_to_db(db: &crate::database::Database) {
    let home_dir = if cfg!(windows) {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    } else {
        std::env::var("HOME").ok().map(PathBuf::from)
    };

    let home_dir = match home_dir {
        Some(p) => p,
        None => return,
    };

    let sssignore_path = home_dir.join(".sssignore");

    if !sssignore_path.exists() {
        return;
    }

    // ファイルを読み込んでパターンをDBにインポート
    match std::fs::read_to_string(&sssignore_path) {
        Ok(content) => {
            for line in content.lines() {
                let line = line.trim();
                // コメントと空行をスキップ
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Err(e) = db.add_ignore_rule(line) {
                    eprintln!("Failed to import ignore rule '{}': {}", line, e);
                }
            }

            // .sssignore を .sssignore.bak にリネーム
            let bak_path = home_dir.join(".sssignore.bak");
            if let Err(e) = std::fs::rename(&sssignore_path, &bak_path) {
                eprintln!("Failed to rename .sssignore to .sssignore.bak: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to read .sssignore for migration: {}", e);
        }
    }
}

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

    // マイグレーション処理：~/.sssignore が存在する場合は DB にインポート
    {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        migrate_sssignore_to_db(&db);
    }

    // DB から除外ルールを取得して IgnoreFilter を作成
    let patterns = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.get_ignore_rules().unwrap_or_default()
    };
    let ignore_filter = IgnoreFilter::from_patterns(&patterns);

    // スキャナーを作成
    let scanner = ImageScanner::new(ignore_filter);

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

    // スキャン履歴の上限管理（100件超を削除）
    db.trim_scan_history(100)
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
