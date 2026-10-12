//! 起動失敗ダイアログの表示（#144）。
//!
//! Tauri 2 の `setup` はイベントループが回り始めた後（`RunEvent::Ready`）に呼ばれる。
//! Linux では tao が既定の GMainContext を握っているため、メインスレッド上で同期ダイアログ
//! （`rfd` の `show()` / プラグインの `blocking_show`）を呼ぶとデッドロックする。
//! そのためダイアログは非ブロッキング（`show(callback)`）で出し、選択後の処理は
//! コールバックで行う。判断は `startup_error.rs` の純粋関数が持つ。

use crate::startup_error::{self, Followup, StartupPlan};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 起動失敗を利用者に知らせ、選択に応じて終了／再起動する。呼び出し側の `setup` は
/// `AppState` を管理せずに `Ok(())` で返ること（DB が無いのでコマンドは使えない）。
pub fn present(app: &AppHandle, plan: StartupPlan) {
    eprintln!("startup failure: {}", plan.message());
    quiesce_main_window(app);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let handle = app.clone();
    let builder = app
        .dialog()
        .message(plan.message())
        .title("Smart Slide Show")
        .kind(MessageDialogKind::Error);
    let builder = match &plan {
        StartupPlan::Offer { .. } => builder.buttons(MessageDialogButtons::OkCancelCustom(
            startup_error::BACKUP_LABEL.to_string(),
            startup_error::EXIT_LABEL.to_string(),
        )),
        StartupPlan::Report { .. } => builder.buttons(MessageDialogButtons::Ok),
    };
    builder.show(move |accepted| {
        // コールバックはメインスレッド外で呼ばれる。
        // `app.exit()`/`app.restart()` は RunEvent::Exit を発火し、tauri-plugin-window-state が
        // 隠れたメインウィンドウの状態（全画面でない既定サイズ等）を保存してしまい、次回の通常起動が
        // ウィンドウ表示になる（サイネージ用途の退行）。失敗経路ではその保存を避けるため、
        // Exit は `process::exit`、Restart は single-instance を解放してから直接再起動する。
        match startup_error::follow_up(&plan, accepted, timestamp) {
            Followup::Exit => std::process::exit(1),
            Followup::Restart => {
                tauri_plugin_single_instance::destroy(&handle);
                tauri::process::restart(&handle.env());
            }
            Followup::ReportThenExit(message) => {
                handle
                    .dialog()
                    .message(message)
                    .title("Smart Slide Show")
                    .kind(MessageDialogKind::Error)
                    .show(|_| std::process::exit(1));
            }
        }
    });
}

/// tauri.conf.json のメインウィンドウ（全画面・装飾なし）は setup 時点で既に存在する。
/// ダイアログの裏に隠れたり別 Space に出たりしないよう隠し、フロントが存在しない
/// `AppState` を叩かないよう空ページへ遷移させる。
fn quiesce_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        if let Ok(url) = "about:blank".parse() {
            let _ = window.navigate(url);
        }
    }
}
