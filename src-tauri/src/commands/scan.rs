use crate::asset_scope::sanitize_allow_dir;
use crate::commands::types::{AppState, ScanProgress};
use crate::ignore::{IgnoreFilter, IgnoreRule, RuleType};
use crate::playlist::Playlist;
use crate::scanner::ImageScanner;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

/// `.sssignore` 移行が完了済みかどうかを記録する `app_settings` のキー。
/// 一度でも移行処理を試みた（ファイルの有無に関わらず）後は二度と実行しない
/// （#61: 毎スキャン走ってしまい `.sssignore.bak` を上書きし続けるバグの修正）。
const SSSIGNORE_MIGRATED_KEY: &str = "sssignore_migrated";

/// ~/.sssignore が存在する場合、内容を DB にインポートして .sssignore.bak にリネームする。
/// **1回限り**: `app_settings.sssignore_migrated` が立っていれば即座に何もしない。
/// ファイルが存在しなかった場合も含め、実行後は必ずフラグを立てる（再訪しない）。
fn migrate_sssignore_to_db(db: &crate::database::Database) {
    if matches!(db.get_setting(SSSIGNORE_MIGRATED_KEY), Ok(Some(_))) {
        return;
    }

    let home_dir = if cfg!(windows) {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    } else {
        std::env::var("HOME").ok().map(PathBuf::from)
    };

    if let Some(home_dir) = home_dir {
        let sssignore_path = home_dir.join(".sssignore");

        if sssignore_path.exists() {
            match std::fs::read_to_string(&sssignore_path) {
                Ok(content) => {
                    for line in content.lines() {
                        let line = line.trim();
                        // コメントと空行をスキップ
                        if line.is_empty() || line.starts_with('#') {
                            continue;
                        }
                        if let Err(e) = db.add_ignore_rule(line, RuleType::Glob) {
                            eprintln!("Failed to import ignore rule '{line}': {e}");
                        }
                    }

                    // .sssignore を .sssignore.bak にリネーム
                    let bak_path = home_dir.join(".sssignore.bak");
                    if let Err(e) = std::fs::rename(&sssignore_path, &bak_path) {
                        eprintln!("Failed to rename .sssignore to .sssignore.bak: {e}");
                    }
                }
                Err(e) => {
                    eprintln!("Failed to read .sssignore for migration: {e}");
                }
            }
        }
    }

    // ファイルが無かった場合も含め、二度と実行しないようフラグを立てる
    if let Err(e) = db.save_setting(SSSIGNORE_MIGRATED_KEY, "1") {
        eprintln!("Failed to persist sssignore migration flag: {e}");
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

    if !directory.is_dir() {
        return Err(format!(
            "Directory does not exist or is not a directory: {directory_path}"
        ));
    }

    // asset scope（convertFileSrc が読み込めるディレクトリ）にスキャン対象を動的に許可する。
    // 手動スキャン・起動時自動スキャンはどちらもこのコマンドを通るため、ここ1箇所で両方をカバーする。
    // sanitize_allow_dir() で is_dir・絶対パス・非保護ルートを再検証してから allow する
    // （空文字列/相対パスが紛れ込んで意図せず広い scope になる事故を防ぐ、レビュー #73 M1）。
    // 拒否された場合はスキャンしても画像が一切表示できないため、ここで Err を返して
    // UI にエラー理由を伝える（黙って続行し原因不明のまま表示できない、を防ぐ。should1）。
    let safe_dir = sanitize_allow_dir(&directory).ok_or_else(|| {
        format!(
            "Cannot use this directory for security reasons (e.g. a system drive root): {directory_path}"
        )
    })?;
    if let Err(e) = app.asset_protocol_scope().allow_directory(&safe_dir, true) {
        eprintln!(
            "Failed to allow asset scope for {}: {e}",
            safe_dir.display()
        );
    }

    // マイグレーション処理：~/.sssignore が存在する場合は DB にインポート
    {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        migrate_sssignore_to_db(&db);
    }

    // データベースから前回のファイルメタデータ（撮影日込み）を取得
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let previous_files_with_dates = db.get_all_file_metadata().unwrap_or_default();

    // DB から除外ルールを取得して IgnoreFilter を作成。撮影日除外ルールは、表示時に
    // EXIFから取得しDBに保存済みの撮影日（上で取得した previous_files_with_dates 由来）を
    // 最優先に使う。未取得の画像はパス文字列中の日付でフォールバック判定する（ignore.rs）。
    let rules: Vec<IgnoreRule> = db
        .get_ignore_rules()
        .unwrap_or_default()
        .into_iter()
        .map(|(pattern, rule_type)| IgnoreRule { pattern, rule_type })
        .collect();
    drop(db);

    let captured_dates: HashMap<String, String> = previous_files_with_dates
        .iter()
        .filter_map(|(path, _, _, captured_date)| captured_date.clone().map(|d| (path.clone(), d)))
        .collect();
    let ignore_filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured_dates);

    // スキャナーを作成
    let scanner = ImageScanner::new(ignore_filter);

    // scanner が使う差分検出用の前回スナップショット（撮影日は上で別途使用済みのため落とす）
    let previous_files: Vec<(String, i64, i64)> = previous_files_with_dates
        .into_iter()
        .map(|(path, mtime, size, _)| (path, mtime, size))
        .collect();

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
            .map_err(|e| format!("Database error: {e}"))?;
    }

    // 削除されたファイルをマーク
    if !scan_result.deleted_files.is_empty() {
        db.mark_deleted(&scan_result.deleted_files)
            .map_err(|e| format!("Database error: {e}"))?;
    }

    // スキャン履歴を記録
    db.record_scan_history(
        &directory_path,
        scan_result.total_count as i32,
        scan_result.new_count as i32,
        scan_result.deleted_count as i32,
        scan_result.duration_ms as i64,
    )
    .map_err(|e| format!("Database error: {e}"))?;

    // スキャン履歴の上限管理（100件超を削除）
    db.trim_scan_history(100)
        .map_err(|e| format!("Database error: {e}"))?;

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
