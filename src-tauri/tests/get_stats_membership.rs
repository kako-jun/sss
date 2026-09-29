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
use sss_lib::commands::stats::{get_display_stats, get_stats};
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
        last_incremented_display: Mutex::new(None),
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

/// #67: `get_display_stats` はプレイリストのメンバーだけを母集団にしたヒストグラムを返す。
/// `image_stats` に行の無い（一度も表示していない）メンバーは表示回数0として数え、
/// メンバーでなくなったファイル（除外済み）の統計は含めない。
#[test]
fn display_stats_histogram_counts_unshown_members_as_zero_and_skips_non_members() {
    let dir = workspace("histogram");
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let path_of = |name: &str| dir.join(name).to_string_lossy().to_string();
    let (a, b, c, excluded) = (
        path_of("a.jpg"),
        path_of("b.jpg"),
        path_of("c.jpg"),
        path_of("excluded.jpg"),
    );

    let db = Database::new(dir.join("sss.db")).expect("db init");
    db.increment_display_count(&a).unwrap();
    db.increment_display_count(&a).unwrap();
    db.increment_display_count(&b).unwrap();
    // 表示済みだが除外されてメンバーでなくなったファイル
    db.increment_display_count(&excluded).unwrap();

    // c.jpg は image_stats に行が無い（未表示）メンバー
    let playlist = Playlist::new(vec![a, b, c]);

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(Some(playlist)),
        directory_path: Mutex::new(Some(dir.clone())),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
        last_incremented_display: Mutex::new(None),
    });

    let state = app.state::<AppState>();
    let stats = tauri::async_runtime::block_on(get_display_stats(state))
        .expect("get_display_statsは成功するはず");

    assert_eq!(stats.files, 3);
    assert_eq!((stats.min, stats.max), (0, 2));
    assert!((stats.mean - 1.0).abs() < 1e-9, "(2+1+0)/3=1");
    let bins: Vec<(i32, u32)> = stats.bins.iter().map(|b| (b.count, b.files)).collect();
    assert_eq!(bins, vec![(0, 1), (1, 1), (2, 1)]);

    let _ = std::fs::remove_dir_all(&dir);
}
