//! #67: `get_thumbnail` コマンドの分岐（動画はディスクに触らず Video、非画像は Err、
//! 画像は縮小 JPEG のパス）。`tauri::test::mock_app()` で `State` を用意して直接呼ぶ
//! （`tests/display_stats_membership.rs` と同じ手法）。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::file_operations::{get_thumbnail, ThumbnailResult};
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sss_get_thumbnail_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn app_in(dir: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(Database::new(dir.join("sss.db")).expect("db init")),
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
) -> Result<ThumbnailResult, String> {
    let state = app.state::<AppState>();
    tauri::async_runtime::block_on(get_thumbnail(path.to_string_lossy().to_string(), state))
}

/// 動画は拡張子だけで判定し、原本にもキャッシュにも触らない（存在しないパスでも Video）。
#[test]
fn uppercase_video_extension_returns_video_without_touching_the_disk() {
    let dir = workspace("video");
    let app = app_in(&dir);

    for name in ["clip.MP4", "clip.WebM", "clip.m4v", "clip.OGV"] {
        let result = call(&app, &dir.join("does-not-exist").join(name));
        assert_eq!(result, Ok(ThumbnailResult::Video), "{name}");
    }
    assert!(
        !dir.join("cache").join("thumbs").exists(),
        "動画ではサムネイル用ディレクトリすら作らない"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn non_image_extensions_are_rejected_before_any_decoding() {
    let dir = workspace("non_image");
    let app = app_in(&dir);
    for name in ["notes.txt", "README", "archive.zip", "old.avi"] {
        let path = dir.join(name);
        std::fs::write(&path, b"not an image").unwrap();
        assert_eq!(
            call(&app, &path),
            Err("Not a supported image file".to_string()),
            "{name}"
        );
    }
    assert!(!dir.join("cache").join("thumbs").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

fn write_png(path: &std::path::Path) {
    image::RgbImage::from_pixel(800, 400, image::Rgb([5, 50, 150]))
        .save_with_format(path, image::ImageFormat::Png)
        .unwrap();
}

/// ピック先を `dir/picked` に固定する（既定の `<Pictures>/sss-picked` は実環境に依存するため）。
fn set_picked_dir(app: &tauri::App<tauri::test::MockRuntime>, dir: &std::path::Path) -> PathBuf {
    let picked = dir.join("picked");
    std::fs::create_dir_all(&picked).unwrap();
    app.state::<AppState>()
        .db
        .lock()
        .unwrap()
        .save_setting("share_directory_path", &picked.to_string_lossy())
        .unwrap();
    picked
}

fn expect_thumb(
    app: &tauri::App<tauri::test::MockRuntime>,
    dir: &std::path::Path,
    src: &std::path::Path,
) {
    match call(app, src).expect("管理下の画像は成功するはず") {
        ThumbnailResult::Image { path } => {
            let path = PathBuf::from(path);
            assert!(path.starts_with(dir.join("cache").join("thumbs")));
            assert_eq!(image::open(&path).unwrap().width(), 256);
        }
        other => panic!("Image を期待: {other:?}"),
    }
}

/// プレイリスト構成員（file_metadata）・表示履歴（image_stats）のパスは通る。
#[test]
fn playlist_member_and_history_images_return_a_thumbnail_under_the_cache_thumbs_dir() {
    let dir = workspace("image");
    let app = app_in(&dir);
    set_picked_dir(&app, &dir);
    let member = dir.join("big.PNG");
    let history = dir.join("seen.png");
    write_png(&member);
    write_png(&history);
    {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.upsert_file_metadata(&member.to_string_lossy(), 1, 1)
            .unwrap();
        db.increment_display_count(&history.to_string_lossy())
            .unwrap();
    }

    expect_thumb(&app, &dir, &member);
    expect_thumb(&app, &dir, &history);
    let _ = std::fs::remove_dir_all(&dir);
}

/// ピック先フォルダ内のファイル（DB 未登録でも）は通る。
#[test]
fn picked_folder_image_is_allowed_without_a_db_row() {
    let dir = workspace("picked_ok");
    let app = app_in(&dir);
    let picked = set_picked_dir(&app, &dir);
    let src = picked.join("p.png");
    write_png(&src);
    expect_thumb(&app, &dir, &src);
    let _ = std::fs::remove_dir_all(&dir);
}

/// #87: 管理外の絶対パス・相対パス・`..` 経由・ピック先フォルダ外を指すシンボリックリンクは
/// デコードせず `pathNotManaged`（サムネイルも作らない）。
#[test]
fn unmanaged_paths_are_rejected_without_decoding() {
    let dir = workspace("unmanaged");
    let app = app_in(&dir);
    let picked = set_picked_dir(&app, &dir);
    let secret = dir.join("secret.png");
    write_png(&secret);
    let expected = Err("pathNotManaged".to_string());

    assert_eq!(call(&app, &secret), expected);
    assert_eq!(call(&app, &picked.join("..").join("secret.png")), expected);
    assert_eq!(call(&app, std::path::Path::new("secret.png")), expected);
    #[cfg(unix)]
    {
        let link = picked.join("link.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert_eq!(call(&app, &link), expected);
    }
    assert!(!dir.join("cache").join("thumbs").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
