use crate::asset_scope::{
    default_share_directory, resolve_validated_share_directory, sanitize_allow_dir,
};
use crate::commands::playlist_persistence;
use crate::commands::types::{AppState, ExcludeOutcome};
use crate::ignore::{glob_check_pattern, IgnoreFilter, IgnoreRule, RuleType};
use crate::image_processor::{extract_date_only, get_exif_info};
use globset::Glob;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Manager, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentImage {
    pub path: String,
    pub display_count: i32,
    pub last_displayed: String,
}

/// 除外ルール1件（フロントエンド向けDTO）。#61: 撮影日ルールと通常globを
/// UI側で区別・表示できるよう `rule_type` を含める。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRuleDto {
    pub pattern: String,
    pub rule_type: String,
}

/// ホームディレクトリ配下の Pictures フォルダを取得する（OS別に環境変数を切り替え）。
pub(crate) fn home_pictures_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
    } else {
        std::env::var("HOME").map(|p| PathBuf::from(p).join("Pictures"))
    }
    .map_err(|_| "Failed to get home directory".to_string())
}

/// デフォルトのピック先ディレクトリパスを取得
#[tauri::command]
pub async fn get_default_share_directory() -> Result<String, String> {
    let share_directory = default_share_directory(&home_pictures_dir()?);
    Ok(share_directory.to_str().unwrap_or("").to_string())
}

/// 実際に使われるピック先（検証済み解決。不正な保存値は既定にフォールバック済み）を返す（#87）。
/// 設定画面は保存値の生値でなく、これを表示する。
#[tauri::command]
pub async fn get_share_directory(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let dir = get_picked_directory(&db)?;
    Ok(dir.to_string_lossy().to_string())
}

/// ファイラで画像を選択状態で開く（OS別）
#[tauri::command]
pub async fn open_in_explorer(
    image_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // #92: 任意パスの存在確認・ファイラ表示をさせない（管理下＝DB 登録 or ピック先フォルダ内のみ）。
    // UI は表示中の画像の絶対パスを渡すので `~` 展開は不要（管理外扱いになる）。
    let (share_directory, known) = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        (
            get_picked_directory(&db)?,
            db.is_known_media_path(&image_path).unwrap_or_else(|e| {
                eprintln!(
                    "open_in_explorer: is_known_media_path failed (treated as unmanaged): {e}"
                );
                false
            }),
        )
    };
    // 検証（管理下 → 実在 → verbatim 接頭辞の除去）は `pick::resolve_open_target` に集約。
    let target = crate::pick::resolve_open_target(Path::new(&image_path), &share_directory, known)?;
    let path = target.as_path();

    let image_path = path.to_str().ok_or("Invalid path")?.to_string();

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &image_path])
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {e}"))?;
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
                    .map_err(|e| format!("Failed to open file manager: {e}"))?;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &image_path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }

    Ok(())
}

/// ピック機能：画像をPictures/sss-pickedフォルダにコピー
#[tauri::command]
pub async fn pick_image<R: tauri::Runtime>(
    image_path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let source_path = Path::new(&image_path);

    // #87: 任意の絶対パスをピック先フォルダ（asset scope 内）へコピーさせない。
    // メディア拡張子で、かつ管理下（プレイリスト構成員・履歴・ピック先フォルダ内）のみ許可。
    if !crate::scanner::is_media_path(source_path) {
        return Err("notMediaFile".to_string());
    }

    // コピー先ディレクトリ（設定から、なければデフォルト。解決は get_picked_directory に一本化）
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let share_directory = get_picked_directory(&db)?;
    let known = db.is_known_media_path(&image_path).unwrap_or_else(|e| {
        eprintln!("pick_image: is_known_media_path failed (treated as unmanaged): {e}");
        false
    });
    drop(db);
    let source_path = crate::pick::ensure_managed_media_path(source_path, &share_directory, known)?;
    let source_path = source_path.as_path();

    if !source_path.exists() {
        return Err("Image file does not exist".to_string());
    }

    // ディレクトリが存在しない場合は作成
    if !share_directory.exists() {
        fs::create_dir_all(&share_directory)
            .map_err(|e| format!("Failed to create share directory: {e}"))?;
    }

    // 起動時・設定変更時点ではディレクトリが未作成で asset scope 許可に失敗していることが
    // ある（新規環境の既定ピック先など）。実在が保証された今このタイミングで改めて許可し、
    // 「ピック済み」タブのサムネイル/動画表示が次回起動を待たずに動くようにする
    // （レビュー #73 must）。
    match sanitize_allow_dir(&share_directory) {
        Some(safe_dir) => {
            if let Err(e) = app.asset_protocol_scope().allow_directory(&safe_dir, true) {
                eprintln!(
                    "Failed to allow asset scope for {}: {e}",
                    safe_dir.display()
                );
            }
        }
        None => {
            crate::asset_scope::log_refused_allow_dir(&share_directory);
        }
    }

    // 同名ファイルがあれば連番（name_1.ext）を付け、決して上書きしない
    let final_dest_path = crate::pick::copy_with_unique_name(source_path, &share_directory)?;
    Ok(final_dest_path.to_string_lossy().to_string())
}

/// 除外ルール一覧を取得
#[tauri::command]
pub async fn get_ignore_patterns(state: State<'_, AppState>) -> Result<Vec<IgnoreRuleDto>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let rules = db
        .get_ignore_rules()
        .map_err(|e| format!("Failed to get ignore rules: {e}"))?;
    Ok(rules
        .into_iter()
        .map(|(pattern, rule_type)| IgnoreRuleDto {
            pattern,
            rule_type: rule_type.as_str().to_string(),
        })
        .collect())
}

/// 除外ルールを削除
///
/// #61レビュー nit: `ignore_rules` の主キーが `(pattern, rule_type)` の複合キーに
/// なったため、`pattern` だけでは同じ文字列のglob/dateルールのうちどちらを消すか
/// 一意に決まらない。フロントエンドが表示している `ruleType` をそのまま渡してもらう。
#[tauri::command]
pub async fn remove_ignore_pattern(
    pattern: String,
    rule_type: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.remove_ignore_rule(&pattern, RuleType::parse(&rule_type))
        .map_err(|e| format!("Failed to remove ignore rule: {e}"))
}

/// 除外ルールを手動追加（常に glob ルールとして追加する。撮影日ルールは `exclude_image`
/// の "date" 経由でのみ作られる）。
///
/// #61 問題4: 不正なglob（例: `a{b.jpg` のような閉じていない `{`）は `eprintln!` で
/// 握りつぶさず `Err` を返し、UI にも失敗を伝える。末尾 `/` のディレクトリ指定
/// パターンは、実際に使う正規化後の形（`glob_check_pattern`）で検証する。
///
/// #80: `Err` はユーザー向け文言でなくエラーコードで返す。フロント辞書
/// （`resolveAddPatternErrorMessage`）が表示文言に変換する。`invalidPattern`は
/// globsetクレートの技術的なエラー内容を`:`区切りで詳細として付ける
/// （パターンを書いたユーザー自身へのデバッグ情報として有用なため）。
#[tauri::command]
pub async fn add_ignore_pattern(pattern: String, state: State<'_, AppState>) -> Result<(), String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("patternEmpty".to_string());
    }
    Glob::new(&glob_check_pattern(trimmed)).map_err(|e| format!("invalidPattern:{e}"))?;

    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.add_ignore_rule(trimmed, RuleType::Glob).map_err(|e| {
        eprintln!("add_ignore_pattern: failed to add ignore rule: {e}");
        "addIgnoreRuleFailed".to_string()
    })
}

/// `exclude_image` が `update_images` でプレイリストのメンバーシップを変えた直後に
/// フル保存する（#62レビューM2）。`state.directory_path` が未設定（プレイリスト初期化前）
/// の場合は保存しようがないため、ログだけ出してスキップする。
fn persist_current_playlist(state: &State<AppState>, playlist: &crate::playlist::Playlist) {
    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match directory {
        Some(dir) => {
            let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
            playlist_persistence::save_full(&db, &dir.to_string_lossy(), playlist);
        }
        None => {
            eprintln!("exclude_image: directory_path is not set, skipping playlist persistence");
        }
    }
}

/// 除外機能：画像をDBのignore_rulesに追加
///
/// #92: 対象は DB 登録済み（`file_metadata`/`image_stats`）のパスのみ。管理外は
/// `pathNotManaged`（存在確認・EXIF 日付のオラクル遮断）。
///
/// #80: 戻り値は完成済みの日本語文字列でなく `ExcludeOutcome`（構造化データ）。
/// エラーもユーザー向け文言でなくエラーコードで返す（呼び出し元のOverlayUIは
/// 現状これらのエラーメッセージ自体を表示せずconsole.errorのみに流している
/// ため、コード化は将来UIで表示する場合に備えた一貫性のため）。
#[tauri::command]
pub async fn exclude_image(
    image_path: String,
    exclude_type: String, // "date", "file", "directory"
    state: State<'_, AppState>,
) -> Result<ExcludeOutcome, String> {
    let path = Path::new(&image_path);

    // #92: 除外できるのは DB 登録済み（プレイリスト構成員・表示履歴）のパスだけ。
    // 管理外の任意パスは、存在確認・EXIF 撮影日の読み取り・除外ルール追加のいずれよりも
    // 前に `pathNotManaged` で拒否する（存在有無や任意ファイルの撮影日が漏れない）。
    let known = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.is_known_media_path(&image_path).unwrap_or_else(|e| {
            eprintln!("exclude_image: is_known_media_path failed (treated as unmanaged): {e}");
            false
        })
    };
    crate::pick::ensure_registered_media_path(path, known)?;

    if !path.exists() {
        return Err("imageFileNotFound".to_string());
    }

    let (pattern, rule_type) = match exclude_type.as_str() {
        "date" => {
            // EXIFから日付を取得（DateTimeOriginal優先。#61問題3）
            match get_exif_info(path) {
                Ok(exif) => match exif.date_time.as_deref().and_then(extract_date_only) {
                    Some(date) => (date, RuleType::Date),
                    None => return Err("noExifDate".to_string()),
                },
                Err(_) => return Err("exifReadFailed".to_string()),
            }
        }
        "file" => {
            // ファイル名パターン。globのメタ文字（`[`,`]`,`{`,`}`,`*`,`?`）を含むファイル名でも
            // 自分自身にマッチするよう escape する（#61問題4: `photo[1].jpg` 等）
            (globset::escape(&path.to_string_lossy()), RuleType::Glob)
        }
        "directory" => {
            // ディレクトリパターン。`/**` でサブフォルダも含めて再帰的に除外する。
            // 旧実装の `/*` はglobsetの既定（literal_separator無効）では実際には
            // サブフォルダもマッチしていたが、そのことはコード上自明でなく意図が
            // 伝わらないため `/**` という明示的な表現に変える（#61レビュー: 動作を
            // 変えるのではなく意味を明確化する修正）
            if let Some(parent) = path.parent() {
                (
                    format!("{}/**", globset::escape(&parent.to_string_lossy())),
                    RuleType::Glob,
                )
            } else {
                return Err("parentDirectoryNotFound".to_string());
            }
        }
        _ => return Err("invalidExcludeType".to_string()),
    };

    // DB に除外ルールを追加
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    // #78: 取り消しで「元からあったルール」まで消さないよう、追加前の存在を控える。
    let rule_type_str = rule_type.as_str().to_string();
    let rule_added = !db
        .get_ignore_rules()
        .unwrap_or_default()
        .iter()
        .any(|(p, t)| *p == pattern && *t == rule_type);
    db.add_ignore_rule(&pattern, rule_type).map_err(|e| {
        eprintln!("exclude_image: failed to add ignore rule: {e}");
        "addIgnoreRuleFailed".to_string()
    })?;

    if exclude_type == "file" {
        // ファイル除外は即座にプレイリストから削除
        drop(db);
        // #62レビューM2(must): update_images(メンバーシップ変更)は必ず保存とセットで
        // 行う。ここで保存し忘れると、再起動を跨いだときに除外したはずの画像が
        // 保存済みプレイリストから復活し、二重表示になる。
        let mut removed_paths = Vec::new();
        let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut playlist) = *playlist_lock {
            if playlist.current_paths().contains(&image_path) {
                removed_paths.push(image_path.clone());
            }
            playlist.update_images(vec![], vec![image_path.clone()]);
            persist_current_playlist(&state, playlist);
        }
        drop(playlist_lock);
        Ok(ExcludeOutcome {
            pattern,
            needs_rescan: false,
            rule_type: rule_type_str,
            rule_added,
            removed_paths,
        })
    } else if exclude_type == "date" {
        // 撮影日除外: exif_cache で既に「その日付」と分かっている画像は、再スキャンを
        // 待たずに即座にプレイリストから外す（#61レビュー M2）。exif_cache に無い
        // （まだ一度も表示していない）画像は次回スキャンでEXIFを読み直して判定される。
        //
        // #61レビュー nit: キャッシュ時の `file_mtime` と現在のファイルの実際のmtimeが
        // 一致するものだけを対象にする。ファイルがキャッシュ後に変更（別の画像で
        // 上書き等）されていた場合、古いキャッシュのまま即時除去すると、既に別内容に
        // なった画像を誤って除外してしまうため（次回スキャンでEXIFが読み直され、
        // そこで正しく再判定される分には支障ない）。
        let candidates = db
            .get_paths_with_captured_date(&pattern)
            .unwrap_or_default();
        drop(db);
        let matched: Vec<String> = candidates
            .into_iter()
            .filter(|(path, cached_mtime)| {
                std::fs::metadata(path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .is_some_and(|d| d.as_secs() as i64 == *cached_mtime)
            })
            .map(|(path, _)| path)
            .collect();
        let mut removed_paths = Vec::new();
        if !matched.is_empty() {
            // #62レビューM2(must): こちらもupdate_images後は必ず保存する。
            let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref mut playlist) = *playlist_lock {
                let current = playlist.current_paths();
                removed_paths = matched
                    .iter()
                    .filter(|p| current.contains(*p))
                    .cloned()
                    .collect();
                playlist.update_images(vec![], matched);
                persist_current_playlist(&state, playlist);
            }
        }
        Ok(ExcludeOutcome {
            pattern,
            needs_rescan: true,
            rule_type: rule_type_str,
            rule_added,
            removed_paths,
        })
    } else {
        // ディレクトリ除外は再スキャンが必要
        drop(db);
        Ok(ExcludeOutcome {
            pattern,
            needs_rescan: true,
            rule_type: rule_type_str,
            rule_added,
            removed_paths: Vec::new(),
        })
    }
}

/// 直前の除外を取り消す（#78）。`exclude_image` の戻り値（`pattern`/`ruleType`/
/// `ruleAdded`/`removedPaths`）をそのまま渡す。
///
/// - `remove_rule`（= `ruleAdded`）が真のときだけ除外ルールを削除する。元から登録済み
///   だったルールは消さない。
/// - `restore_paths` は除外で即座にプレイリストから外した画像。**未再生区間**へ
///   `Playlist::update_images` の既存の挿入規則（未再生区間へランダムに散らす。
///   表示済み区間・履歴は触らない）で戻す。実在しない画像、まだ別の除外ルールに
///   該当する画像（ルール削除後の残りのルールで再判定）、既にプレイリストにある画像は
///   戻さない。
/// - 除外は「削除」ではないため（ファイル自体・表示履歴は元から無傷）、取り消しは
///   ルールとプレイリスト所属を戻すだけで完結する。
#[tauri::command]
pub async fn undo_exclude(
    pattern: String,
    rule_type: String,
    remove_rule: bool,
    restore_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    if remove_rule {
        db.remove_ignore_rule(&pattern, RuleType::parse(&rule_type))
            .map_err(|e| {
                eprintln!("undo_exclude: failed to remove ignore rule: {e}");
                "undoExcludeFailed".to_string()
            })?;
    }
    if restore_paths.is_empty() {
        return Ok(());
    }
    // ルール削除後に残っているルールで再判定するためのフィルタ（他のルールにも
    // 該当する画像を、取り消しで復活させてしまわないため）。
    let rules: Vec<IgnoreRule> = db
        .get_ignore_rules()
        .unwrap_or_default()
        .into_iter()
        .map(|(pattern, rule_type)| IgnoreRule { pattern, rule_type })
        .collect();
    let captured_dates: HashMap<String, String> = db
        .get_all_exif_cache()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(path, date, _)| date.map(|d| (path, d)))
        .collect();
    // #92: 復帰対象は DB 登録済み（`file_metadata`/`image_stats` に文字列完全一致）かつ
    // メディア拡張子のパスだけ。`<root>/../x` のような未登録パスや非メディアは、
    // `starts_with`（成分単位の比較で `..` を解決しない）を通ってもプレイリストへ入れない。
    // 通常フローの `removedPaths` は `playlist.current_paths()` 由来＝スキャン登録済みなので影響しない。
    let registered: std::collections::HashSet<String> = restore_paths
        .iter()
        .filter(|p| {
            crate::scanner::is_media_path(Path::new(p.as_str()))
                && db.is_known_media_path(p).unwrap_or_else(|e| {
                    eprintln!(
                        "undo_exclude: is_known_media_path failed (treated as unmanaged): {e}"
                    );
                    false
                })
        })
        .cloned()
        .collect();
    drop(db);
    let restore_paths: Vec<String> = restore_paths
        .into_iter()
        .filter(|p| registered.contains(p))
        .collect();
    let ignore_filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured_dates);
    let scan_root = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let candidates: Vec<String> = restore_paths
        .into_iter()
        .filter(|p| {
            let path = Path::new(p);
            // 取り消し猶予中にフォルダを切り替えて再スキャンした場合、旧フォルダの画像を
            // 新しいプレイリストへ混ぜない（現在のスキャンルート配下だけを復帰対象にする）。
            path.exists()
                && scan_root.as_ref().is_none_or(|root| path.starts_with(root))
                && !match &scan_root {
                    Some(root) => ignore_filter.is_ignored(path, root),
                    None => ignore_filter.is_ignored_anywhere(path),
                }
        })
        .collect();

    let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut playlist) = *playlist_lock {
        let current = playlist.current_paths();
        let to_restore: Vec<String> = candidates
            .into_iter()
            .filter(|p| !current.contains(p))
            .collect();
        if !to_restore.is_empty() {
            // #62レビューM2: メンバーシップを変えたら必ず保存する。
            playlist.update_images(to_restore, vec![]);
            persist_current_playlist(&state, playlist);
        }
    }
    Ok(())
}

/// 最近表示した画像一覧を取得（最新100件、除外済み除く）
#[tauri::command]
pub async fn get_recent_images(state: State<'_, AppState>) -> Result<Vec<RecentImage>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());

    // 除外パターンを取得してフィルタを構築。撮影日ルールは exif_cache の値を使う
    // （#61レビュー S4: 表示済みでキャッシュ済みの撮影日を無視していた漏れを修正）。
    let rules: Vec<IgnoreRule> = db
        .get_ignore_rules()
        .map_err(|e| format!("Failed to get ignore rules: {e}"))?
        .into_iter()
        .map(|(pattern, rule_type)| IgnoreRule { pattern, rule_type })
        .collect();
    let captured_dates: HashMap<String, String> = db
        .get_all_exif_cache()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(path, date, _)| date.map(|d| (path, d)))
        .collect();
    let ignore_filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured_dates);

    // 過去にスキャンした全ディレクトリ（長い＝より具体的なパスを優先してマッチさせる）。
    // 「最近表示した画像」は複数のスキャンルートにまたがりうるため、各画像パスに
    // 対応するスキャンルートを見つけ、そこからの相対パスで判定する（#61レビュー S3:
    // 絶対パスのまま判定すると、ドットディレクトリ配下をスキャンしたライブラリの
    // 履歴がドットフォルダ包括ルールで全消えしていた）。対応するルートが見つからない
    // 場合はフルパスをそのまま相対パス扱いする従来の判定にフォールバックする。
    //
    // 既知の制約（#61レビュー nit）: `scan_history` は100件超を刈り込む
    // （`trim_scan_history`）ため、古いディレクトリのエントリが失われるとここでの
    // ルート解決もできなくなり、そのディレクトリ由来の履歴だけ絶対パスへフォール
    // バックする。現在アクティブなディレクトリ（`last_directory_path`）は刈り込みの
    // 影響を受けないよう候補に必ず含めることで、少なくとも直近スキャン分は保護する。
    let mut scan_roots = db.get_distinct_scan_directories().unwrap_or_default();
    if let Ok(Some(last_directory)) = db.get_setting("last_directory_path") {
        if !scan_roots.contains(&last_directory) {
            scan_roots.push(last_directory);
        }
    }
    scan_roots.sort_by_key(|r| std::cmp::Reverse(r.len()));

    // 最近表示した画像を多めに取得（除外フィルタ後に最大100件を返す。
    // 除外率が高い場合は100件未満になりうる）
    let all_recent = db
        .get_recent_images(500)
        .map_err(|e| format!("Failed to get recent images: {e}"))?;
    drop(db);

    // 除外パターンにマッチしないものだけ返す（最大100件）
    let filtered: Vec<RecentImage> = all_recent
        .into_iter()
        .filter(|(path, _, _)| {
            let p = Path::new(path);
            let root = scan_roots
                .iter()
                .find(|r| p.starts_with(Path::new(r.as_str())));
            let ignored = match root {
                Some(r) => ignore_filter.is_ignored(p, Path::new(r.as_str())),
                None => ignore_filter.is_ignored_anywhere(p),
            };
            !ignored
        })
        .take(100)
        .map(|(path, display_count, last_displayed)| RecentImage {
            path,
            display_count,
            last_displayed,
        })
        .collect();

    Ok(filtered)
}

/// `get_thumbnail` の結果（#67）。動画は静止画サムネイルを作らず、フロントがアイコンで示す。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ThumbnailResult {
    /// 静止画。`path` は長辺256pxのJPEG（キャッシュ配下＝asset scope 許可済み）。
    Image { path: String },
    /// 動画。サムネイルは無い。
    Video,
}

/// 設定画面（履歴・ピック済み）用の小さなサムネイルを返す（#67）。
/// 原本（5000万画素級）を `<img>` に直接読ませる代わりに、バックエンドで縮小して
/// キャッシュする。デコードは重いのでブロッキングスレッドで実行する。
#[tauri::command]
pub async fn get_thumbnail(
    image_path: String,
    state: State<'_, AppState>,
) -> Result<ThumbnailResult, String> {
    let source = PathBuf::from(&image_path);
    if crate::scanner::is_video_path(&source) {
        return Ok(ThumbnailResult::Video);
    }
    if !crate::scanner::is_image_path(&source) {
        return Err("Not a supported image file".to_string());
    }
    // #87: 任意の絶対パスをデコードさせない（プレイリスト構成員・履歴・ピック先フォルダ内のみ）。
    let (share_directory, known) = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        (
            get_picked_directory(&db)?,
            db.is_known_media_path(&image_path).unwrap_or_else(|e| {
                eprintln!("get_thumbnail: is_known_media_path failed (treated as unmanaged): {e}");
                false
            }),
        )
    };
    let source = crate::pick::ensure_managed_media_path(&source, &share_directory, known)?;
    let cache_dir = state.cache_dir.clone();
    let thumb = tauri::async_runtime::spawn_blocking(move || {
        crate::thumbnail::ensure_thumbnail(&source, &cache_dir)
    })
    .await
    .map_err(|e| format!("Thumbnail task failed: {e}"))??;
    Ok(ThumbnailResult::Image {
        path: thumb.to_string_lossy().to_string(),
    })
}

/// ピック済みフォルダのパスを取得するヘルパー
pub(crate) fn get_picked_directory(db: &crate::database::Database) -> Result<PathBuf, String> {
    let share_setting = db
        .get_setting("share_directory_path")
        .map_err(|e| e.to_string())?;
    // #87 M1: 保存値が不正（相対・ルート・ホーム等）なら既定にフォールバックする。
    Ok(resolve_validated_share_directory(
        &home_pictures_dir()?,
        share_setting.as_deref(),
    ))
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

    // 拡張子の判定はスキャナと同じ定義（画像＋動画）を使う
    crate::pick::list_picked_media(&picked_dir)
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

    // 安全チェック: ピック先フォルダ内の通常のメディアファイルのみ削除可能
    let target = crate::pick::validate_picked_delete_target(Path::new(&image_path), &picked_dir)?;
    fs::remove_file(&target).map_err(|e| format!("Failed to delete file: {e}"))?;
    Ok(())
}

/// 全画像の表示回数をリセット
#[tauri::command]
pub async fn reset_all_display_counts(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.reset_all_display_counts()
        .map_err(|e| format!("Failed to reset display counts: {e}"))
}
