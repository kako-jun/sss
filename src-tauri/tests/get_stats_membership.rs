//! #63 PR#77レビュー2巡目 nit の直接回帰テスト: `get_stats` の `displayed_images` は
//! 「現在のディレクトリ配下」だけでなく「現在のプレイリスト（除外ルール適用後の
//! 含める集合）のメンバー」だけを数えること。
//!
//! ディレクトリ配下限定だけでは、表示した後に除外ルールが付いたファイル
//! （`image_stats` には `display_count > 0` が残るが、プレイリストのメンバーでは
//! なくなっている）がまだ数に含まれてしまい、`displayed_images` が `total_images`
//! （プレイリストの総数）を超える矛盾したケースがあった。
//!
//! `#[tauri::command]` な非同期関数は `State<'_, AppState>` を引数に取るため、
//! `tauri::test::mock_app()` で最小の Tauri App を作り、直接関数呼び出しする
//! （`tests/get_next_image_missing_file.rs` と同じ手法）。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::stats::get_stats;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_get_stats_membership_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn displayed_images_only_counts_current_playlist_members_not_all_files_under_directory() {
    let dir = workspace("scoped");
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let a_path = dir.join("a.jpg").to_string_lossy().to_string();
    let b_path = dir.join("b.jpg").to_string_lossy().to_string();

    let db = Database::new(dir.join("sss.db")).expect("db init");
    // a.jpg は「表示済みだが後で除外ルールが付いた」想定：image_statsには残るが、
    // プレイリストのメンバーではない。b.jpgは現在もプレイリストのメンバー。
    db.increment_display_count(&a_path).unwrap();
    db.increment_display_count(&b_path).unwrap();

    // プレイリストのメンバーはb.jpgだけ（a.jpgは除外ルールで対象外になった想定）。
    let playlist = Playlist::new(vec![b_path.clone()]);

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(Some(playlist)),
        directory_path: Mutex::new(Some(dir.clone())),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
    });

    let state = app.state::<AppState>();
    let stats = tauri::async_runtime::block_on(get_stats(state)).expect("get_statsは成功するはず");

    assert_eq!(
        stats.total_images, 1,
        "プレイリストのメンバーはb.jpgの1件だけのはず"
    );
    assert_eq!(
        stats.displayed_images, 1,
        "displayed_imagesはプレイリストのメンバー(b.jpg)だけを数え、\
         メンバーでなくなったa.jpgの表示済み統計は含まないはず（total_imagesを超えてはいけない）"
    );
    assert!(
        stats.displayed_images <= stats.total_images,
        "displayed_imagesがtotal_imagesを超えてはいけない: {}/{}",
        stats.displayed_images,
        stats.total_images
    );

    let _ = std::fs::remove_dir_all(&dir);
}
