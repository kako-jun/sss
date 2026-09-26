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
///
/// 初期化の最後に `app.restart()` でプロセス自体を再起動する。**当初はプロセスを
/// 再起動せず、asset scope（`convertFileSrc` が読み込めるディレクトリ）を
/// `forbid_directory` で明示的に取り消す設計だったが、実測で「`forbid_directory`
/// した後に同じディレクトリへ`allow_directory`しても`is_allowed`はfalseのまま
/// （forbiddenが恒久的に優先され続け、取り消すAPIが無い）」ことが判明し撤回した**
/// （テスト担当が`src-tauri/tests/reset_all_data_e2e.rs`で実測確認済み。詳細は
/// `docs/architecture.md`§5⑤）。この設計では初期化→同じフォルダを選び直す、という
/// ごく普通の操作をしただけで画像が二度と表示できなくなる実装バグだった。
/// プロセスを丸ごと再起動すれば、asset scope・`AppState`のメモリ状態のどちらも
/// 新規プロセスとして最初から構築されるため、この問題は原理的に起きない。
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

    // 2. メモリ上のプレイリスト・スキャン対象ディレクトリをクリアする。この直後に
    //    プロセスごと再起動するため厳密には不要だが、再起動が実際にプロセスを
    //    終了させるまでのごく短い間（下記4番のコメント参照）に他のコマンドが
    //    呼ばれても、古い状態を見せないための保険として残す。
    *state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state.playlist.lock().unwrap_or_else(|e| e.into_inner()) = None;

    // 3. キャッシュの中身を削除する（ディレクトリ自体は残す。#60）。
    // cache_dir は起動時に asset scope へ許可済みで、実行中の CacheWorker もこの
    // パスへ書き続けるため、ディレクトリ自体を消すと以後のキャッシュ書込が失敗する。
    // アプリ稼働中に呼ばれるため中身を1件ずつ削除するとワーカーの新規書込と競合しうる。
    // 起動時クリアと同じ rename→再作成の手順（`clear_cache_dir`）でレースを避ける。
    // rename自体は同期的に完了し、退避先の実削除だけがバックグラウンドスレッドへ
    // 逃がされるため、この直後に4番でプロセスを再起動しても取りこぼさない。
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let cache_dir = app_data_dir.join("cache");
    clear_cache_dir(&app_data_dir, &cache_dir);

    // 4. 失敗セットもクリアする（nit）。キャッシュを丸ごと作り直すのに、過去の失敗記録が
    // 居座って同じ画像が以後ずっと再試行されなくなるのを防ぐ。
    state.cache_worker.clear_failed();

    // 5. プロセスを再起動する。`AppHandle::restart` の戻り値は `!`（絶対に戻らない。
    // tauri 2.10.3 `app.rs`で確認済み）: メインスレッド上での呼び出しなら新プロセスを
    // spawnしてから`exit(0)`、そうでなければ`RunEvent::ExitRequested`/`Exit`を
    // トリガーしてこの呼び出し自体は戻らずスレッドをブロックし続ける（イベントループが
    // 実際の終了処理を担う）。`?`を挟まずこの関数の最後の式にすることで、`!`が
    // `Result<(), String>`へ型強制され、以降のコードは書けない（＝書く必要が無い）。
    //
    // `tauri dev` 実行時の挙動: コンパイル済みのdevバイナリを直接再execするだけで、
    // `npm run tauri dev`のオーケストレーション（vite dev serverの起動）自体は
    // 再実行しない。バイナリに埋め込まれた開発サーバーURLは変わらず、既に立っている
    // vite dev serverへ再接続するだけなので、通常のリリースビルドと同様に動作する。
    app.restart()
}
