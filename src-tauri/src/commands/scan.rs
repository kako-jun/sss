use crate::asset_scope::sanitize_allow_dir;
use crate::commands::types::{AppState, ScanProgress};
use crate::ignore::{IgnoreFilter, IgnoreRule, RuleType};
use crate::image_processor::{extract_date_only, get_exif_info};
use crate::playlist::Playlist;
use crate::scanner::{FileMetadata, ImageScanner};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

/// `.sssignore` 移行が完了済みかどうかを記録する `app_settings` のキー。
/// 一度でも移行処理を試みた（ファイルの有無に関わらず）後は二度と実行しない
/// （#61: 毎スキャン走ってしまい `.sssignore.bak` を上書きし続けるバグの修正）。
const SSSIGNORE_MIGRATED_KEY: &str = "sssignore_migrated";

/// 撮影日除外ルールの判定に使う `path → captured_date` マップを作る（#61レビュー M2）。
///
/// 呼び出し元は「撮影日ルールが1件以上ある」ことを確認してから呼ぶこと（無条件に
/// 呼ぶとルールが無くてもEXIFを読んでしまい、10万件規模でスキャンが遅くなる）。
///
/// - `exif_cache` に**新鮮な**（ファイルの現在のmtimeとキャッシュ時のmtimeが一致する）
///   撮影日があれば、それを最優先で使う（EXIFを読み直さない）。
/// - キャッシュが無い、またはファイルが変更されて古くなった候補だけ、rayon で並列に
///   EXIFを読み直し、結果を `exif_cache` へバッチ書き込みする。
fn resolve_captured_dates(
    db: &crate::database::Database,
    current_files: &[FileMetadata],
) -> HashMap<String, String> {
    let cache_entries = db.get_all_exif_cache().unwrap_or_default();
    let mut cache_by_path: HashMap<String, (Option<String>, i64)> = HashMap::new();
    for (path, date, mtime) in cache_entries {
        cache_by_path.insert(path, (date, mtime));
    }

    // 未取得 or mtime不一致（ファイル変更）の候補だけEXIFを読み直す
    let candidates: Vec<&FileMetadata> = current_files
        .iter()
        .filter(|f| {
            cache_by_path
                .get(&f.path)
                .map(|(_, cached_mtime)| *cached_mtime != f.modified_time)
                .unwrap_or(true)
        })
        .collect();

    let freshly_read: Vec<(String, Option<String>, i64)> = candidates
        .par_iter()
        .map(|f| {
            let date = get_exif_info(Path::new(&f.path))
                .ok()
                .and_then(|exif| exif.date_time.as_deref().and_then(extract_date_only));
            (f.path.clone(), date, f.modified_time)
        })
        .collect();

    if !freshly_read.is_empty() {
        if let Err(e) = db.upsert_exif_cache_batch(&freshly_read) {
            eprintln!("Failed to persist exif cache batch: {e}");
        }
    }

    let current_mtime_by_path: HashMap<&str, i64> = current_files
        .iter()
        .map(|f| (f.path.as_str(), f.modified_time))
        .collect();

    let mut captured_dates = HashMap::new();
    // 既存キャッシュのうち、ファイルの現在のmtimeと一致する（新鮮な）ものだけ採用
    for (path, (date, cached_mtime)) in &cache_by_path {
        if let (Some(d), Some(&current)) = (date, current_mtime_by_path.get(path.as_str())) {
            if *cached_mtime == current {
                captured_dates.insert(path.clone(), d.clone());
            }
        }
    }
    // 今回読み直したものを反映（キャッシュが古かった/無かった分の更新）
    for (path, date, _) in &freshly_read {
        if let Some(d) = date {
            captured_dates.insert(path.clone(), d.clone());
        }
    }

    captured_dates
}

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

/// スキャン〜DB反映〜プレイリスト反映の本体（Tauri非依存）。
///
/// `#[tauri::command] scan_directory` はこの関数を呼ぶだけの薄いシェルにする。
/// `State`/`AppHandle` に依存しないため、`tauri::test::mock_app()` すら要らず
/// 単体テストから直接呼べる（`AppHandle` は runtime ジェネリクスが `Wry` 固定で
/// `MockRuntime` を受け付けないため、コマンド本体を直接テストするのが難しい）。
///
/// #61レビュー M2/S1 の骨格:
/// 1. 生スキャン（除外ルール抜き）でディスク上の物理的な事実だけを集め、
///    `file_metadata` の新規/削除判定・スキャン履歴はこれだけを基準にする。
/// 2. 除外ルールの適用は別段階として行い、「プレイリストに含めるべき集合」を作る。
/// 3. プレイリストは「物理的な新規/削除」ではなく、現在のメンバーシップと
///    「含めるべき集合」の差分で更新する。除外ルールで対象外になったファイルも
///    物理削除されたファイルも同じ経路でプレイリストから外れるが、
///    `file_metadata`/`image_stats` は除外だけでは消えない。
pub fn perform_scan<F>(
    db: &crate::database::Database,
    playlist_slot: &mut Option<Playlist>,
    current_directory: Option<&Path>,
    directory: &Path,
    progress_callback: F,
) -> Result<ScanProgress, String>
where
    F: FnMut(usize, usize) + Send + Sync,
{
    // マイグレーション処理：~/.sssignore が存在する場合は DB にインポート
    migrate_sssignore_to_db(db);

    // データベースから前回のファイルメタデータ（ディスク上の物理的な事実のみ。
    // 撮影日は exif_cache に分離されているのでここには含まれない）を取得
    let previous_files = db.get_all_file_metadata().unwrap_or_default();

    // 生スキャン（除外ルールは一切適用しない。ディスク上の物理的な事実だけを集める）
    let scanner = ImageScanner::new();
    let scan_result = scanner.scan_directory_incremental_with_progress(
        directory,
        previous_files,
        progress_callback,
    )?;

    // データベースを更新（物理的な事実のみ。除外ルールとは無関係）

    // 新規ファイルを追加
    for file in &scan_result.files {
        db.upsert_file_metadata(&file.path, file.modified_time, file.file_size)
            .map_err(|e| format!("Database error: {e}"))?;
    }

    // 削除されたファイルをマーク（exif_cache は対象外。ファイルが復活すれば再利用される）
    if !scan_result.deleted_files.is_empty() {
        db.mark_deleted(&scan_result.deleted_files)
            .map_err(|e| format!("Database error: {e}"))?;
    }

    // スキャン履歴を記録（追加/削除件数は「物理的な」変化。除外ルールの影響を受けない）
    let directory_path = directory.to_string_lossy().to_string();
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

    // 除外ルールを取得
    let rules: Vec<IgnoreRule> = db
        .get_ignore_rules()
        .unwrap_or_default()
        .into_iter()
        .map(|(pattern, rule_type)| IgnoreRule { pattern, rule_type })
        .collect();
    let has_date_rule = rules.iter().any(|r| r.rule_type == RuleType::Date);

    // 撮影日除外ルールが1件以上ある場合に限り、exif_cache に未取得/古い（ファイルの
    // mtimeがキャッシュ時と食い違う）候補だけ EXIF 撮影日を rayon で並列取得する
    // （#61レビュー M2: ルールが無ければ一切EXIFを読まない。10万件規模でのスキャン
    // 速度を守るため）。
    let captured_dates = if has_date_rule {
        resolve_captured_dates(db, &scan_result.files)
    } else {
        HashMap::new()
    };

    let ignore_filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured_dates);

    // プレイリストに含めるべき集合（除外ルール適用後）。物理的な新規/削除判定
    // （上のfile_metadata操作）とは完全に独立した、別の段階として計算する。
    let included: Vec<String> = scan_result
        .files
        .iter()
        .filter(|f| !ignore_filter.is_ignored(Path::new(&f.path), directory))
        .map(|f| f.path.clone())
        .collect();

    let is_same_directory = current_directory.map(|p| p == directory).unwrap_or(false);

    if is_same_directory && playlist_slot.is_some() {
        // 同じディレクトリの場合のみ既存のプレイリストを更新。
        // 「物理的な新規/削除」ではなく、現在のプレイリストのメンバーシップと
        // 「含めるべき集合」の差分を取る（#61レビュー M2）。これにより、
        // 除外ルールが新たに付いて対象外になったファイル（物理的には存在し続ける）も、
        // 物理削除されたファイルも、どちらも同じ経路で正しくプレイリストから外れる。
        // 逆に除外ルールが外れて対象になったファイルは新規追加として扱われる。
        if let Some(ref mut playlist) = playlist_slot {
            let current_set = playlist.current_paths();
            let included_set: HashSet<String> = included.iter().cloned().collect();
            let added: Vec<String> = included_set.difference(&current_set).cloned().collect();
            let removed: Vec<String> = current_set.difference(&included_set).cloned().collect();
            playlist.update_images(added, removed);
        }
    } else {
        // 別のディレクトリまたは初回の場合は新規プレイリストを作成
        *playlist_slot = Some(Playlist::new(included));
    }

    Ok(ScanProgress {
        total_files: scan_result.total_count,
        new_files: scan_result.new_count,
        deleted_files: scan_result.deleted_count,
        duration_ms: scan_result.duration_ms,
    })
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

    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
    let current_directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let progress = perform_scan(
        &db,
        &mut playlist_lock,
        current_directory.as_deref(),
        &directory,
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

    drop(playlist_lock);

    // ディレクトリパスを保存
    *state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(directory.clone());

    // ディレクトリパスをデータベースに永続化
    let _ = db.save_setting("last_directory_path", &directory_path);
    drop(db);

    Ok(progress)
}
