//! `get_display_stats` の母集団と境界の回帰テスト。
//!
//! 母集団は「現在のプレイリスト（除外ルール適用後の含める集合）のメンバー」だけ。
//! 表示した後に除外ルールが付いたファイル（`image_stats` には `display_count > 0` が
//! 残るが、プレイリストのメンバーではなくなっている）は数えず、一度も表示していない
//! メンバーは表示回数0として数える（#63 PR#77 レビューの回帰。#67 で旧 `get_stats` は
//! 廃止し、統計タブの「表示済み / 全体」もこのヒストグラムから導く）。
//!
//! `#[tauri::command]` な非同期関数は `State<'_, AppState>` を引数に取るため、
//! `tauri::test::mock_app()` で最小の Tauri App を作り、直接関数呼び出しする
//! （`tests/get_next_image_missing_file.rs` と同じ手法）。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::stats::get_display_stats;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_display_stats_membership_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
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

/// 統計テスト用の最小 AppState を組み立てて `mock_app` に載せる。
fn app_with(
    dir: &std::path::Path,
    db: Database,
    playlist: Option<Playlist>,
    directory_path: Option<PathBuf>,
) -> tauri::App<tauri::test::MockRuntime> {
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(playlist),
        directory_path: Mutex::new(directory_path),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
        last_incremented_display: Mutex::new(None),
    });
    app
}

fn display_stats_of(
    app: &tauri::App<tauri::test::MockRuntime>,
) -> sss_lib::commands::stats::DisplayStats {
    let state = app.state::<AppState>();
    tauri::async_runtime::block_on(get_display_stats(state))
        .expect("get_display_statsは成功するはず")
}

fn bins_of(stats: &sss_lib::commands::stats::DisplayStats) -> Vec<(i32, u32)> {
    stats.bins.iter().map(|b| (b.count, b.files)).collect()
}

/// #67 QA: 全員未表示（image_stats が空）なら 0 に全員が入った単一 bin になる。
#[test]
fn display_stats_when_nobody_was_shown_is_a_single_zero_bin() {
    let dir = workspace("all_unshown");
    let members: Vec<String> = (0..5)
        .map(|i| dir.join(format!("{i}.jpg")).to_string_lossy().to_string())
        .collect();
    let db = Database::new(dir.join("sss.db")).expect("db init");
    let app = app_with(&dir, db, Some(Playlist::new(members)), Some(dir.clone()));

    let stats = display_stats_of(&app);
    assert_eq!(stats.files, 5);
    assert_eq!((stats.min, stats.max), (0, 0));
    assert_eq!(stats.mean, 0.0);
    assert_eq!(bins_of(&stats), vec![(0, 5)]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn display_stats_with_a_single_member_reports_files_1() {
    let dir = workspace("one_member");
    let only = dir.join("only.jpg").to_string_lossy().to_string();
    let db = Database::new(dir.join("sss.db")).expect("db init");
    db.increment_display_count(&only).unwrap();
    let app = app_with(&dir, db, Some(Playlist::new(vec![only])), Some(dir.clone()));

    let stats = display_stats_of(&app);
    assert_eq!(stats.files, 1);
    assert_eq!((stats.min, stats.max, stats.mean), (1, 1, 1.0));
    assert_eq!(bins_of(&stats), vec![(1, 1)]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 現状固定: プレイリストがあっても directory_path が None なら、DB の表示回数は
/// 引かず全員 0 回として数える（メンバー数 files は保つ）。
#[test]
fn display_stats_with_playlist_but_no_directory_counts_everyone_as_zero() {
    let dir = workspace("no_directory");
    let a = dir.join("a.jpg").to_string_lossy().to_string();
    let b = dir.join("b.jpg").to_string_lossy().to_string();
    let db = Database::new(dir.join("sss.db")).expect("db init");
    db.increment_display_count(&a).unwrap();
    db.increment_display_count(&a).unwrap();
    let app = app_with(&dir, db, Some(Playlist::new(vec![a, b])), None);

    let stats = display_stats_of(&app);
    assert_eq!(stats.files, 2);
    assert_eq!(bins_of(&stats), vec![(0, 2)]);
    assert_eq!((stats.min, stats.max, stats.mean), (0, 0, 0.0));
    let _ = std::fs::remove_dir_all(&dir);
}

/// プレイリストが Some(空) の場合と None（未スキャン）の場合はどちらも files==0 の空分布。
#[test]
fn display_stats_of_empty_playlist_and_missing_playlist_are_both_empty() {
    let dir = workspace("empty_vs_none");
    let db = Database::new(dir.join("sss.db")).expect("db init");
    let empty = app_with(&dir, db, Some(Playlist::new(vec![])), Some(dir.clone()));
    let stats = display_stats_of(&empty);
    assert_eq!(stats.files, 0);
    assert!(stats.bins.is_empty());
    assert_eq!((stats.min, stats.max, stats.mean), (0, 0, 0.0));

    let dir2 = workspace("empty_vs_none_b");
    let db2 = Database::new(dir2.join("sss.db")).expect("db init");
    let none = app_with(&dir2, db2, None, Some(dir2.clone()));
    let stats = display_stats_of(&none);
    assert_eq!(stats.files, 0);
    assert!(stats.bins.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}
