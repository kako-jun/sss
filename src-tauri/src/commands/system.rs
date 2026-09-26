use crate::cache_worker::clear_cache_dir;
use crate::commands::scan::ScanGuard;
use crate::commands::types::AppState;
use tauri::{AppHandle, Manager, State};

/// アプリケーションを終了（DB書き込み完了を待ってから安全に終了）
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// すべての設定とデータを初期化する（#64: DBファイルは削除せず、開いた接続のまま
/// 全ユーザーデータテーブルを空にして既定状態に戻す。旧実装はDBファイル自体を
/// `remove_file` していたが、実行中のTauriプロセスが同じ接続を保持し続けるため、
/// 別プロセス（例: エクスプローラーでファイルを開いている等）がいなくても
/// Windowsではファイルロックで削除に失敗しうる不安定さがあった）。
#[tauri::command]
pub async fn reset_all_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // スキャンとの排他（#64）。scan_directory と同じ `AtomicBool` を使う `ScanGuard` を
    // 再利用することで、スキャン中の初期化・初期化中のスキャン開始の両方を防ぐ
    // （RAIIガードなので、この後のどの`?`早期returnでも確実に解除される）。
    let _scan_guard = ScanGuard::acquire(&state.scan_in_progress)?;

    // 1. DBは開いたまま、全ユーザーデータテーブルの中身を1トランザクションで空にし、
    //    既定除外ルールを再投入する（スキーマ・`PRAGMA user_version` は維持）。
    {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.reset_to_defaults()
            .map_err(|e| format!("データベースの初期化に失敗しました: {e}"))?;
    }

    // 2. メモリ上のプレイリスト・スキャン対象ディレクトリをクリアする。
    //    directory_path は forbid_directory（後述）で使うため take() で退避してから空にする。
    let previous_directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    *state.playlist.lock().unwrap_or_else(|e| e.into_inner()) = None;

    // 3. asset scope（convertFileSrc が読み込めるディレクトリ）で許可していた旧スキャン対象を
    //    明示的に取り消す。`tauri::scope::fs::Scope::forbid_directory` は
    //    `forbidden_patterns` に追加するだけで、`is_allowed()` は forbidden を allowed より
    //    常に優先判定する（tauri 2.10.3 `scope/fs.rs` の実装・テストで確認済み）ため、
    //    再起動なしに即座に旧フォルダへのアクセスを拒否できる。`allow_directory` で
    //    許可した pattern 自体は残るが、`forbid_directory` が優先されるため実害はない。
    if let Some(dir) = previous_directory {
        if let Err(e) = app.asset_protocol_scope().forbid_directory(&dir, true) {
            eprintln!("Failed to forbid asset scope for {}: {e}", dir.display());
        }
    }

    // 4. キャッシュの中身を削除する（ディレクトリ自体は残す。#60）。
    // cache_dir は起動時に asset scope へ許可済みで、実行中の CacheWorker もこの
    // パスへ書き続けるため、ディレクトリ自体を消すと以後のキャッシュ書込が失敗する。
    // アプリ稼働中に呼ばれるため中身を1件ずつ削除するとワーカーの新規書込と競合しうる。
    // 起動時クリアと同じ rename→再作成の手順（`clear_cache_dir`）でレースを避ける。
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let cache_dir = app_data_dir.join("cache");
    clear_cache_dir(&app_data_dir, &cache_dir);

    // 5. 失敗セットもクリアする（nit）。キャッシュを丸ごと作り直すのに、過去の失敗記録が
    // 居座って同じ画像が以後ずっと再試行されなくなるのを防ぐ。
    state.cache_worker.clear_failed();

    Ok(())
}
