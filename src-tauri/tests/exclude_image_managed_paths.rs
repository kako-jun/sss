//! #92: `exclude_image` は DB 登録済み（プレイリスト構成員・表示履歴）のパスだけを扱う。
//! 管理外の任意パスには、存在有無・EXIF の有無に関わらず同一の `pathNotManaged` を返し
//! （存在確認・EXIF 撮影日のオラクルにならない）、除外ルールも追加しない。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::file_operations::exclude_image;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("sss_exclude_managed_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn app_in(dir: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let db = Database::new(dir.join("sss.db")).expect("db init");
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

fn call(
    app: &tauri::App<tauri::test::MockRuntime>,
    path: &std::path::Path,
    exclude_type: &str,
) -> Result<bool, String> {
    // 戻り値は `rule_added`（除外ルールを新規追加したか）だけ取り出す。
    tauri::async_runtime::block_on(exclude_image(
        path.to_string_lossy().to_string(),
        exclude_type.to_string(),
        app.state::<AppState>(),
    ))
    .map(|outcome| outcome.rule_added)
}

fn rule_count(app: &tauri::App<tauri::test::MockRuntime>) -> usize {
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .get_ignore_rules()
        .unwrap()
        .len()
}

#[test]
fn unmanaged_paths_are_rejected_identically_for_every_type_and_leave_no_trace() {
    let dir = workspace("reject");
    let app = app_in(&dir);
    let existing = dir.join("secret.jpg");
    std::fs::write(&existing, b"not really a jpeg").unwrap();
    let missing = dir.join("no-such-file.jpg");
    let rules_before = rule_count(&app);

    let rejected = Err("pathNotManaged".to_string());
    for kind in ["date", "file", "directory"] {
        // 実在・不在・相対パスで応答が同一（存在確認のオラクルにならない）。
        assert_eq!(call(&app, &existing, kind), rejected, "{kind}");
        assert_eq!(call(&app, &missing, kind), rejected, "{kind}");
        assert_eq!(
            call(&app, std::path::Path::new("secret.jpg"), kind),
            rejected,
            "{kind}"
        );
    }
    // 除外ルールは増えず、image_stats（表示履歴）にも行が作られない。
    assert_eq!(rule_count(&app), rules_before);
    assert!(!app
        .state::<AppState>()
        .db
        .lock()
        .unwrap()
        .is_known_media_path(&existing.to_string_lossy())
        .unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_date_exclusion_of_an_unmanaged_file_never_reaches_the_exif_reader() {
    // 管理外なら EXIF 読み取りの結果（noExifDate / exifReadFailed）ではなく
    // 常に pathNotManaged。登録済みなら従来どおり EXIF 側の結果が返る。
    let dir = workspace("date");
    let app = app_in(&dir);
    let unmanaged = dir.join("a.jpg");
    let managed = dir.join("b.jpg");
    std::fs::write(&unmanaged, b"x").unwrap();
    std::fs::write(&managed, b"x").unwrap();
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&managed.to_string_lossy(), 1, 1)
        .unwrap();

    assert_eq!(
        call(&app, &unmanaged, "date"),
        Err("pathNotManaged".to_string())
    );
    let managed_result = call(&app, &managed, "date");
    assert!(
        matches!(
            managed_result.as_deref(),
            Err("noExifDate") | Err("exifReadFailed")
        ),
        "登録済みパスは EXIF 側の結果になる: {managed_result:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn registered_paths_can_still_be_excluded_by_file_and_directory() {
    let dir = workspace("ok");
    let app = app_in(&dir);
    let photo = dir.join("lib").join("a.jpg");
    std::fs::create_dir_all(photo.parent().unwrap()).unwrap();
    std::fs::write(&photo, b"x").unwrap();
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&photo.to_string_lossy(), 1, 1)
        .unwrap();

    let rules_before = rule_count(&app);
    assert_eq!(
        call(&app, &photo, "file"),
        Ok(true),
        "登録済みパスはファイル除外できる"
    );
    assert_eq!(
        call(&app, &photo, "directory"),
        Ok(true),
        "登録済みパスはフォルダ除外できる"
    );
    assert_eq!(rule_count(&app), rules_before + 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_registered_but_missing_file_reports_image_file_not_found() {
    let dir = workspace("missing");
    let app = app_in(&dir);
    let gone = dir.join("gone.jpg");
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&gone.to_string_lossy(), 1, 1)
        .unwrap();
    assert_eq!(
        call(&app, &gone, "file"),
        Err("imageFileNotFound".to_string())
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_registered_path_swapped_for_a_symlink_is_rejected() {
    let dir = workspace("symlink");
    let app = app_in(&dir);
    let secret = dir.join("secret.jpg");
    std::fs::write(&secret, b"x").unwrap();
    let link = dir.join("link.jpg");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .upsert_file_metadata(&link.to_string_lossy(), 1, 1)
        .unwrap();

    assert_eq!(call(&app, &link, "date"), Err("pathNotManaged".to_string()));
    let _ = std::fs::remove_dir_all(&dir);
}
