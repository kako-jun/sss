//! #78: 除外の取り消し（`undo_exclude`）の結合テスト。
//!
//! `exclude_image` の戻り値（`ruleType`/`ruleAdded`/`removedPaths`）をそのまま
//! `undo_exclude` へ渡し、除外ルールの削除・プレイリストへの復帰（未再生区間）・
//! 永続化・「元からあったルールは消さない」「別の除外ルールが残っていれば戻さない」を
//! 実際の Tauri コマンド経由で確認する（`exclude_persistence_e2e.rs` と同じ手法）。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::file_operations::{exclude_image, undo_exclude};
use sss_lib::commands::scan::perform_scan;
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::ignore::RuleType;
use sss_lib::playlist::Playlist;
use tauri::Manager;

const TOTAL: usize = 6;

struct Fixture {
    dir: PathBuf,
    photos_dir: PathBuf,
    db_path: PathBuf,
    app: tauri::App<tauri::test::MockRuntime>,
}

fn setup(tag: &str) -> Fixture {
    let dir =
        std::env::temp_dir().join(format!("sss_undo_exclude_e2e_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    for i in 0..TOTAL {
        std::fs::write(photos_dir.join(format!("img{i}.jpg")), b"fixture").unwrap();
    }

    let db_path = dir.join("sss.db");
    let db_mutex = Mutex::new(Database::new(db_path.clone()).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_, _| {},
    )
    .expect("初回scanは成功するはず");

    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db_mutex.into_inner().unwrap()),
        playlist: Mutex::new(playlist_mutex.into_inner().unwrap()),
        directory_path: Mutex::new(Some(photos_dir.clone())),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
        last_incremented_display: Mutex::new(None),
    });
    Fixture {
        dir,
        photos_dir,
        db_path,
        app,
    }
}

fn rule_exists(state: &AppState, pattern: &str, rule_type: RuleType) -> bool {
    let db = state.db.lock().unwrap();
    db.get_ignore_rules()
        .unwrap()
        .iter()
        .any(|(p, t)| p == pattern && *t == rule_type)
}

#[test]
fn undoing_a_file_exclusion_removes_the_rule_and_restores_the_image_to_the_unplayed_section() {
    let f = setup("file");
    let state = f.app.state::<AppState>();
    let target = f.photos_dir.join("img0.jpg").to_string_lossy().to_string();

    // 2枚進めて「表示済み区間」を作ってから、未表示の1枚を除外する（現実には
    // 直前に見ていた1枚だが、どの位置にあっても未再生区間へ戻ることを検証する）。
    {
        let mut lock = state.playlist.lock().unwrap();
        let pl = lock.as_mut().unwrap();
        pl.advance();
        pl.advance();
    }

    let outcome = tauri::async_runtime::block_on(exclude_image(
        target.clone(),
        "file".to_string(),
        state.clone(),
    ))
    .expect("exclude_image");
    assert!(outcome.rule_added);
    assert_eq!(outcome.rule_type, "glob");
    assert_eq!(outcome.removed_paths, vec![target.clone()]);
    assert!(rule_exists(&state, &outcome.pattern, RuleType::Glob));

    let (next_index_before, history_before) = {
        let lock = state.playlist.lock().unwrap();
        let pl = lock.as_ref().unwrap();
        assert_eq!(pl.total_count(), TOTAL - 1);
        (pl.next_index(), pl.history().to_vec())
    };

    tauri::async_runtime::block_on(undo_exclude(
        outcome.pattern.clone(),
        outcome.rule_type.clone(),
        outcome.rule_added,
        outcome.removed_paths.clone(),
        state.clone(),
    ))
    .expect("undo_exclude");

    assert!(!rule_exists(&state, &outcome.pattern, RuleType::Glob));
    {
        let lock = state.playlist.lock().unwrap();
        let pl = lock.as_ref().unwrap();
        assert_eq!(pl.total_count(), TOTAL, "件数が元に戻る");
        assert!(pl.current_paths().contains(&target));
        // 表示済み区間・履歴は無傷で、復帰した画像は未再生区間（next_index以降）にある。
        assert_eq!(pl.next_index(), next_index_before);
        assert_eq!(pl.history(), history_before.as_slice());
        let pos = pl
            .shuffled_list()
            .iter()
            .position(|p| *p == target)
            .unwrap();
        assert!(pos >= pl.next_index(), "未再生区間へ戻る: pos={pos}");
    }

    // 永続化されている（再起動しても復帰したまま）。
    let fresh = Database::new(f.db_path.clone()).unwrap();
    let (_, shuffled, _, _, _) = fresh.load_playlist_state().unwrap().unwrap();
    assert!(shuffled.contains(&target));
    assert_eq!(shuffled.len(), TOTAL);

    let _ = std::fs::remove_dir_all(&f.dir);
}

#[test]
fn undo_keeps_a_rule_that_already_existed_before_the_exclusion() {
    let f = setup("preexisting");
    let state = f.app.state::<AppState>();
    let target = f.photos_dir.join("img1.jpg").to_string_lossy().to_string();

    let first = tauri::async_runtime::block_on(exclude_image(
        target.clone(),
        "file".to_string(),
        state.clone(),
    ))
    .unwrap();
    assert!(first.rule_added);
    // 同じファイルをもう一度除外する（ルールは既存→新規追加ではない）。
    let second = tauri::async_runtime::block_on(exclude_image(
        target.clone(),
        "file".to_string(),
        state.clone(),
    ))
    .unwrap();
    assert!(!second.rule_added, "既存ルールは ruleAdded=false");
    assert!(second.removed_paths.is_empty(), "既にプレイリストに無い");

    tauri::async_runtime::block_on(undo_exclude(
        second.pattern.clone(),
        second.rule_type.clone(),
        second.rule_added,
        second.removed_paths.clone(),
        state.clone(),
    ))
    .unwrap();
    assert!(
        rule_exists(&state, &second.pattern, RuleType::Glob),
        "元からあったルールは取り消しで消えない"
    );

    let _ = std::fs::remove_dir_all(&f.dir);
}

#[test]
fn undo_does_not_restore_an_image_still_covered_by_another_rule() {
    let f = setup("other_rule");
    let state = f.app.state::<AppState>();
    let target = f.photos_dir.join("img2.jpg").to_string_lossy().to_string();

    let outcome = tauri::async_runtime::block_on(exclude_image(
        target.clone(),
        "file".to_string(),
        state.clone(),
    ))
    .unwrap();
    // 別のルール（フォルダ配下すべて）が後から入っている。
    {
        let db = state.db.lock().unwrap();
        db.add_ignore_rule(
            &format!("{}/**", f.photos_dir.to_string_lossy()),
            RuleType::Glob,
        )
        .unwrap();
    }

    tauri::async_runtime::block_on(undo_exclude(
        outcome.pattern.clone(),
        outcome.rule_type.clone(),
        outcome.rule_added,
        outcome.removed_paths.clone(),
        state.clone(),
    ))
    .unwrap();

    let lock = state.playlist.lock().unwrap();
    assert!(
        !lock.as_ref().unwrap().current_paths().contains(&target),
        "別の除外ルールに該当する画像は取り消しでも戻さない"
    );
    drop(lock);
    let _ = std::fs::remove_dir_all(&f.dir);
}

#[test]
fn undoing_a_directory_exclusion_only_removes_the_rule() {
    let f = setup("directory");
    let state = f.app.state::<AppState>();
    let target = f.photos_dir.join("img3.jpg").to_string_lossy().to_string();

    let outcome = tauri::async_runtime::block_on(exclude_image(
        target,
        "directory".to_string(),
        state.clone(),
    ))
    .unwrap();
    assert!(outcome.needs_rescan);
    assert!(
        outcome.removed_paths.is_empty(),
        "フォルダ除外は再スキャンまで外れない"
    );
    assert!(rule_exists(&state, &outcome.pattern, RuleType::Glob));

    tauri::async_runtime::block_on(undo_exclude(
        outcome.pattern.clone(),
        outcome.rule_type.clone(),
        outcome.rule_added,
        outcome.removed_paths.clone(),
        state.clone(),
    ))
    .unwrap();
    assert!(!rule_exists(&state, &outcome.pattern, RuleType::Glob));
    assert_eq!(
        state
            .playlist
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .total_count(),
        TOTAL
    );

    let _ = std::fs::remove_dir_all(&f.dir);
}
