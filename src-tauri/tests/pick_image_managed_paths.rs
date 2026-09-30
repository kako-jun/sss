//! #87: `pick_image` は管理下（プレイリスト構成員・履歴・ピックフォルダ内）のメディア
//! ファイルだけをコピーし、任意の絶対パス・非メディア拡張子は拒否する。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::file_operations::pick_image;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sss_pick_image_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// ピック先を `dir/picked` に固定したアプリを作る。
fn app_in(dir: &std::path::Path) -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let picked = dir.join("picked");
    let db = Database::new(dir.join("sss.db")).expect("db init");
    db.save_setting("share_directory_path", &picked.to_string_lossy())
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
    (app, picked)
}

fn call(
    app: &tauri::App<tauri::test::MockRuntime>,
    path: &std::path::Path,
) -> Result<String, String> {
    tauri::async_runtime::block_on(pick_image(
        path.to_string_lossy().to_string(),
        app.state::<AppState>(),
        app.handle().clone(),
    ))
}

#[test]
fn playlist_member_is_copied_into_the_picked_folder() {
    let dir = workspace("ok");
    let (app, picked) = app_in(&dir);
    let src = dir.join("lib").join("a.jpg");
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    std::fs::write(&src, b"jpeg").unwrap();
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&src.to_string_lossy(), 1, 4)
        .unwrap();

    // ピック先（dir/picked）は未作成の状態から始まり、pick_image が作成してコピーする。
    assert!(!picked.exists());
    let dest = PathBuf::from(call(&app, &src).expect("管理下のパスはコピーできる"));
    assert!(dest.starts_with(&picked));
    assert_eq!(std::fs::read(dest).unwrap(), b"jpeg");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unmanaged_or_non_media_sources_are_rejected_and_nothing_is_copied() {
    let dir = workspace("ng");
    let (app, picked) = app_in(&dir);
    let secret = dir.join("secret.jpg");
    let text = dir.join("notes.txt");
    std::fs::write(&secret, b"x").unwrap();
    std::fs::write(&text, b"x").unwrap();
    // 拡張子違いはたとえ DB 登録済みでも拒否（メディアのみ）。
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&text.to_string_lossy(), 1, 1)
        .unwrap();

    assert_eq!(call(&app, &secret), Err("pathNotManaged".to_string()));
    assert_eq!(
        call(&app, &picked.join("..").join("secret.jpg")),
        Err("pathNotManaged".to_string())
    );
    assert_eq!(
        call(&app, std::path::Path::new("secret.jpg")),
        Err("pathNotManaged".to_string())
    );
    assert_eq!(call(&app, &text), Err("notMediaFile".to_string()));
    assert!(
        !picked.exists() || std::fs::read_dir(&picked).unwrap().next().is_none(),
        "何もコピーされない"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// #87 M1: WebView が保存値を広いパス（`/`）に書き換えても、検証付き解決が既定へ
/// フォールバックするため、管理外ファイルは依然として拒否される。
#[cfg(unix)]
#[test]
fn a_widened_share_directory_setting_does_not_widen_the_managed_area() {
    let dir = workspace("widened");
    let (app, _picked) = app_in(&dir);
    let secret = dir.join("secret.jpg");
    std::fs::write(&secret, b"x").unwrap();
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .save_setting("share_directory_path", "/")
        .unwrap();

    assert_eq!(call(&app, &secret), Err("pathNotManaged".to_string()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// ピックフォルダ内にあるがフォルダ外を指すシンボリックリンクは拒否される。
#[cfg(unix)]
#[test]
fn a_symlink_in_the_picked_folder_pointing_outside_is_rejected() {
    let dir = workspace("symlink");
    let (app, picked) = app_in(&dir);
    std::fs::create_dir_all(&picked).unwrap();
    let secret = dir.join("secret.jpg");
    std::fs::write(&secret, b"x").unwrap();
    let link = picked.join("link.jpg");
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    assert_eq!(call(&app, &link), Err("pathNotManaged".to_string()));
    let _ = std::fs::remove_dir_all(&dir);
}
