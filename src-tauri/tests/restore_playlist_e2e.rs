//! #62レビュー S1 の回帰テスト: `restore_playlist` コマンドが、保存済みプレイリスト
//! 状態を「スキャン完了を待たずに」復元できることを確認する。
//!
//! フロントは起動直後にまずこのコマンドを呼び、`true` が返ればスキャン完了を
//! 待たずに `get_next_image` を呼んで表示を始める（スキャンはバックグラウンド）。
//! `false`（保存が無い/ディレクトリ不一致）ならスキャン完了を待つ従来のフローに
//! フォールバックする。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::scan::{perform_scan, restore_playlist};
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_restore_playlist_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_app(db: Database, cache_dir: PathBuf) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(None),
        directory_path: Mutex::new(None),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
    });
    app
}

#[test]
fn restore_playlist_returns_true_and_populates_state_when_directory_matches() {
    let dir = workspace("match");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    for i in 0..5 {
        std::fs::write(photos_dir.join(format!("img{i}.jpg")), b"x").unwrap();
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex, None, &photos_dir, |_, _| {}).unwrap();
    // 保存済み状態を作った後、テスト用のDB/AppStateへ引き継ぐ。
    let db = db_mutex.into_inner().unwrap();

    let app = build_app(db, dir.join("cache"));
    let state = app.state::<AppState>();

    let restored = tauri::async_runtime::block_on(restore_playlist(
        photos_dir.to_string_lossy().to_string(),
        state.clone(),
    ))
    .expect("restore_playlistはエラーにならないはず");

    assert!(
        restored,
        "保存済み状態と一致するディレクトリなら復元できるはず"
    );
    {
        let playlist_lock = state.playlist.lock().unwrap();
        let playlist = playlist_lock.as_ref().expect("復元済みのはず");
        assert_eq!(playlist.total_count(), 5);
    }
    {
        let dir_lock = state.directory_path.lock().unwrap();
        assert_eq!(dir_lock.as_deref(), Some(photos_dir.as_path()));
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn restore_playlist_returns_false_when_no_state_was_ever_saved() {
    let dir = workspace("no_state");
    let db = Database::new(dir.join("sss.db")).expect("db init");
    let app = build_app(db, dir.join("cache"));
    let state = app.state::<AppState>();

    let restored = tauri::async_runtime::block_on(restore_playlist(
        "/some/never/scanned/dir".to_string(),
        state.clone(),
    ))
    .unwrap();

    assert!(!restored, "保存が無ければ復元できないはず");
    assert!(state.playlist.lock().unwrap().is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn restore_playlist_returns_false_when_directory_does_not_match_saved_state() {
    let dir = workspace("mismatch");
    let photos_dir_a = dir.join("a");
    let photos_dir_b = dir.join("b");
    std::fs::create_dir_all(&photos_dir_a).unwrap();
    std::fs::create_dir_all(&photos_dir_b).unwrap();
    std::fs::write(photos_dir_a.join("img.jpg"), b"x").unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex, None, &photos_dir_a, |_, _| {}).unwrap();
    let db = db_mutex.into_inner().unwrap();

    let app = build_app(db, dir.join("cache"));
    let state = app.state::<AppState>();

    // 保存されているのはフォルダAだが、フォルダBを指定して復元を試みる。
    let restored = tauri::async_runtime::block_on(restore_playlist(
        photos_dir_b.to_string_lossy().to_string(),
        state.clone(),
    ))
    .unwrap();

    assert!(
        !restored,
        "保存済みと異なるディレクトリなら復元できないはず"
    );
    assert!(state.playlist.lock().unwrap().is_none());
    assert!(state.directory_path.lock().unwrap().is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー S2: ディレクトリ比較は正規化キーで行うため、末尾に区切り文字が
/// 付いた表記（フロントから渡ってきた微妙に異なる文字列表現）でも一致する。
#[test]
fn restore_playlist_matches_directory_with_trailing_separator_variant() {
    let dir = workspace("trailing_sep");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    std::fs::write(photos_dir.join("img.jpg"), b"x").unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex, None, &photos_dir, |_, _| {}).unwrap();
    let db = db_mutex.into_inner().unwrap();

    let app = build_app(db, dir.join("cache"));
    let state = app.state::<AppState>();

    let with_trailing_slash = format!("{}/", photos_dir.to_string_lossy());
    let restored =
        tauri::async_runtime::block_on(restore_playlist(with_trailing_slash, state.clone()))
            .unwrap();

    assert!(
        restored,
        "末尾区切りの有無だけの違いは正規化キーで同一視されるはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
