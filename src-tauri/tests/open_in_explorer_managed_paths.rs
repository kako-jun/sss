//! #92: `open_in_explorer` は管理下（プレイリスト構成員・履歴・ピックフォルダ内）のパス
//! だけを扱い、管理外の任意パスには存在有無に関わらず同一の `pathNotManaged` を返す
//! （存在確認のオラクルにならない）。
//!
//! 正当な呼び出しは実際にファイラを起動してしまうため、ここでは拒否経路と、
//! 管理下だが実在しない場合の `imageFileNotFound`（起動しない経路）だけを検証する。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::file_operations::open_in_explorer;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sss_open_explorer_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn app_in(dir: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let db = Database::new(dir.join("sss.db")).expect("db init");
    db.save_setting(
        "share_directory_path",
        &dir.join("picked").to_string_lossy(),
    )
    .unwrap();
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(None),
        directory_path: Mutex::new(None),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
        last_incremented_display: Mutex::new(None),
    });
    app
}

fn call(app: &tauri::App<tauri::test::MockRuntime>, path: &str) -> Result<(), String> {
    tauri::async_runtime::block_on(open_in_explorer(path.to_string(), app.state::<AppState>()))
}

#[test]
fn unmanaged_paths_get_the_same_rejection_whether_or_not_they_exist() {
    let dir = workspace("oracle");
    let app = app_in(&dir);
    let existing = dir.join("secret.jpg");
    std::fs::write(&existing, b"x").unwrap();
    let missing = dir.join("no-such-file.jpg");

    let rejected = Err("pathNotManaged".to_string());
    assert_eq!(call(&app, &existing.to_string_lossy()), rejected);
    assert_eq!(call(&app, &missing.to_string_lossy()), rejected);
    // `~` 展開は廃止した。展開されていれば（HOME 配下が存在する環境では）通りうる入力なので、
    // 「相対パス扱いで管理外として拒否される」ことを確認する。
    assert_eq!(call(&app, "~"), rejected);
    assert_eq!(call(&app, "~/Documents"), rejected);
    assert_eq!(call(&app, "secret.jpg"), rejected);
    // ピック先を実在させたうえで `..` による脱出（ピック先の外の実在ファイル）を拒否する。
    let picked = dir.join("picked");
    std::fs::create_dir_all(&picked).unwrap();
    let escape = picked.join("..").join("secret.jpg");
    assert!(
        escape.exists(),
        "脱出先は実在している（canonicalize が成功する）"
    );
    assert_eq!(call(&app, &escape.to_string_lossy()), rejected);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_registered_but_missing_file_reports_image_file_not_found() {
    let dir = workspace("known-missing");
    let app = app_in(&dir);
    let gone = dir.join("lib").join("gone.jpg");
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&gone.to_string_lossy(), 1, 1)
        .unwrap();

    // 管理下と確認できたパスなので、実在しないことを伝えてよい（ファイラは起動しない）。
    assert_eq!(
        call(&app, &gone.to_string_lossy()),
        Err("imageFileNotFound".to_string())
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_symlink_in_the_picked_folder_pointing_outside_is_rejected() {
    let dir = workspace("symlink");
    let app = app_in(&dir);
    let picked = dir.join("picked");
    std::fs::create_dir_all(&picked).unwrap();
    let secret = dir.join("secret.jpg");
    std::fs::write(&secret, b"x").unwrap();
    let link = picked.join("link.jpg");
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    assert_eq!(
        call(&app, &link.to_string_lossy()),
        Err("pathNotManaged".to_string())
    );
    let _ = std::fs::remove_dir_all(&dir);
}
