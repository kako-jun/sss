use crate::asset_scope::sanitize_allow_dir;
use crate::commands::types::{AppState, ScanProgress};
use crate::database::{Database, ExifCacheRow};
use crate::ignore::{IgnoreFilter, IgnoreRule, RuleType};
use crate::image_processor::{extract_date_only, get_exif_info, is_video_file};
use crate::playlist::Playlist;
use crate::scanner::{FileMetadata, ImageScanner};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// `.sssignore` 移行が完了済みかどうかを記録する `app_settings` のキー。
/// 一度でも移行処理を試みた（ファイルの有無に関わらず）後は二度と実行しない
/// （#61: 毎スキャン走ってしまい `.sssignore.bak` を上書きし続けるバグの修正）。
const SSSIGNORE_MIGRATED_KEY: &str = "sssignore_migrated";

/// 撮影日除外ルールの判定に使う `path → captured_date` マップを作る（#61レビュー M2/S-a）。
///
/// DBアクセスを一切含まない純粋関数（呼び出し元がDBロックの外で呼べるようにするため。
/// #61レビュー M-A: スキャン中にDB/playlistのロックを握り続けるとUIが固まる）。
/// 戻り値は `(captured_dates マップ, 新たに読み直したexif_cache行)`。後者は呼び出し元が
/// 短時間のDBロックの中でバッチ書込すること。
///
/// 呼び出し元は「撮影日ルールが1件以上ある」ことを確認してから呼ぶこと（無条件に
/// 呼ぶとルールが無くてもEXIFを読んでしまい、10万件規模でスキャンが遅くなる）。
///
/// - `exif_cache` に**新鮮な**（ファイルの現在のmtimeとキャッシュ時のmtimeが一致する）
///   撮影日があれば、それを最優先で使う（EXIFを読み直さない）。
/// - EXIF読みの候補は `walk_filter`（日付ルールを含まない、glob/dirルールのみ）を
///   通過した**画像**ファイルだけに絞る（#61レビュー S-a: 動画や、どのみち除外される
///   ファイルまでEXIFを読むのは無駄。ディレクトリ系除外は既にWalkDirで枝刈り済みだが、
///   `*.tmp` のようなファイル単位のglobルールは生スキャンの結果に残っているため、
///   ここで改めて除く）。
/// - 上記候補のうち未取得、またはファイルが変更されて古くなったものだけ、rayon で
///   並列にEXIFを読み直す。
///
/// `pub`: `tests/exif_resolve_throughput.rs`（S-b計測。`#[ignore]`付き）が
/// DB/Tauri抜きでこの処理単体の所要時間を直接測るために公開する。
pub fn resolve_captured_dates(
    exif_cache_entries: Vec<ExifCacheRow>,
    current_files: &[FileMetadata],
    walk_filter: &IgnoreFilter,
    directory: &Path,
) -> (HashMap<String, String>, Vec<ExifCacheRow>) {
    let mut cache_by_path: HashMap<String, (Option<String>, i64)> = HashMap::new();
    for (path, date, mtime) in exif_cache_entries {
        cache_by_path.insert(path, (date, mtime));
    }

    // EXIF読みの候補: glob/dirルールを通過した画像ファイルのうち、
    // 未取得 or mtime不一致（ファイル変更）のものだけ
    let candidates: Vec<&FileMetadata> = current_files
        .iter()
        .filter(|f| {
            let path = Path::new(&f.path);
            !is_video_file(path) && !walk_filter.is_ignored(path, directory)
        })
        .filter(|f| {
            cache_by_path
                .get(&f.path)
                .map(|(_, cached_mtime)| *cached_mtime != f.modified_time)
                .unwrap_or(true)
        })
        .collect();

    let freshly_read: Vec<ExifCacheRow> = candidates
        .par_iter()
        .map(|f| {
            let date = get_exif_info(Path::new(&f.path))
                .ok()
                .and_then(|exif| exif.date_time.as_deref().and_then(extract_date_only));
            (f.path.clone(), date, f.modified_time)
        })
        .collect();

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

    (captured_dates, freshly_read)
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
/// `db`/`playlist` は `&Mutex` で受け取る（テスト容易性を保ちつつ、この関数の中で
/// ロック区間を細かく区切るため。#61レビュー M-A）。
///
/// #61レビュー M-A(must): 以前は `db`/`playlist` の両方のロックを握ったまま
/// WalkDir・メタデータ取得・EXIF並列読み・DB反映を一括で行っており、スキャン中は
/// 他のTauriコマンド（`get_next_image`等）がロック待ちでUIごと固まる退行があった。
/// 重い処理（WalkDir・EXIF読み）はロックの外で行い、DB/playlistへの実際の反映だけを
/// 短時間ロックする4段階に分ける:
///
/// 1. 短時間のDBロック — 前回スナップショット・除外ルール・（撮影日ルールがあれば）
///    `exif_cache` を読む。
/// 2. **ロック無し** — 生スキャン（`WalkDir`。ディレクトリ系除外は枝刈り）＋
///    必要なら並列EXIF読み。
/// 3. 短時間のDBロック — `file_metadata`/`exif_cache`/スキャン履歴への反映のみ。
/// 4. 短時間のplaylistロック — 「含めるべき集合」との差分適用のみ。
///
/// #61レビュー M2/S1 の骨格（各段階の詳細）:
/// - 生スキャン（除外ルール抜き）でディスク上の物理的な事実だけを集め、
///   `file_metadata` の新規/削除判定・スキャン履歴はこれだけを基準にする。
/// - 除外ルールの適用は別段階として行い、「プレイリストに含めるべき集合」を作る。
/// - プレイリストは「物理的な新規/削除」ではなく、現在のメンバーシップと
///   「含めるべき集合」の差分で更新する。除外ルールで対象外になったファイルも
///   物理削除されたファイルも同じ経路でプレイリストから外れるが、
///   `file_metadata`/`image_stats` は除外だけでは消えない。
pub fn perform_scan<F>(
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    current_directory: Option<&Path>,
    directory: &Path,
    progress_callback: F,
) -> Result<ScanProgress, String>
where
    F: FnMut(usize, usize) + Send + Sync,
{
    // --- Stage 1: 短時間のDBロック ---
    let (previous_files, rules, exif_cache_entries) = {
        let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());

        // マイグレーション処理：~/.sssignore が存在する場合は DB にインポート
        migrate_sssignore_to_db(&db);

        // データベースから前回のファイルメタデータ（ディスク上の物理的な事実のみ。
        // 撮影日は exif_cache に分離されているのでここには含まれない）を取得
        let previous_files = db.get_all_file_metadata().unwrap_or_default();

        // 除外ルールを取得
        let rules: Vec<IgnoreRule> = db
            .get_ignore_rules()
            .unwrap_or_default()
            .into_iter()
            .map(|(pattern, rule_type)| IgnoreRule { pattern, rule_type })
            .collect();
        let has_date_rule = rules.iter().any(|r| r.rule_type == RuleType::Date);

        // 撮影日ルールが無ければ exif_cache は読まない（無駄なDB往復を省く）
        let exif_cache_entries = if has_date_rule {
            db.get_all_exif_cache().unwrap_or_default()
        } else {
            Vec::new()
        };

        (previous_files, rules, exif_cache_entries)
    }; // ロック解放

    // --- Stage 2: ロック無し（WalkDir・rayon並列EXIF読み） ---

    // 日付ルールは walk_filter に含めない（ディレクトリ段階ではEXIFを読めず判定
    // できないため。撮影日除外は生スキャン後に別途行う。#61レビュー S-a）。
    let rules_for_walk: Vec<IgnoreRule> = rules
        .iter()
        .filter(|r| r.rule_type != RuleType::Date)
        .cloned()
        .collect();
    let walk_filter = IgnoreFilter::from_rules(&rules_for_walk);

    // 生スキャン。ディレクトリ系除外（末尾 `/` 等）は WalkDir の filter_entry で
    // 枝刈りされ、配下は file_metadata 登録・EXIF読み対象から外れる（#61レビュー S-a）。
    let scanner = ImageScanner::new();
    let scan_result = scanner.scan_directory_incremental_with_progress(
        directory,
        previous_files,
        &walk_filter,
        progress_callback,
    )?;

    let has_date_rule = rules.iter().any(|r| r.rule_type == RuleType::Date);

    // 撮影日除外ルールが1件以上ある場合に限り、glob除外を通過した画像（動画除く）の
    // うち exif_cache に未取得/古い候補だけ EXIF 撮影日を rayon で並列取得する
    // （#61レビュー M2/S-a: ルールが無ければ一切EXIFを読まない。10万件規模での
    // スキャン速度を守るため）。DBへの書込はまだ行わない（Stage 3でまとめて行う）。
    let (captured_dates, freshly_read_exif) = if has_date_rule {
        resolve_captured_dates(
            exif_cache_entries,
            &scan_result.files,
            &walk_filter,
            directory,
        )
    } else {
        (HashMap::new(), Vec::new())
    };

    // --- Stage 3: 短時間のDBロック（反映のみ） ---
    {
        let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());

        // 新規ファイルを追加（物理的な事実のみ。除外ルールとは無関係）
        for file in &scan_result.files {
            db.upsert_file_metadata(&file.path, file.modified_time, file.file_size)
                .map_err(|e| format!("Database error: {e}"))?;
        }

        // 削除されたファイルをマーク（exif_cache も含めて消す。「確定削除」なので
        // #61レビュー nit: 復活の見込みが薄いキャッシュを溜め込まない。
        // ディレクトリ系除外で枝刈りされ存在不明なファイルは `unknown_files` に
        // 分類済みでここには含まれず、file_metadata/exif_cacheとも保持される）
        if !scan_result.deleted_files.is_empty() {
            db.mark_deleted(&scan_result.deleted_files)
                .map_err(|e| format!("Database error: {e}"))?;
        }

        // スキャン履歴を記録（件数は後述のScanProgressとは別に、物理的な変化を記録する）
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

        if !freshly_read_exif.is_empty() {
            db.upsert_exif_cache_batch(&freshly_read_exif)
                .map_err(|e| format!("Database error: {e}"))?;
        }
    }; // ロック解放

    let ignore_filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured_dates);

    // プレイリストに含めるべき集合（除外ルール適用後）。物理的な新規/削除判定
    // （上のfile_metadata操作）とは完全に独立した、別の段階として計算する
    // （ロック不要の純粋計算）。
    let included: Vec<String> = scan_result
        .files
        .iter()
        .filter(|f| !ignore_filter.is_ignored(Path::new(&f.path), directory))
        .map(|f| f.path.clone())
        .collect();

    // --- Stage 4: 短時間のplaylistロック（差分適用のみ） ---
    {
        let mut playlist_lock = playlist_mutex.lock().unwrap_or_else(|e| e.into_inner());
        let is_same_directory = current_directory.map(|p| p == directory).unwrap_or(false);

        if is_same_directory && playlist_lock.is_some() {
            // 同じディレクトリの場合のみ既存のプレイリストを更新。
            // 「物理的な新規/削除」ではなく、現在のプレイリストのメンバーシップと
            // 「含めるべき集合」の差分を取る（#61レビュー M2）。これにより、
            // 除外ルールが新たに付いて対象外になったファイル（物理的には存在し続ける）も、
            // 物理削除されたファイルも、どちらも同じ経路で正しくプレイリストから外れる。
            // 逆に除外ルールが外れて対象になったファイルは新規追加として扱われる。
            if let Some(ref mut playlist) = *playlist_lock {
                let current_set = playlist.current_paths();
                let included_set: HashSet<String> = included.iter().cloned().collect();
                let added: Vec<String> = included_set.difference(&current_set).cloned().collect();
                let removed: Vec<String> = current_set.difference(&included_set).cloned().collect();
                playlist.update_images(added, removed);
            }
        } else {
            // 別のディレクトリまたは初回の場合は新規プレイリストを作成
            *playlist_lock = Some(Playlist::new(included.clone()));
        }
    } // ロック解放

    // #61レビュー S-a: ScanProgress の total/new はプレイリスト（含める集合）基準で
    // 整合させる（生スキャンの物理的な総数ではなく、実際にスライドショーに乗る数）。
    let included_set: HashSet<&str> = included.iter().map(|s| s.as_str()).collect();
    let new_files_included = scan_result
        .new_files
        .iter()
        .filter(|p| included_set.contains(p.as_str()))
        .count();

    Ok(ScanProgress {
        total_files: included.len(),
        new_files: new_files_included,
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

    // #61レビュー M-A: current_directory の読み取りだけ先に短時間ロックする。
    // `perform_scan` 自身が db/playlist のロックを段階ごとに細かく取る（下記参照）ため、
    // ここで db/playlist を事前ロックしたまま渡さない。
    let current_directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let progress = perform_scan(
        &state.db,
        &state.playlist,
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

    // ディレクトリパスを保存
    *state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(directory.clone());

    // ディレクトリパスをデータベースに永続化
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = db.save_setting("last_directory_path", &directory_path);
    drop(db);

    Ok(progress)
}
