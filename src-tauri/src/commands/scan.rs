use crate::commands::types::AppState;
use crate::database::Database;
use crate::dialog::{pick_directory_blocking, DirectoryPicker, PrePicked};
use crate::playlist::Playlist;
use crate::scan_service::{
    perform_rescan_last_directory, perform_restore, scan_chosen_directory, RestoreOutcome,
    ScanProgress,
};
use crate::settings_store::LAST_DIRECTORY_KEY;
use crate::shared::{acquire_dialog_guard, DIALOG_IN_PROGRESS};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

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
    // ダイアログ表示中だけガードを保持し、閉じた直後（スキャン開始前）に drop する。
    // スキャン中の二重実行は `scan_in_progress`/`ScanGuard` が弾くので、ここで保持し続けると
    // スキャン中のピック先選択が「ダイアログが既に開いています」と誤って出てしまう。
    let picked = {
        let _dialog_guard =
            acquire_dialog_guard(&state.scan_in_progress, &DIALOG_IN_PROGRESS, true)?;
        pick_directory_blocking(app.clone(), title).await?
    };
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
