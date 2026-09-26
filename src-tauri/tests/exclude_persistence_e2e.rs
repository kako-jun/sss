//! #62レビュー M2(must) の回帰テスト: `exclude_image`（ファイル除外）が
//! `Playlist::update_images` でメンバーシップを変えた後、必ず保存されることを
//! 実際の Tauri コマンド経由で確認する。
//!
//! 修正前は `exclude_image` が `update_images` を呼ぶだけで保存していなかったため、
//! 除外した直後にアプリを再起動する（DBから再度プレイリストを読み直す）と、
//! 除外したはずの画像がプレイリストに復活し、以後の巡でまた表示される
//! （＝表示済みの他の画像と合わせて実質的な二重表示・過剰表示になる）バグがあった。
//!
//! `#[tauri::command]` な非同期関数は `State<'_, AppState>` を引数に取るため、
//! `tauri::test::mock_app()`（`get_next_image_missing_file.rs` と同じ手法）で
//! 最小の Tauri App を作り、`exclude_image`/`get_next_image` を直接呼ぶ。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::file_operations::exclude_image;
use sss_lib::commands::image::get_next_image;
use sss_lib::commands::scan::perform_scan;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_exclude_persistence_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn excluding_a_file_then_advancing_then_restarting_does_not_resurrect_it() {
    let dir = workspace("exclude_restart");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();

    const TOTAL: usize = 6;
    for i in 0..TOTAL {
        std::fs::write(photos_dir.join(format!("img{i}.jpg")), b"fixture").unwrap();
    }
    let excluded_path = photos_dir.join("img0.jpg").to_string_lossy().to_string();

    let db_path = dir.join("sss.db");
    let db_mutex = Mutex::new(Database::new(db_path.clone()).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);

    // 初回スキャンでプレイリストを作る（perform_scan自体がsave_playlist_fullまで行う）。
    perform_scan(&db_mutex, &playlist_mutex, None, &photos_dir, |_, _| {})
        .expect("初回scanは成功するはず");

    let db = db_mutex.into_inner().unwrap();
    let playlist = playlist_mutex.into_inner().unwrap();

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(playlist),
        // scan_directory コマンド本体が行うのと同じく、スキャン対象を directory_path に
        // 設定しておく（exclude_image の保存はこれを見て directory_path を決める）。
        directory_path: Mutex::new(Some(photos_dir.clone())),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
    });

    let state = app.state::<AppState>();

    // img0.jpg をファイル除外する。
    tauri::async_runtime::block_on(exclude_image(
        excluded_path.clone(),
        "file".to_string(),
        state.clone(),
    ))
    .expect("exclude_imageは成功するはず");

    // 除外直後、メモリ上のプレイリストにはもう含まれていないはず。
    {
        let playlist_lock = state.playlist.lock().unwrap();
        let playlist = playlist_lock.as_ref().unwrap();
        assert_eq!(playlist.total_count(), TOTAL - 1);
        assert!(!playlist.current_paths().contains(&excluded_path));
    }

    // 何回か advance してプレイリストを進める（get_next_imageの永続化フックも走る）。
    for _ in 0..3 {
        let _ = tauri::async_runtime::block_on(get_next_image(state.clone()));
    }

    // 「アプリ再起動」を模して、同じDBファイルから独立に読み直す
    // （AppStateとは別に、生のDatabase/Playlistで検証する）。
    let fresh_db = Database::new(db_path.clone()).expect("再起動時のDB再オープン");
    let (saved_dir, shuffled_list, next_index, history, history_position) = fresh_db
        .load_playlist_state()
        .expect("load_playlist_stateはエラーにならないはず")
        .expect("exclude_image後のadvanceでフル保存済みのはず");
    assert_eq!(saved_dir, photos_dir.to_string_lossy());

    assert!(
        !shuffled_list.contains(&excluded_path),
        "#62レビューM2: 除外した画像が保存済みプレイリストに復活してはいけない\
         (exclude_imageのupdate_images後の保存漏れが再現していないか)"
    );
    assert_eq!(
        shuffled_list.len(),
        TOTAL - 1,
        "保存済みプレイリストの件数も除外後の件数のままのはず"
    );

    let restored = Playlist::from_persisted(shuffled_list, next_index, history, history_position);
    assert!(!restored.current_paths().contains(&excluded_path));

    // 復元後、残りを最後まで進めても除外した画像は一度も出てこない。
    let mut restored = restored;
    for _ in 0..restored.total_count() {
        let (img, _, _) = restored.advance();
        if let Some(path) = img {
            assert_ne!(
                path, &excluded_path,
                "除外した画像は復元後の巡でも一度も表示されてはいけない"
            );
        }
    }

    let _ = std::fs::remove_dir_all(&dir);
}
