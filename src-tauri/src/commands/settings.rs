use crate::asset_scope::{resolve_and_sanitize_share_directory, resolve_share_directory};
use crate::commands::file_operations::home_pictures_dir;
use crate::commands::types::AppState;
use tauri::{AppHandle, Manager, State};

/// 設定を保存
///
/// #63: 以前は同期コマンドだったため、DBロック待ちの間メインスレッドをブロックし
/// うる作りになっていた。他の全DBコマンド（`get_last_directory_path` 等）と揃えて
/// 非同期にする。
#[tauri::command]
pub async fn save_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    // #87 M1: ピック先は get_thumbnail/pick_image の「管理下」判定の基準なので、相対パス・
    // ルート・ホーム等の広いパスへの書き換えは保存前に拒否する（空文字は既定に戻す操作）。
    if key == "share_directory_path"
        && !value.is_empty()
        && !crate::asset_scope::is_acceptable_share_directory(
            std::path::Path::new(&value),
            dirs::home_dir().as_deref(),
        )
    {
        return Err("shareDirectoryInvalid".to_string());
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_setting(&key, &value)
        .map_err(|e| format!("Failed to save setting: {e}"))?;
    drop(db);

    // ピック先ディレクトリが変更された場合、次回起動を待たずに asset scope へ許可する
    // （「ピック済み」タブのサムネイル表示に必要）。resolve_and_sanitize_share_directory が
    // 空文字設定をデフォルトへ正規化した上で、絶対パス・実在ディレクトリ・非保護ルートを
    // 検証する（空文字列がそのまま scope に渡ると事故になる、レビュー #73 M1）。
    // ただし、選択したディレクトリがまだ存在しない場合はここでは許可できない
    // （pick_image が create_dir_all 直後に再許可する。レビュー #73 must）。
    if key == "share_directory_path" {
        if let Ok(pictures_dir) = home_pictures_dir() {
            match resolve_and_sanitize_share_directory(&pictures_dir, Some(value.as_str())) {
                Some(safe_dir) => {
                    if let Err(e) = app.asset_protocol_scope().allow_directory(&safe_dir, true) {
                        eprintln!(
                            "Failed to allow asset scope for {}: {e}",
                            safe_dir.display()
                        );
                    }
                }
                None => {
                    let resolved = resolve_share_directory(&pictures_dir, Some(value.as_str()));
                    eprintln!(
                        "Refusing to allow unsafe asset scope directory: {}",
                        resolved.display()
                    );
                }
            }
        }
    }

    Ok(())
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
