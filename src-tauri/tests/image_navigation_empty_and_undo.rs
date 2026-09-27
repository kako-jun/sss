//! #65 で追加された `ImageNavigationResult::EmptyPlaylist` 分岐と `undo_display_count`
//! コマンドの回帰テスト。
//!
//! 実装した本人のセルフレビューでは、`ImageNavigationResult` のenumバリアント追加
//! （#65）のうち `EmptyPlaylist`（プレイリストが空）と、新規追加コマンド
//! `undo_display_count`（フロントの `<img>`/`<video>` onError から呼ばれ、
//! 既に加算済みの表示回数を取り消す）が、どちらもコマンド層の統合テストとして
//! 一度もカバーされていなかった。`get_next_image_skip_loop_e2e.rs` と同じ
//! `tauri::test::mock_app()` 手法を使う。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::image::{
    get_next_image, get_previous_image, undo_display_count, ImageNavigationResult,
};
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_image_navigation_empty_and_undo_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_app(
    playlist: Playlist,
    directory_path: Option<PathBuf>,
    cache_dir: PathBuf,
) -> tauri::App<tauri::test::MockRuntime> {
    std::fs::create_dir_all(&cache_dir).unwrap();
    let db = Database::new(cache_dir.join("sss.db")).expect("db init");
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(Some(playlist)),
        directory_path: Mutex::new(directory_path),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
    });
    app
}

/// #65: プレイリストが空（除外ルールで全件除外・スキャン対象0件等）の場合、
/// `get_next_image` は `Err` でも `RootUnavailable` でもなく `EmptyPlaylist` を返す
/// （ディレクトリ自体は設定済みという意味区別。`directory_path` を `None` にして
/// 「ルートは常にアクセス可能」の条件下でプレイリストの空だけを検証する）。
#[test]
fn get_next_image_returns_empty_playlist_when_playlist_is_empty() {
    let dir = workspace("next_empty");
    let playlist = Playlist::new(vec![]);
    let app = build_app(playlist, None, dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state))
        .expect("get_next_imageはエラーにならないはず");

    assert!(
        matches!(result, ImageNavigationResult::EmptyPlaylist),
        "空プレイリストはEmptyPlaylistを返すはず: {result:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 同上、`get_previous_image` 側。
#[test]
fn get_previous_image_returns_empty_playlist_when_playlist_is_empty() {
    let dir = workspace("previous_empty");
    let playlist = Playlist::new(vec![]);
    let app = build_app(playlist, None, dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_previous_image(state))
        .expect("get_previous_imageはエラーにならないはず");

    assert!(
        matches!(result, ImageNavigationResult::EmptyPlaylist),
        "空プレイリストはEmptyPlaylistを返すはず: {result:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65: `undo_display_count` は `get_next_image` が既に加算した表示回数を1減らす。
/// フロントの `<img onError>` から呼ばれる想定の結線をコマンド層で検証する。
#[test]
fn undo_display_count_decrements_the_count_get_next_image_just_incremented() {
    let dir = workspace("undo_after_increment");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();
    let photo_path = root.join("a.jpg");
    std::fs::write(&photo_path, b"fixture").unwrap();
    let photo = photo_path.to_string_lossy().to_string();

    let playlist = Playlist::new(vec![photo.clone()]);
    let app = build_app(playlist, Some(root), dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state.clone()))
        .expect("get_next_imageはエラーにならないはず");
    assert!(
        matches!(result, ImageNavigationResult::Found(_)),
        "唯一の実在ファイルなのでFoundのはず: {result:?}"
    );

    {
        let db = state.db.lock().unwrap();
        let (count, _) = db.get_image_stats(&photo).unwrap();
        assert_eq!(count, 1, "前提: get_next_imageで1加算されているはず");
    }

    tauri::async_runtime::block_on(undo_display_count(state.clone(), photo.clone()))
        .expect("undo_display_countはエラーにならないはず");

    {
        let db = state.db.lock().unwrap();
        let (count, _) = db.get_image_stats(&photo).unwrap();
        assert_eq!(count, 0, "onErrorでの取り消し後は0に戻るはず");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65: 一度も表示されていない（`image_stats` に行が無い）パスに対して
/// `undo_display_count` を呼んでもエラーにならない（二重発火・古い応答等の防御）。
#[test]
fn undo_display_count_on_never_displayed_path_does_not_error() {
    let dir = workspace("undo_unknown");
    let playlist = Playlist::new(vec![]);
    let app = build_app(playlist, None, dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(undo_display_count(
        state.clone(),
        "/never/displayed.jpg".to_string(),
    ));
    assert!(
        result.is_ok(),
        "未登録パスへのundo_display_countはErrにならないはず"
    );

    let db = state.db.lock().unwrap();
    let (count, last) = db.get_image_stats("/never/displayed.jpg").unwrap();
    assert_eq!((count, last), (0, None), "行が新規作成されないはず");

    let _ = std::fs::remove_dir_all(&dir);
}
