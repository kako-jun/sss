use crate::asset_scope::resolve_share_directory;
use crate::commands::dialog::{pick_directory_blocking, DirectoryPicker, PrePicked};
use crate::commands::file_operations::home_pictures_dir;
use crate::commands::types::AppState;
use crate::database::Database;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// `save_setting`（WebView から呼べる汎用の設定保存）で書き込める設定キー（#93）。
///
/// 許可リスト方式。スキャン対象・ピック先のような「管理下パス」の基準になる設定
/// （`last_directory_path` / `share_directory_path`）や内部フラグ（`sssignore_migrated`）を
/// WebView から直接書き換えられると、ダイアログを経ずに任意フォルダを管理下にできてしまう
/// ため、これらは専用コマンド（`select_and_scan` / `select_share_directory`）経由でしか
/// 書かれない。新しい UI 設定を足すときはここにキーを追加する。
pub const WRITABLE_SETTING_KEYS: &[&str] = &[
    "display_interval",
    "language",
    "apply_exif_rotation",
    "video_audio_enabled",
    "video_max_duration_sec",
];

/// 設定を保存
///
/// #63: 以前は同期コマンドだったため、DBロック待ちの間メインスレッドをブロックし
/// うる作りになっていた。他の全DBコマンド（`get_last_directory_path` 等）と揃えて
/// 非同期にする。
///
/// #93: 書き込めるキーは [`WRITABLE_SETTING_KEYS`] のみ。それ以外は `settingKeyNotWritable`。
#[tauri::command]
pub async fn save_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    perform_save_setting(&db, &key, &value)
}

/// `save_setting` の本体（Tauri 非依存、#93）。許可リスト外のキーは `settingKeyNotWritable`
/// で拒否し、DB には一切触れない。
pub fn perform_save_setting(db: &Database, key: &str, value: &str) -> Result<(), String> {
    if !WRITABLE_SETTING_KEYS.contains(&key) {
        return Err("settingKeyNotWritable".to_string());
    }
    db.save_setting(key, value)
        .map_err(|e| format!("Failed to save setting: {e}"))
}

/// ピック先ディレクトリの選択 → 検証 → 保存の本体（Tauri 非依存、#93）。
///
/// ダイアログは `picker` 越しに開く。キャンセルは `Ok(None)`。選ばれたパスは
/// #87/#91 の `is_acceptable_share_directory`（相対・ルート・ホーム・システム領域等を拒否）
/// を通った場合だけ保存し、`Ok(Some(path))` を返す。拒否時は `shareDirectoryInvalid`。
pub fn perform_select_share_directory<P: DirectoryPicker>(
    picker: &P,
    title: Option<&str>,
    db_mutex: &Mutex<Database>,
    home_dir: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let Some(directory) = picker.pick_directory(title) else {
        return Ok(None);
    };
    if !crate::asset_scope::is_acceptable_share_directory(&directory, home_dir) {
        return Err("shareDirectoryInvalid".to_string());
    }
    let db = db_mutex.lock().map_err(|e| e.to_string())?;
    db.save_setting("share_directory_path", &directory.to_string_lossy())
        .map_err(|e| format!("Failed to save setting: {e}"))?;
    Ok(Some(directory))
}

/// ピック先ディレクトリをフォルダ選択ダイアログ（Rust 側）で選んで保存する（#93）。
/// 戻り値は保存したパス（キャンセル時は `None`）。
///
/// 保存後、次回起動を待たずに asset scope へ許可する（「ピック済み」タブのサムネイル表示に
/// 必要）。`resolve_and_sanitize_share_directory` が絶対パス・実在ディレクトリ・非保護ルートを
/// 再検証する（空文字列がそのまま scope に渡ると事故になる、レビュー #73 M1）。
/// 選択したディレクトリがまだ存在しない場合はここでは許可できない
/// （pick_image が create_dir_all 直後に再許可する。レビュー #73 must）。
#[tauri::command]
pub async fn select_share_directory(
    title: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let picked = {
        let _dialog_guard = crate::commands::scan::acquire_dialog_guard(
            &state.scan_in_progress,
            &crate::commands::scan::DIALOG_IN_PROGRESS,
            false,
        )?;
        pick_directory_blocking(app.clone(), title).await?
    };
    let Some(saved) = perform_select_share_directory(
        &PrePicked(picked),
        None,
        &state.db,
        dirs::home_dir().as_deref(),
    )?
    else {
        return Ok(None);
    };
    let value = saved.to_string_lossy().to_string();
    if let Ok(pictures_dir) = home_pictures_dir() {
        let resolved = resolve_share_directory(&pictures_dir, Some(value.as_str()));
        match crate::asset_scope::check_allow_dir(&resolved) {
            Ok(safe_dir) => {
                if let Err(e) = app.asset_protocol_scope().allow_directory(&safe_dir, true) {
                    eprintln!(
                        "Failed to allow asset scope for {}: {e}",
                        safe_dir.display()
                    );
                }
            }
            Err(reason) => {
                crate::asset_scope::log_refused_allow_dir(&resolved, reason);
            }
        }
    }
    Ok(Some(value))
}

/// 設定を取得（#63: 非同期化。上の `save_setting` docコメント参照）
#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_setting(&key)
        .map_err(|e| format!("Failed to get setting: {e}"))
}

/// 最後に選択したディレクトリパスを取得
#[tauri::command]
pub async fn get_last_directory_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let path = db
        .get_setting("last_directory_path")
        .map_err(|e| format!("Database error: {e}"))?;
    Ok(path)
}

/// OSのロケール（例: "ja-JP"、"en-US"）を取得する（#82 レビュー should3）。
///
/// `navigator.language` はWebViewの実装依存で、macOSのWKWebViewは
/// `CFBundleLocalizations`（Info.plist）にアプリが対応言語として明示していない
/// ロケールだと実際のOS設定に関わらず`en-US`固定になる既知の制約がある
/// （詳細は `docs/architecture.md` 6-(g)「表示言語（auto）はOSロケールを優先して
/// 解決する」）。フロントはこのコマンドの結果を優先し、取得できない場合
/// （`None`）だけ `navigator.language` にフォールバックする（保存値が `auto`
/// かどうかによらず、`initLocale` は起動時に毎回このコマンドを呼ぶ）。
///
/// `tauri-plugin-os` を丸ごと追加するとcapability許可（`os:allow-locale`）が
/// 増えるため、素の `#[tauri::command]`（capability不要）+ `sys-locale`
/// クレートで最小限に実装する。
#[tauri::command]
pub fn get_os_locale() -> Option<String> {
    sys_locale::get_locale()
}
