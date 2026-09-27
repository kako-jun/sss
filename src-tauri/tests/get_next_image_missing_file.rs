//! get_next_image が「プレイリスト上は次の画像だが、実ファイルが既に存在しない」
//! ケースで表示回数を加算しないことを機械検証する（#60 問題9）。
//!
//! `Playlist::advance()` はプレイリスト上「新規に進んだ画像」であれば
//! should_count=true を返す（履歴内を戻っただけかどうかしか見ていない＝
//! ファイルの実在は関知しない）。一方 `get_next_image` は
//! `get_image_info_internal` がファイル不在で `Ok(None)` を返した場合、
//! `info.is_some() && should_count` の短絡でカウント加算をスキップする。
//!
//! この結線をテストで剥がさないよう、DB に事前に display_count=1 を仕込んでおき、
//! 加算されていれば2に、されていなければ1のままであることで検出する
//! （0のままという弱い主張だと「そもそも一度も加算されていない」ケースと
//! 区別できないため）。
//!
//! #[tauri::command] な非同期関数は `State<'_, AppState>` を引数に取るため、
//! `tauri::test::mock_app()`（dev-dependencies にのみ追加した `test` フィーチャ、
//! resolver v2 により通常ビルドには混入しない）で最小の Tauri App を作り、
//! `Manager::manage` / `Manager::state` で `State` を得てから直接関数呼び出しする。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::image::{get_next_image, ImageNavigationResult};
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sss_get_next_image_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn get_next_image_does_not_increment_display_count_for_missing_file() {
    let dir = workspace("missing");
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let missing_path = dir.join("was-deleted.jpg").to_string_lossy().to_string();
    assert!(
        !std::path::Path::new(&missing_path).exists(),
        "フィクスチャ前提: このパスにファイルがあってはいけない"
    );

    let db = Database::new(dir.join("sss.db")).expect("db init");
    // 事前に1回分カウントしておく。加算されれば2、されなければ1のまま。
    db.increment_display_count(&missing_path)
        .expect("seed display count");
    assert_eq!(
        db.get_image_stats(&missing_path).unwrap().0,
        1,
        "seed が効いていない"
    );

    // 単一要素のプレイリスト。advance() は新規画像として should_count=true を返す
    // （プレイリストはファイルの実在を関知しない）。
    let playlist = Playlist::new(vec![missing_path.clone()]);

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(Some(playlist)),
        directory_path: Mutex::new(None),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
    });

    let state = app.state::<AppState>();
    let result = tauri::async_runtime::block_on(get_next_image(state));

    let info = result.expect("get_next_image はエラーにならないはず");
    assert!(
        matches!(info, ImageNavigationResult::LoadFailed),
        "存在しないファイルしか無いので LoadFailed を返すはず（#65: 旧 None 相当）"
    );

    let state = app.state::<AppState>();
    let db_lock = state.db.lock().unwrap();
    let (count, _) = db_lock.get_image_stats(&missing_path).unwrap();
    assert_eq!(
        count, 1,
        "存在しないファイルへ advance した場合に表示回数が加算されてはいけない"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
