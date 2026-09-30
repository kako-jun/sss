use crate::asset_scope::sanitize_allow_dir;
use crate::commands::dialog::{pick_directory_blocking, DirectoryPicker, PrePicked};
use crate::commands::playlist_persistence::{self, normalize_directory_key};
use crate::commands::types::{AppState, ScanProgress};
use crate::database::{Database, ExifCacheRow};
use crate::ignore::{IgnoreFilter, IgnoreRule, RuleType};
use crate::image_processor::{extract_date_only, get_exif_info, is_video_file};
use crate::playlist::Playlist;
use crate::scanner::{FileMetadata, ImageScanner};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// `.sssignore` 移行が完了済みかどうかを記録する `app_settings` のキー。
/// 一度でも移行処理を試みた（ファイルの有無に関わらず）後は二度と実行しない
/// （#61: 毎スキャン走ってしまい `.sssignore.bak` を上書きし続けるバグの修正）。
const SSSIGNORE_MIGRATED_KEY: &str = "sssignore_migrated";

/// Stage3（`apply_file_metadata_changes`によるDB反映）のロック保持時間がこれを
/// 超えたら`eprintln!`で記録する閾値（ミリ秒）。#63 PR#77レビュー nit: マジックナンバー
/// を定数化。10万件規模での性能計測時に異常の疑いがある水準として選んだ値で、
/// 閾値以下は毎回のログでノイズになるので出さない。
const STAGE3_LOCK_WARNING_THRESHOLD_MS: u128 = 100;

/// スキャン（`select_and_scan` / `rescan_last_directory`）の二重実行を防ぐRAIIガード（#61レビュー nit）。
///
/// `AppState::scan_in_progress` を `compare_exchange` で `false → true` にできた
/// 場合のみ生成でき、生成に成功すると必ず1つの `Drop` で `false` に戻す
/// （panic・早期`return`（`?`）・正常終了のいずれの経路でも解除される）。
///
/// `pub(crate)`: `commands::system::reset_all_data`（#64）も同じ `AtomicBool` で
/// 同じガードを取得し、スキャン中の初期化・初期化中のスキャン開始の両方を
/// 一箇所のロジックで防ぐ。
pub struct ScanGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> ScanGuard<'a> {
    /// 既にスキャンが実行中（`flag == true`）なら `Err` を返す。
    ///
    /// #80: ユーザー向け文言でなくエラーコード（`scanInProgress`）で返す。
    /// フロント辞書（`resolveScanErrorMessage`）が表示文言に変換する。
    pub fn acquire(flag: &'a AtomicBool) -> Result<Self, String> {
        Self::acquire_with_code(flag, "scanInProgress")
    }

    /// `acquire` のエラーコード指定版（ダイアログ表示中フラグ `dialogInProgress` 用、#93）。
    pub fn acquire_with_code(flag: &'a AtomicBool, code: &str) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ScanGuard { flag })
            .map_err(|_| code.to_string())
    }
}

impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod scan_guard_tests {
    use super::ScanGuard;
    use std::sync::atomic::AtomicBool;

    /// 1本目が保持している間、2本目の `acquire` はエラーになる。
    /// 1本目を drop すればロックは解除され、次の `acquire` は成功する。
    #[test]
    fn acquire_blocks_concurrent_scan_and_releases_on_drop() {
        let flag = AtomicBool::new(false);

        let guard = ScanGuard::acquire(&flag).expect("最初のacquireは成功するはず");
        let second = ScanGuard::acquire(&flag);
        // #80: ユーザー向け文言でなくエラーコードで返る契約をここで固定する。
        // フロント辞書（resolveScanErrorMessage/resolveResetAllDataErrorMessage）が
        // このコード文字列を直接switchしているため、文言（日本語/英語）に変わって
        // しまうと両方とも未知コード扱いのフォールバック文言に落ちてしまう。
        // `ScanGuard` は `Debug` を実装していないため `unwrap_err()` は使えず、
        // `err()` で `Option<String>` に変換してから比較する。
        assert_eq!(second.err(), Some("scanInProgress".to_string()));

        drop(guard);

        assert!(
            ScanGuard::acquire(&flag).is_ok(),
            "1本目がdropされればロックは解除され、次のacquireは成功するはず"
        );
    }

    /// 保持中にpanicしても（`?`による早期returnと同様に）Dropは必ず走り、
    /// ロックが解除されたままにならない。
    #[test]
    fn guard_releases_even_when_scope_panics() {
        let flag = AtomicBool::new(false);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = ScanGuard::acquire(&flag).unwrap();
            panic!("simulated failure mid-scan");
        }));
        assert!(result.is_err());

        assert!(
            ScanGuard::acquire(&flag).is_ok(),
            "panic経由でもguardのDropでロックは解除されるはず"
        );
    }
}

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
/// `select_and_scan`/`rescan_last_directory` は共通の `scan_chosen_directory` 経由でこの関数を呼ぶだけの薄いシェルにする。
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
/// 4. 短時間のplaylistロック — 除外ルールの読み直し＋「含めるべき集合」の算出＋
///    差分適用＋確定保存（#61レビュー S-1、#62レビュー2巡目 N-S3。下記参照）。
///
/// #61レビュー M2/S1 の骨格（各段階の詳細）:
/// - 生スキャン（除外ルール抜き）でディスク上の物理的な事実だけを集め、
///   `file_metadata` の新規/削除判定・スキャン履歴はこれだけを基準にする。
/// - 除外ルールの適用は別段階として行い、「プレイリストに含めるべき集合」を作る。
/// - プレイリストは「物理的な新規/削除」ではなく、現在のメンバーシップと
///   「含めるべき集合」の差分で更新する。除外ルールで対象外になったファイルも
///   物理削除されたファイルも同じ経路でプレイリストから外れるが、
///   `file_metadata`/`image_stats` は除外だけでは消えない。
/// - **#61レビュー S-1 → #62レビュー2巡目 N-S3(must)で強化**: 「含める集合」は
///   Stage 1で読んだ古いルールではなく、**Stage 4（playlistロックを取った直後）**
///   で読み直した最新のルールで作る。当初（#61時点）はStage 4を独立した短時間DB
///   ロックとして playlist ロックの**外**で行っていたが、それだと「ルール読み直し」
///   と「playlist ロック取得」の間に隙間ができ、その隙間で `exclude_image`
///   （file/date即時反映。DB書込→playlist更新の順で行う）が割り込むと、
///   Stage 4が読んだルールにはまだ新しい除外が反映されておらず、`exclude_image`
///   側は既にplaylistから該当画像を消した直後、という食い違いが起きて、
///   Stage 4以降の「含める集合」との差分計算がその画像を「新規追加」と誤認し、
///   除外したはずの画像をplaylistへ再追加してしまう競合があった。ルール読み直しを
///   playlist ロックを取得した**後**に行うことで、`playlist_mutex` の総順序により
///   「`exclude_image` が先にロックを取得していたら、そのDB書込は必ずこの読み直し
///   より前に完了している（`exclude_image` はDB書込→playlist更新の順なので）」
///   ことが保証され、競合が構造的に無くなる（`exclude_image` が後からロックを
///   取得する場合は、そちらが最終的な状態を決める＝正しく上書きする）。
///   `captured_dates`（EXIF撮影日）はStage 2の結果をそのまま流用し、遡って
///   読み直さない。
///
/// #62レビュー2巡目 nit: `directory_path_mutex`（`AppState.directory_path` 相当）は
/// Stage 4の中で、playlistロックを保持したまま設定する。以前は呼び出し元
/// （`scan_chosen_directory`）が `perform_scan` の**戻り値を受け取った後**に
/// 別途設定していたため、「Stage 4完了〜directory_path更新」の間に小さな窓があり、
/// その間に他コマンド（`get_next_image`/`exclude_image`）が `state.directory_path`
/// を読んで軽量保存すると、まだ更新されていない古いディレクトリパスを
/// `playlist_list.directory_path` に書いてしまう（せっかくStage 4で正しく設定した
/// 値を上書きしてしまう）おそれがあった。同じロック区間内で設定することでこの窓を無くす。
pub fn perform_scan<F>(
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    directory_path_mutex: &Mutex<Option<PathBuf>>,
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
        // 撮影日は exif_cache に分離されているのでここには含まれない）を取得。
        // #63: 今回スキャンする `directory` 配下のパスだけに限定する
        // （`get_all_file_metadata`＝DB全件だと、別ディレクトリへ切り替えて
        // スキャンした時点で元ディレクトリの file_metadata が「今回の生スキャンには
        // 存在しない」と誤判定され確定削除されてしまう。関数docコメント参照）。
        let previous_files = db
            .get_file_metadata_under(&directory.to_string_lossy())
            .unwrap_or_default();

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
    // #63: ロック保持時間を計測する（10万件規模での性能計測・回帰検知のため）。
    let stage3_lock_start = std::time::Instant::now();
    {
        let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());

        // file_metadata へ反映するのは新規/変更分のみ（#63）。生スキャンで見つかった
        // 全ファイル（大半は「変更なし」）を毎回書き直すのは無駄なI/O・ロック保持時間の
        // 伸長でしかない。確定削除分（`unknown_files` は含まない）と合わせて
        // `apply_file_metadata_changes` で1トランザクションにまとめて反映する。
        let changed_paths: std::collections::HashSet<&str> = scan_result
            .new_files
            .iter()
            .chain(scan_result.modified_files.iter())
            .map(|p| p.as_str())
            .collect();
        let upserts: Vec<(String, i64, i64)> = scan_result
            .files
            .iter()
            .filter(|f| changed_paths.contains(f.path.as_str()))
            .map(|f| (f.path.clone(), f.modified_time, f.file_size))
            .collect();

        // ディレクトリ系除外で枝刈りされ存在不明なファイルは `unknown_files` に
        // 分類済みでここには含まれず、file_metadata/exif_cacheとも保持される
        // （#61レビュー nit: 復活の見込みが薄い確定削除のexif_cacheキャッシュだけ
        // 合わせて消す）。
        db.apply_file_metadata_changes(&upserts, &scan_result.deleted_files)
            .map_err(|e| format!("Database error: {e}"))?;

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
    let stage3_lock_ms = stage3_lock_start.elapsed().as_millis();
    if stage3_lock_ms > STAGE3_LOCK_WARNING_THRESHOLD_MS {
        eprintln!("[perform_scan] Stage 3 DBロック保持時間: {stage3_lock_ms}ms");
    }

    // --- Stage 4: 短時間のplaylistロック（除外ルール読み直し・差分適用・復元・確定保存） ---
    let mut included: Vec<String>;
    {
        let mut playlist_lock = playlist_mutex.lock().unwrap_or_else(|e| e.into_inner());

        // 除外ルールを読み直す（#61レビュー S-1 → #62レビュー2巡目 N-S3(must)で
        // playlistロックの外から中へ移動）。Stage 1で読んだ`rules`のまま「含める集合」を
        // 作ると、スキャン中（Stage 1〜ここまでの生スキャン・EXIF並列読みは10万件規模だと
        // 数秒〜数十秒かかる）に追加された除外が無視され、除外したはずの画像がプレイリストに
        // 再び現れてしまう。**playlistロックを取得した後**にDBロックを取ってルールだけ
        // 読み直すことで、`exclude_image`（DB書込→playlist更新の順）との競合を構造的に防ぐ
        // （詳細は関数doc、N-S3参照）。captured_dates（EXIF撮影日の並列読み取り結果）は
        // Stage 2で計算済みのものをそのまま流用する（スキャン中に新しく追加された日付
        // ルールの分までは遡ってEXIFを読み直さない。次回スキャンで拾われる）。
        let fresh_rules: Vec<IgnoreRule> = {
            let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
            db.get_ignore_rules()
                .unwrap_or_default()
                .into_iter()
                .map(|(pattern, rule_type)| IgnoreRule { pattern, rule_type })
                .collect()
        }; // DBロック解放（playlistロックは保持したまま）

        let ignore_filter =
            IgnoreFilter::from_rules_with_captured_dates(&fresh_rules, captured_dates);

        // プレイリストに含めるべき集合（除外ルール適用後）。物理的な新規/削除判定
        // （上のfile_metadata操作）とは完全に独立した、別の段階として計算する。
        included = scan_result
            .files
            .iter()
            .filter(|f| !ignore_filter.is_ignored(Path::new(&f.path), directory))
            .map(|f| f.path.clone())
            .collect();

        // #63 PR#77レビュー M2(must): 今回のスキャンエラーが原因で「不明」になった
        // ファイル（`scan_result.error_unknown_files`）は、除外ルールとは無関係な
        // 一時的な読み取り失敗の可能性が高い。生スキャン結果（`scan_result.files`）に
        // 現れないため上記の`included`には入らず、そのままだと下の差分計算で
        // 「プレイリストから消えた」扱いになり、シャッフル位置・履歴を失ってしまう
        // （ディレクトリ系除外による不明は意図した除外なので、これとは区別して
        // プレイリストから外れて構わない）。`included`に加えることで、既にプレイリスト
        // に居るものは`removed`に入らず、居ないものは（読めていないファイルなので）
        // `added`にも実質影響しない状態を保つ。
        //
        // #63 PR#77レビュー2巡目 S-a: `error_unknown_files`は定義上`scan_result.files`
        // （今回の生スキャンで見つかったファイル）には現れないパスの集合なので、
        // `included`（`scan_result.files`が元）と重複することは構造的に無い。以前は
        // それでも`Vec::contains`で毎回線形探索しており、`included`件数×
        // `error_unknown_files`件数のO(N×E)をplaylistロック保持中に行っていた。
        // HashSetでの判定に変え、全体をO(N+E)に抑える（フィルタなので、万一この前提が
        // 崩れても壊れず単に重複を避けるだけ、という安全側の実装のままにする）。
        let included_before_errors: std::collections::HashSet<&str> =
            included.iter().map(|s| s.as_str()).collect();
        let new_from_errors: Vec<String> = scan_result
            .error_unknown_files
            .iter()
            .filter(|p| !included_before_errors.contains(p.as_str()))
            .cloned()
            .collect();
        drop(included_before_errors);
        included.extend(new_from_errors);

        // #62レビューS2: ディレクトリ比較は正規化キーで行う（canonicalize前後・末尾区切り
        // の有無で文字列表現が食い違っても同じディレクトリと判定できるように）。
        let directory_key = normalize_directory_key(directory);
        let is_same_directory = current_directory
            .map(|p| normalize_directory_key(p) == directory_key)
            .unwrap_or(false);
        let directory_str = directory.to_string_lossy().to_string();

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
                if !added.is_empty() || !removed.is_empty() {
                    playlist.update_images(added, removed);
                    // #62レビューM2(must): メンバーシップを変える操作(update_images)は
                    // 必ず保存とセットで行う。保存し忘れると、再起動を跨いだときに
                    // 除外したはずの画像が復活したり(exif_cacheと違いDBには残っている)、
                    // 二重表示になったりする。
                    let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
                    playlist_persistence::save_full(&db, &directory_str, playlist);
                }
            }
        } else {
            // メモリ上に無い（起動直後の初回スキャン、または別ディレクトリへの切替）。
            // #62: 起動直後は `current_directory` が必ず `None`（`AppState.directory_path`は
            // このスキャン完了後にしかセットされない）になるため、ここで無条件に
            // 新規シャッフルすると、DBに保存済みのプレイリスト状態（前回の続き）を
            // 毎回捨ててしまい「完全平等」が達成できない（元issueの問題1）。
            // 保存済み状態のディレクトリが今回のスキャン対象と一致する場合だけ復元し、
            // 現在の「含めるべき集合」との差分を `update_images` 相当で適用する。
            //
            // #62レビューS1: この復元自体は `restore_playlist` コマンドが起動直後に
            // 先に行うため、実際にはここに来る前に `playlist_lock` が既に復元済みの
            // ことが多い（その場合は上の `is_same_directory` 分岐に入る）。ここに来るのは
            // `restore_playlist` が復元できなかった場合（保存が無い/ディレクトリ不一致）や、
            // ディレクトリを選び直した場合。
            let restored = {
                let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
                db.load_playlist_state().unwrap_or(None)
            };

            let playlist = match restored {
                Some((saved_dir, shuffled_list, next_index, history, history_position))
                    if normalize_directory_key(Path::new(&saved_dir)) == directory_key =>
                {
                    let mut playlist = Playlist::from_persisted(
                        shuffled_list,
                        next_index,
                        history,
                        history_position,
                    );
                    let current_set = playlist.current_paths();
                    let included_set: HashSet<String> = included.iter().cloned().collect();
                    let added: Vec<String> =
                        included_set.difference(&current_set).cloned().collect();
                    let removed: Vec<String> =
                        current_set.difference(&included_set).cloned().collect();
                    if !added.is_empty() || !removed.is_empty() {
                        playlist.update_images(added, removed);
                    }
                    playlist
                }
                // 保存済み状態が無い、または別ディレクトリのものなら新規シャッフル
                _ => Playlist::new(included.clone()),
            };

            // #62: シャッフルが確定した（新規作成・復元後の差分適用のいずれも
            // shuffled_list が変わりうる）ので、ここで必ずフル保存する
            // （上の差分が空でも、directory_path をこのディレクトリへ更新するため）。
            {
                let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
                playlist_persistence::save_full(&db, &directory_str, &playlist);
            }

            *playlist_lock = Some(playlist);
        }

        // #62レビュー2巡目 nit: playlistロックを保持したまま directory_path も更新する
        // （上記の関数docコメント参照。呼び出し元の`scan_chosen_directory`が戻り値受領後に
        // 別途設定する旧方式だと、更新までの間に他コマンドが古い値で軽量保存しうる窓があった）。
        *directory_path_mutex
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(directory.to_path_buf());
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
        error_count: scan_result.error_count,
        error_examples: scan_result.error_examples,
    })
}

/// `last_directory_path`（前回スキャンしたフォルダ）を保存する `app_settings` のキー。
/// #93: このキーは `save_setting`（WebView から呼べる）では書き込めない。書き込むのは
/// ダイアログ経由で選ばれたパスのスキャン成功後（[`scan_chosen_directory`]）だけ。
pub const LAST_DIRECTORY_KEY: &str = "last_directory_path";

/// 選ばれた（または DB 保存済みの）ディレクトリを検証してスキャンし、成功したら
/// `last_directory_path` に保存する本体（Tauri 非依存、#93）。
///
/// `select_and_scan` / `rescan_last_directory` の共通部分。JS から受け取ったパス文字列を
/// ここに渡す経路は存在しない（呼び出し元はダイアログの結果か DB 保存値だけを渡す）。
/// 戻り値の `PathBuf` は `sanitize_allow_dir` を通った安全なパスで、呼び出し元
/// （`AppHandle` を持つコマンドシェル）が asset scope へ許可する。
pub fn scan_chosen_directory<F>(
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    directory_path_mutex: &Mutex<Option<PathBuf>>,
    scan_in_progress: &AtomicBool,
    directory: &Path,
    progress_callback: F,
) -> Result<(ScanProgress, PathBuf), String>
where
    F: FnMut(usize, usize) + Send + Sync,
{
    // #61レビュー nit: 二重実行防止。2本目のスキャンは即座にエラーを返す
    // （RAIIガードなので、この後のどの`?`早期returnでも確実に解除される）。
    let _scan_guard = ScanGuard::acquire(scan_in_progress)?;

    // #80: ユーザー向け文言でなくエラーコードで返す。フロント辞書は
    // `resolveScanErrorMessage` で変換する。
    // #93レビュー: 選んだパスをエラーコードの detail（`code:detail`）に載せる。フロントは
    // 「今表示している前回フォルダ」でなくこのパスを文言に使う（選択に失敗したとき旧パスが出ない）。
    if !directory.is_dir() {
        return Err(format!("directoryNotFound:{}", directory.display()));
    }

    // sanitize_allow_dir() で is_dir・絶対パス・非保護ルートを再検証する
    // （空文字列/相対パスが紛れ込んで意図せず広い scope になる事故を防ぐ、レビュー #73 M1）。
    // 拒否された場合はスキャンしても画像が一切表示できないため、ここで Err を返して
    // UI にエラー理由を伝える。
    let safe_dir = sanitize_allow_dir(directory)
        .ok_or_else(|| format!("directoryUnsafe:{}", directory.display()))?;

    // #61レビュー M-A: current_directory の読み取りだけ先に短時間ロックする。
    // `perform_scan` 自身が db/playlist のロックを段階ごとに細かく取るため、
    // ここで db/playlist を事前ロックしたまま渡さない。
    let current_directory = directory_path_mutex
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let progress = perform_scan(
        db_mutex,
        playlist_mutex,
        directory_path_mutex,
        current_directory.as_deref(),
        directory,
        progress_callback,
    )?;
    // `directory_path_mutex` は perform_scan の Stage 4 内（playlistロックを保持したまま）
    // で既に設定済み（#62レビュー2巡目 nit）。ここで改めて設定しない。

    // ディレクトリパスをデータベースに永続化（起動時の自動スキャン・復元の基準になる）
    let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
    let _ = db.save_setting(LAST_DIRECTORY_KEY, &directory.to_string_lossy());
    drop(db);

    Ok((progress, safe_dir))
}

/// ダイアログ表示中フラグ（プロセス全体で1つ）。WebView が `select_and_scan` /
/// `select_share_directory` を連打してもダイアログが重ねて出ないようにする（#93レビュー）。
pub static DIALOG_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 選択ダイアログを開く前のガード（#93レビュー）。スキャンが実行中なら、ダイアログを出した後に
/// `scanInProgress` になる無駄を避けるため先に弾く。別のダイアログが表示中なら `dialogInProgress`。
/// 戻り値のガードはダイアログ表示〜スキャン完了まで保持する。
/// `check_scan`: スキャンを伴う選択（`select_and_scan`）か。ピック先の選択は false。
pub fn acquire_dialog_guard<'a>(
    scan_in_progress: &AtomicBool,
    dialog_flag: &'a AtomicBool,
    check_scan: bool,
) -> Result<ScanGuard<'a>, String> {
    if check_scan && scan_in_progress.load(Ordering::SeqCst) {
        return Err("scanInProgress".to_string());
    }
    ScanGuard::acquire_with_code(dialog_flag, "dialogInProgress")
}

/// `select_and_scan` の結果（#93）。
#[derive(Debug)]
pub enum SelectScanOutcome {
    /// ユーザーがダイアログをキャンセルした（エラーではない）。何も変更していない。
    Cancelled,
    /// 選ばれたフォルダをスキャンした。`PathBuf` は asset scope へ許可すべき安全なパス。
    Scanned(ScanProgress, PathBuf),
}

/// フォルダ選択ダイアログ → 選ばれたフォルダのスキャンの本体（Tauri 非依存、#93）。
///
/// ダイアログは `picker` 越しに開く（本番は Rust 側のネイティブダイアログ、テストはスタブ）。
/// キャンセル時は `Cancelled`（エラーにしない）。ダイアログを先に閉じてから
/// スキャンの二重実行ガードを取る（ダイアログ表示中に他のスキャンや初期化を塞がない）。
pub fn perform_select_and_scan<P, F>(
    picker: &P,
    title: Option<&str>,
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    directory_path_mutex: &Mutex<Option<PathBuf>>,
    scan_in_progress: &AtomicBool,
    progress_callback: F,
) -> Result<SelectScanOutcome, String>
where
    P: DirectoryPicker,
    F: FnMut(usize, usize) + Send + Sync,
{
    let Some(directory) = picker.pick_directory(title) else {
        return Ok(SelectScanOutcome::Cancelled);
    };
    let (progress, safe_dir) = scan_chosen_directory(
        db_mutex,
        playlist_mutex,
        directory_path_mutex,
        scan_in_progress,
        &directory,
        progress_callback,
    )?;
    Ok(SelectScanOutcome::Scanned(progress, safe_dir))
}

/// DB に保存済みの前回フォルダ（過去にダイアログで選ばれたパス）を再スキャンする本体
/// （Tauri 非依存、#93）。保存が無ければ `noLastDirectory`。
pub fn perform_rescan_last_directory<F>(
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    directory_path_mutex: &Mutex<Option<PathBuf>>,
    scan_in_progress: &AtomicBool,
    progress_callback: F,
) -> Result<(ScanProgress, PathBuf), String>
where
    F: FnMut(usize, usize) + Send + Sync,
{
    let last = {
        let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
        db.get_setting(LAST_DIRECTORY_KEY)
            .map_err(|e| format!("Database error: {e}"))?
    };
    let Some(last) = last.filter(|p| !p.is_empty()) else {
        return Err("noLastDirectory".to_string());
    };
    scan_chosen_directory(
        db_mutex,
        playlist_mutex,
        directory_path_mutex,
        scan_in_progress,
        Path::new(&last),
        progress_callback,
    )
}

fn allow_asset_scope(app: &tauri::AppHandle, safe_dir: &Path) {
    // asset scope（convertFileSrc が読み込めるディレクトリ）にスキャン対象を動的に許可する。
    if let Err(e) = app.asset_protocol_scope().allow_directory(safe_dir, true) {
        eprintln!(
            "Failed to allow asset scope for {}: {e}",
            safe_dir.display()
        );
    }
}

fn emit_scan_progress(app: &tauri::AppHandle) -> impl FnMut(usize, usize) + Send + Sync + '_ {
    move |current, total| {
        let _ = app.emit(
            "scan-progress",
            serde_json::json!({ "current": current, "total": total }),
        );
    }
}

/// フォルダ選択ダイアログを Rust 側で開き、選ばれたフォルダをスキャンする（#93）。
///
/// 戻り値は `Some(ScanProgress)`（スキャン完了）/ `None`（ダイアログをキャンセル）。
/// `title` はダイアログの表示タイトルだけに使う（パスではない）。
#[tauri::command]
pub async fn select_and_scan(
    title: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Option<ScanProgress>, String> {
    let _dialog_guard = acquire_dialog_guard(&state.scan_in_progress, &DIALOG_IN_PROGRESS, true)?;
    let picked = pick_directory_blocking(app.clone(), title).await?;
    match perform_select_and_scan(
        &PrePicked(picked),
        None,
        &state.db,
        &state.playlist,
        &state.directory_path,
        &state.scan_in_progress,
        emit_scan_progress(&app),
    )? {
        SelectScanOutcome::Cancelled => Ok(None),
        SelectScanOutcome::Scanned(progress, safe_dir) => {
            allow_asset_scope(&app, &safe_dir);
            Ok(Some(progress))
        }
    }
}

/// DB 保存済みの前回フォルダを再スキャンする（#93。起動時の自動スキャン・設定画面の
/// 再スキャン）。引数は取らない（WebView からパスを指定できない）。
#[tauri::command]
pub async fn rescan_last_directory(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ScanProgress, String> {
    let (progress, safe_dir) = perform_rescan_last_directory(
        &state.db,
        &state.playlist,
        &state.directory_path,
        &state.scan_in_progress,
        emit_scan_progress(&app),
    )?;
    allow_asset_scope(&app, &safe_dir);
    Ok(progress)
}

/// `perform_restore` の結果（#62レビュー2巡目）。asset scope への許可は
/// `AppHandle` が要る副作用のため、その要否だけをここで呼び出し元に伝える
/// （`AppHandle` は runtime ジェネリクスが `Wry` 固定で `tauri::test::mock_app()` の
/// `MockRuntime` を受け付けないため、`perform_scan` と同じ理由でロジック本体を
/// Tauri非依存にしてテストしやすくしている）。
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// 復元しなかった（保存が無い/ディレクトリ不一致/ディレクトリに今アクセス
    /// できない/スキャン中のいずれか）。呼び出し元は `Ok(false)` を返すこと。
    NotRestored,
    /// `playlist` が既に `Some`（既に復元済み/初期化済み）だったので何もしていない。
    /// 既存維持でそのまま使ってよい。呼び出し元は asset scope の許可は不要
    /// （既に許可済みのはずのディレクトリのため）で `Ok(true)` を返すこと。
    AlreadyReady,
    /// 新たに復元した。asset scope への許可がまだなら、返された安全なパスへ
    /// 許可してから呼び出し元は `Ok(true)` を返すこと。
    Restored(PathBuf),
}

/// 起動時、DBに保存済みのプレイリスト状態を復元する本体（Tauri非依存、#62レビューS1）。
/// `#[tauri::command] restore_playlist` はこの関数を呼ぶだけの薄いシェルにする。
///
/// スキャン完了を待たずに最初の画像を表示できるようにするため、スキャンコマンド
/// とは独立したコマンドとして提供する。フロントは起動直後にまずこれを呼び、
/// `true`（復元できた、または既に復元/初期化済みで使える状態）ならスキャン完了を
/// 待たずに即座に `get_next_image` を呼んで表示を始め、スキャンはバックグラウンドで
/// 実行して差分だけ反映する。`false`（保存が無い/ディレクトリが一致しない/対象
/// ディレクトリに今アクセスできない/スキャン中）ならスキャン完了を待つ従来の
/// フローにフォールバックする。
///
/// 復元に成功した場合、`directory_path_mutex`（`AppState.directory_path` 相当）も
/// ここで設定する。直後にバックグラウンドで呼ばれる `rescan_last_directory` の
/// `current_directory` がこの値と一致し、新規シャッフルではなく「差分更新」経路を
/// 通るようにするため。
///
/// #62レビュー2巡目 N-S2: 呼び出しの前提を明示する。
/// - `playlist_mutex` が既に `Some`（既に復元済み/初期化済み）なら、何もせず
///   `AlreadyReady` を返す（「既存維持」。呼び出し元は現在の状態をそのまま使ってよい、
///   という意味で `Ok(true)` を返す設計にした。呼ぶたびに毎回作り直すと、既に
///   advance 済みの状態を巻き戻してしまうため）。**#62レビュー3巡目 nit**:
///   ただし既存の `playlist` が「今回リクエストされたディレクトリ」のものとは
///   限らない（例: 別ディレクトリへの切替直後で、まだ古いディレクトリの
///   プレイリストが残っている）ため、`directory_path_mutex` の現在値と正規化キーで
///   突き合わせ、一致しない場合は「既存維持」を騙らず `NotRestored` を返す。
/// - `scan_in_progress` が立っている（スキャン実行中）間は何もせず
///   `NotRestored` を返す。スキャンの Stage 4 が `playlist_mutex`/`db_mutex` を
///   段階的に触っている最中にここから割り込むと、スキャン側の反映と競合しうるため
///   （両者とも `playlist_mutex` を取るので致命的な破損はしないが、意味のある
///   復元にならない）。この場合はスキャン自体の完了を待つ。
///
/// #62レビュー2巡目 N-M1(must): 対象ディレクトリが今アクセスできない（NAS/USB
/// 未マウント等）場合は復元しない。`sanitize_allow_dir` で存在確認を兼ねる。
/// これをせず復元してしまうと、保存されていたファイルが軒並み存在しない状態になり、
/// `get_next_image` が内部リトライ（#62レビュー2巡目 N-S1）で `advance` を
/// 繰り返しながら実質的に巡全体を無言で消費してしまう（画面には何も表示されないまま
/// 「完全平等」の前提であるはずの巡が壊れる）。
///
/// #62レビュー3巡目 nit: `playlist_mutex` の `is_some` 確認から実際に
/// `Some(playlist)` を設定するまでの間、ロックを保持し続ける（`MutexGuard` を
/// 関数の最後まで生かす）ことで TOCTOU（確認と代入の間に別スレッドの
/// `perform_restore`/`perform_scan` が割り込んで `playlist` を書き換える隙）を塞ぐ。
/// `db_mutex`/`directory_path_mutex` が必要な箇所ではこの `playlist_mutex` の
/// ロックを保持したまま内側で取る（順序は playlist→db／playlist→directory_path。
/// `perform_scan` の Stage 4 と同じ順序で、逆順に取っている箇所は無いためデッド
/// ロックしない）。
pub fn perform_restore(
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    directory_path_mutex: &Mutex<Option<PathBuf>>,
    scan_in_progress: &AtomicBool,
    directory: &Path,
) -> RestoreOutcome {
    let directory_key = normalize_directory_key(directory);

    // #62レビュー3巡目 nit: is_some確認から末尾のSome設定まで、このロックを
    // 保持し続ける（TOCTOU対策）。
    let mut playlist_lock = playlist_mutex.lock().unwrap_or_else(|e| e.into_inner());

    if playlist_lock.is_some() {
        let current_dir_matches = directory_path_mutex
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_deref()
            .map(|dir| normalize_directory_key(dir) == directory_key)
            .unwrap_or(false);
        return if current_dir_matches {
            RestoreOutcome::AlreadyReady
        } else {
            // 既存のplaylistは今回リクエストされたディレクトリのものではない。
            // 「既存維持」を騙らずNotRestoredを返し、呼び出し元(スキャンコマンド)の
            // 通常の新規/差分更新フローに委ねる。
            RestoreOutcome::NotRestored
        };
    }

    if scan_in_progress.load(Ordering::SeqCst) {
        return RestoreOutcome::NotRestored;
    }

    // #62レビュー2巡目 N-M1(must): ディレクトリが今アクセスできないなら復元しない。
    let safe_dir = match sanitize_allow_dir(directory) {
        Some(dir) => dir,
        None => return RestoreOutcome::NotRestored,
    };

    let restored = {
        let db = db_mutex.lock().unwrap_or_else(|e| e.into_inner());
        db.load_playlist_state().unwrap_or(None)
    };

    let (saved_dir, shuffled_list, next_index, history, history_position) = match restored {
        Some(row) if normalize_directory_key(Path::new(&row.0)) == directory_key => row,
        _ => return RestoreOutcome::NotRestored,
    };
    let _ = saved_dir;

    let playlist = Playlist::from_persisted(shuffled_list, next_index, history, history_position);
    if playlist.is_empty() {
        // 保存されていた画像が復元時点で1件も無い(空のディレクトリ等)。
        // 従来どおりスキャンに任せる。
        return RestoreOutcome::NotRestored;
    }

    *playlist_lock = Some(playlist);
    *directory_path_mutex
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(directory.to_path_buf());

    RestoreOutcome::Restored(safe_dir)
}

/// 起動時、DBに保存済みのプレイリスト状態を復元する（#62レビューS1）。
/// 本体は Tauri 非依存の `perform_restore`。ここでは asset scope への許可
/// （`AppHandle` が要る副作用）だけを行う薄いシェル。
#[tauri::command]
pub async fn restore_playlist(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    // #93: 復元対象は DB 保存済みの前回フォルダ。WebView からパスを受け取らない。
    let last = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.get_setting(LAST_DIRECTORY_KEY)
            .map_err(|e| format!("Database error: {e}"))?
    };
    let Some(last) = last.filter(|p| !p.is_empty()) else {
        return Ok(false);
    };
    let directory = PathBuf::from(&last);

    match perform_restore(
        &state.db,
        &state.playlist,
        &state.directory_path,
        &state.scan_in_progress,
        &directory,
    ) {
        RestoreOutcome::NotRestored => Ok(false),
        RestoreOutcome::AlreadyReady => Ok(true),
        RestoreOutcome::Restored(safe_dir) => {
            // asset scope はTauri起動時（`lib.rs` の `setup`、#59）に
            // `last_directory_path`/`scan_history` の全ディレクトリへ許可済みのはずだが、
            // 二重に許可しても無害なため念のため行う。
            if let Err(e) = app.asset_protocol_scope().allow_directory(&safe_dir, true) {
                eprintln!(
                    "Failed to allow asset scope for {}: {e}",
                    safe_dir.display()
                );
            }
            Ok(true)
        }
    }
}
