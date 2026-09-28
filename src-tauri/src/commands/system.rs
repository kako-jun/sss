use crate::cache_worker::{clear_cache_dir, CacheWorker};
use crate::commands::scan::ScanGuard;
use crate::commands::types::AppState;
use crate::database::Database;
use crate::playlist::Playlist;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// アプリケーションを終了（DB書き込み完了を待ってから安全に終了）
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// 全データ初期化（#64）の中核ロジック: DBリセット・メモリ上のプレイリスト/
/// スキャン対象ディレクトリのクリア・キャッシュクリア・失敗セットのクリア。
///
/// Tauri非依存にすることで、`reset_all_data`コマンド本体（下記）と
/// `tests/reset_all_data_e2e.rs`の両方が同じ実装を呼べるようにする（#79レビュー
/// should4: テストがロジック本体の変更に自動的に追従するように）。
/// `perform_scan`/`perform_restore`（`commands/scan.rs`）と同じ理由で
/// `pub(crate)`ではなく`pub`にする必要がある: `tests/*.rs`はそれぞれ`sss_lib`を
/// external crateとして読み込む別クレート扱いのため、`pub(crate)`だとテストから
/// 呼べない。
///
/// `db`は呼び出し元が既にロック済みの`&Database`を受け取る（`Mutex<Database>`は
/// 受け取らない）。`reset_all_data`コマンドは、このロック（`state.db.lock()`の
/// 戻り値）を`app.restart()`の呼び出しが終わるまで保持し続けることで、reset
/// 直後に処理中の`get_next_image`等（表示回数の加算・`exif_cache`の書き戻し）が
/// リセット後のDBへ古いパスの行を書き戻すのを遮断する（#79レビュー nit。詳細は
/// `reset_all_data`本体のコメント）。
///
/// `cache_dir`は呼び出し元があらかじめ解決済みの値（`AppState::cache_dir`。
/// 起動時に一度だけ`app.path().app_data_dir()`から導出され、以後は変わらない）を
/// そのまま受け取り、ここでは一切追加のfallibleなパス解決を行わない（#79レビュー
/// should1: 旧実装はDBリセットの**後**に`app.path().app_data_dir()`を呼んでおり、
/// それが失敗した場合DBは空なのにアプリは再起動しない不整合な状態になりえた。
/// `AppState::cache_dir`の読み出しは失敗し得ないフィールドアクセスでしかないため、
/// この問題は構造的に起きなくなった）。
pub fn reset_core(
    db: &Database,
    playlist: &Mutex<Option<Playlist>>,
    directory_path: &Mutex<Option<PathBuf>>,
    cache_worker: &CacheWorker,
    cache_dir: &Path,
) -> Result<(), String> {
    // 1. 全ユーザーデータテーブルの中身を1トランザクションで空にし、既定除外ルールを
    //    再投入する（スキーマ・`PRAGMA user_version` は維持）。
    // #80: ユーザー向け文言でなくエラーコード（`dbResetFailed`）で返す。技術的な
    // 詳細はログ（英語のまま）にのみ残す。フロント辞書は `errorDbResetFailed` に
    // 変換する。
    db.reset_to_defaults().map_err(|e| {
        eprintln!("reset_core: failed to reset database: {e}");
        "dbResetFailed".to_string()
    })?;

    // 2. メモリ上のプレイリスト・スキャン対象ディレクトリをクリアする。
    *directory_path.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *playlist.lock().unwrap_or_else(|e| e.into_inner()) = None;

    // 3. キャッシュの中身を削除する（ディレクトリ自体は残す。#60）。
    // cache_dir は起動時に asset scope へ許可済みで、実行中の CacheWorker もこの
    // パスへ書き続けるため、ディレクトリ自体を消すと以後のキャッシュ書込が失敗する。
    // アプリ稼働中に呼ばれるため中身を1件ずつ削除するとワーカーの新規書込と競合しうる。
    // 起動時クリアと同じ rename→再作成の手順（`clear_cache_dir`）でレースを避ける。
    let app_data_dir = cache_dir.parent().unwrap_or(cache_dir);
    clear_cache_dir(app_data_dir, cache_dir);

    // 4. 失敗セットもクリアする。キャッシュを丸ごと作り直すのに、過去の失敗記録が
    //    居座って同じ画像が以後ずっと再試行されなくなるのを防ぐ。
    cache_worker.clear_failed();

    Ok(())
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
///
/// **`tauri dev` 実行時の挙動について（#79レビューshould2、未検証）**: `tauri-cli`
/// のdevは、アプリプロセスの終了時に`beforeDevCommand`（vite dev server）ごと
/// killする可能性が高い。もしそうなら、dev環境で本コマンドを呼ぶとdev serverごと
/// 停止し、再起動後のウィンドウが白画面のまま戻ってこない事故になりうる。
/// この挙動はまだ実機確認していない。**実機での動作確認は`tauri dev`ではなく
/// `tauri build`（`--debug`も可）が生成する、単体で完結した実行ファイルに対して
/// 行うこと。**
#[tauri::command]
pub async fn reset_all_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // スキャンとの排他（#64）。scan_directory と同じ `AtomicBool` を使う `ScanGuard` を
    // 再利用することで、スキャン中の初期化・初期化中のスキャン開始の両方を防ぐ
    // （RAIIガードなので、この後のどの`?`早期returnでも確実に解除される）。
    let _scan_guard = ScanGuard::acquire(&state.scan_in_progress)?;

    // dbロックをこの関数の最後（`app.restart()`の呼び出し）までdropせず保持し続ける
    // （#79レビュー nit）。全DBコマンドは`#[tauri::command] async fn`でtokioの
    // ワーカースレッド上で実行されるため、このロックを握ったまま`app.restart()`が
    // スレッドをブロックし続けても、他のasyncタスクはこのロックの獲得待ちで
    // pendingになるだけでtokio自体は他のワーカースレッドで動き続ける（互いに
    // 相手のロックを待つ循環が無いためデッドロックにはならない。プロセスは
    // ほどなく再起動により終了する）。ロックを早期に解放していた旧実装では、
    // reset直後・プロセス実終了前のごく短い間に処理中だった`get_next_image`等が
    // 古いパスの表示回数をリセット後のDBへ書き戻せてしまう余地があった。
    let db_guard = state.db.lock().unwrap_or_else(|e| e.into_inner());

    reset_core(
        &db_guard,
        &state.playlist,
        &state.directory_path,
        &state.cache_worker,
        &state.cache_dir,
    )?;

    // プロセスを再起動する。`db_guard`をここでdropせず持ち越すことで、上記コメントの
    // 遮断を維持する。`AppHandle::restart`の戻り値は`!`（絶対に戻らない。tauri 2.12.0
    // でも同一を確認）: メインスレッド上での呼び出しなら新プロセスをspawnしてから
    // `exit(0)`、そうでなければ`RunEvent::ExitRequested`/`Exit`をトリガーしてこの
    // 呼び出し自体は戻らずスレッドをブロックし続ける（イベントループが実際の終了処理を
    // 担う）。`?`を挟まずこの関数の最後の式にすることで、`!`が`Result<(), String>`へ
    // 型強制され、以降のコードは書けない（＝書く必要が無い）。
    app.restart()
}
