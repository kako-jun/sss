//! フォルダ選択ダイアログの抽象（#93）。
//!
//! 「どのフォルダをスキャン/管理下にするか」の選択は、WebView（JS）から任意のパス文字列を
//! 受け取る形でなく、**Rust 側でダイアログを開いて選ばれたパスだけを使う**形にする。
//! WebView が乗っ取られても、ユーザーがダイアログで選んでいないフォルダを
//! スキャン・asset scope 許可・ピック先に設定することはできない。
//!
//! ダイアログはネイティブ UI でテスト（非対話環境）から開けないため、`DirectoryPicker`
//! trait で抽象化し、本番は [`TauriDirectoryPicker`]、テストは固定値を返すスタブを注入する。

use std::path::PathBuf;

/// フォルダ選択ダイアログを開いて結果を返す抽象。
pub trait DirectoryPicker {
    /// ダイアログを開き、選択されたフォルダを返す。キャンセル・選択不能なら `None`。
    /// 呼び出し中はブロックしてよい（メインスレッドから呼ばないこと）。
    fn pick_directory(&self, title: Option<&str>) -> Option<PathBuf>;
}

/// tauri-plugin-dialog の Rust API でネイティブのフォルダ選択ダイアログを開く本番実装。
pub struct TauriDirectoryPicker {
    pub app: tauri::AppHandle,
}

impl DirectoryPicker for TauriDirectoryPicker {
    fn pick_directory(&self, title: Option<&str>) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = self.app.dialog().file();
        if let Some(title) = title {
            builder = builder.set_title(title);
        }
        builder
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
    }
}

/// 本番のダイアログを別スレッド（blocking プール）で開く。`async` コマンドから
/// ワーカーを塞がずに呼ぶためのヘルパー。
pub async fn pick_directory_blocking(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        TauriDirectoryPicker { app }.pick_directory(title.as_deref())
    })
    .await
    .map_err(|e| format!("Dialog task failed: {e}"))
}

/// 既にダイアログで選択済みの結果（`None` はキャンセル）をそのまま返す picker。
/// `async` コマンドがダイアログを blocking プールで先に開き（[`pick_directory_blocking`]）、
/// 結果を同期の本体（`perform_*`）へ渡すためのアダプタ。本体は常に `DirectoryPicker`
/// 越しにしかパスを受け取らないので、テストと本番で同じ本体が走る。
pub struct PrePicked(pub Option<PathBuf>);

impl DirectoryPicker for PrePicked {
    fn pick_directory(&self, _title: Option<&str>) -> Option<PathBuf> {
        self.0.clone()
    }
}
