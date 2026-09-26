//! #62レビュー S1/2巡目(N-M1/N-S2) の回帰テスト: `restore_playlist` コマンドの本体
//! `perform_restore` が、保存済みプレイリスト状態を「スキャン完了を待たずに」
//! 復元できること、および復元してはいけない条件（ディレクトリ不在・スキャン中等）を
//! 正しく守ることを確認する。
//!
//! `perform_scan` と同じ理由（`AppHandle` は runtime ジェネリクスが `Wry` 固定で
//! `tauri::test::mock_app()` の `MockRuntime` を受け付けないため）で、
//! `perform_restore` は Tauri 非依存の関数として本体を切り出しており、
//! `Mutex`/`AtomicBool` を直接渡すだけでテストできる。

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;

use sss_lib::commands::scan::{perform_restore, perform_scan, RestoreOutcome};
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_restore_playlist_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `perform_scan` を呼ぶだけの薄いヘルパー（directory_path_mutexは呼び捨てでよい
/// テストが大半のため、毎回使い捨ての `Mutex::new(None)` を渡す）。
fn scan(
    db_mutex: &Mutex<Database>,
    playlist_mutex: &Mutex<Option<Playlist>>,
    directory: &std::path::Path,
) {
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        db_mutex,
        playlist_mutex,
        &directory_path_mutex,
        None,
        directory,
        |_, _| {},
    )
    .unwrap();
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
    scan(&db_mutex, &playlist_mutex, &photos_dir);
    // 「アプリ再起動」を模して、メモリ上のプレイリストは空の新しいMutexにする。
    let restored_playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let scan_in_progress = AtomicBool::new(false);

    let outcome = perform_restore(
        &db_mutex,
        &restored_playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &photos_dir,
    );

    match outcome {
        RestoreOutcome::Restored(safe_dir) => {
            assert_eq!(safe_dir, photos_dir.canonicalize().unwrap());
        }
        other => panic!("保存済み状態と一致するディレクトリなら復元できるはず: {other:?}"),
    }
    {
        let playlist_lock = restored_playlist_mutex.lock().unwrap();
        let playlist = playlist_lock.as_ref().expect("復元済みのはず");
        assert_eq!(playlist.total_count(), 5);
    }
    {
        let dir_lock = directory_path_mutex.lock().unwrap();
        assert_eq!(dir_lock.as_deref(), Some(photos_dir.as_path()));
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn restore_playlist_returns_false_when_no_state_was_ever_saved() {
    let dir = workspace("no_state");
    let never_scanned_dir = dir.join("never_scanned");
    std::fs::create_dir_all(&never_scanned_dir).unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let scan_in_progress = AtomicBool::new(false);

    let outcome = perform_restore(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &never_scanned_dir,
    );

    assert_eq!(
        outcome,
        RestoreOutcome::NotRestored,
        "保存が無ければ復元できないはず"
    );
    assert!(playlist_mutex.lock().unwrap().is_none());

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
    scan(&db_mutex, &playlist_mutex, &photos_dir_a);

    let restored_playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let scan_in_progress = AtomicBool::new(false);

    // 保存されているのはフォルダAだが、フォルダBを指定して復元を試みる。
    let outcome = perform_restore(
        &db_mutex,
        &restored_playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &photos_dir_b,
    );

    assert_eq!(
        outcome,
        RestoreOutcome::NotRestored,
        "保存済みと異なるディレクトリなら復元できないはず"
    );
    assert!(restored_playlist_mutex.lock().unwrap().is_none());
    assert!(directory_path_mutex.lock().unwrap().is_none());

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
    scan(&db_mutex, &playlist_mutex, &photos_dir);

    let restored_playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let scan_in_progress = AtomicBool::new(false);

    let with_trailing_slash = PathBuf::from(format!("{}/", photos_dir.to_string_lossy()));
    let outcome = perform_restore(
        &db_mutex,
        &restored_playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &with_trailing_slash,
    );

    assert!(
        matches!(outcome, RestoreOutcome::Restored(_)),
        "末尾区切りの有無だけの違いは正規化キーで同一視されるはず: {outcome:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー2巡目 N-M1(must): 保存済み状態はあるが、対象ディレクトリが今
/// アクセスできない（NAS/USB未マウント等を模す＝スキャン後にディレクトリ自体を
/// 削除する）場合は復元しない。これをせず復元してしまうと、保存されていたファイルが
/// 軒並み存在しない状態で `get_next_image` が内部リトライを繰り返し、未表示画像を
/// 黙って消費し続けてしまう。
#[test]
fn restore_playlist_returns_false_when_saved_directory_is_currently_inaccessible() {
    let dir = workspace("inaccessible");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    std::fs::write(photos_dir.join("img.jpg"), b"x").unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    scan(&db_mutex, &playlist_mutex, &photos_dir);

    // NAS/USB未マウントを模して、スキャン後にディレクトリ自体を削除する。
    std::fs::remove_dir_all(&photos_dir).unwrap();

    let restored_playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let scan_in_progress = AtomicBool::new(false);

    let outcome = perform_restore(
        &db_mutex,
        &restored_playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &photos_dir,
    );

    assert_eq!(
        outcome,
        RestoreOutcome::NotRestored,
        "保存済み状態と一致していても、ディレクトリに今アクセスできないなら復元しないはず"
    );
    assert!(
        restored_playlist_mutex.lock().unwrap().is_none(),
        "復元を拒否した以上、プレイリストは未設定のままのはず\
         (黙ってadvanceし続けて未表示画像を消費してしまうバグの回帰)"
    );
    assert!(directory_path_mutex.lock().unwrap().is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー2巡目 N-S2（#62レビュー3巡目 nit で directory_path_mutex との
/// 一致確認を追加）: `playlist_mutex` が既に `Some`（既に復元済み/初期化済み）で、
/// かつ `directory_path_mutex` が今回リクエストされたディレクトリと一致するなら、
/// 何もせず `AlreadyReady`（呼び出し元はtrue）を返す（既存維持）。
#[test]
fn restore_playlist_returns_already_ready_without_changes_when_playlist_already_set() {
    let dir = workspace("already_set");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    std::fs::write(photos_dir.join("img.jpg"), b"x").unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    // 意図的に、DBには何も保存していない状態で、メモリ上にだけ既にプレイリストがある
    // 状況を作る(scan_directoryが先に完了していた等を模す)。directory_path_mutexも
    // 今回リクエストするディレクトリと一致させておく(既にこのディレクトリの状態が
    // 復元済みという想定)。
    let existing_playlist = Playlist::new(vec!["/already/loaded.jpg".to_string()]);
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(Some(existing_playlist));
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(Some(photos_dir.clone()));
    let scan_in_progress = AtomicBool::new(false);

    let outcome = perform_restore(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &photos_dir,
    );

    assert_eq!(
        outcome,
        RestoreOutcome::AlreadyReady,
        "既にプレイリストがあるなら既存維持のAlreadyReadyを返すはず"
    );
    {
        let playlist_lock = playlist_mutex.lock().unwrap();
        let playlist = playlist_lock.as_ref().unwrap();
        assert!(
            playlist.current_paths().contains("/already/loaded.jpg"),
            "既存のプレイリストを勝手に作り直していないはず"
        );
    }
    assert_eq!(
        directory_path_mutex.lock().unwrap().as_deref(),
        Some(photos_dir.as_path()),
        "既存維持パスではdirectory_pathも書き換えないはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 nit: `playlist_mutex` が既に `Some` でも、それが
/// `directory_path_mutex` の指すディレクトリと**一致しない**場合（例: 別ディレクトリ
/// への切替直後で、まだ古いディレクトリのプレイリストが残っている）は、
/// 「既存維持」を騙って `AlreadyReady` を返してはいけない（`NotRestored` を返し、
/// 呼び出し元の通常の新規/差分更新フローに委ねる）。
#[test]
fn restore_playlist_returns_not_restored_when_existing_playlist_is_for_a_different_directory() {
    let dir = workspace("already_set_different_dir");
    let photos_dir_a = dir.join("a");
    let photos_dir_b = dir.join("b");
    std::fs::create_dir_all(&photos_dir_a).unwrap();
    std::fs::create_dir_all(&photos_dir_b).unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let existing_playlist = Playlist::new(vec!["/a/loaded.jpg".to_string()]);
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(Some(existing_playlist));
    // メモリ上のplaylistはフォルダA向けだが、今回リクエストするのはフォルダB。
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(Some(photos_dir_a.clone()));
    let scan_in_progress = AtomicBool::new(false);

    let outcome = perform_restore(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &photos_dir_b,
    );

    assert_eq!(
        outcome,
        RestoreOutcome::NotRestored,
        "既存playlistが別ディレクトリのものなら既存維持を騙ってはいけない"
    );
    // 既存のplaylist/directory_pathはA向けのまま変更されない
    // (Bの状態を勝手に作ったり上書きしたりしない)。
    assert!(playlist_mutex
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .current_paths()
        .contains("/a/loaded.jpg"));
    assert_eq!(
        directory_path_mutex.lock().unwrap().as_deref(),
        Some(photos_dir_a.as_path())
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー2巡目 N-S2: `scan_in_progress` が立っている間は復元しない
/// （スキャンのStage 4がplaylist/dbへ反映している最中に割り込まない）。
#[test]
fn restore_playlist_returns_false_while_scan_is_in_progress() {
    let dir = workspace("scan_in_progress");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    std::fs::write(photos_dir.join("img.jpg"), b"x").unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    scan(&db_mutex, &playlist_mutex, &photos_dir);

    let restored_playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let scan_in_progress = AtomicBool::new(true);

    let outcome = perform_restore(
        &db_mutex,
        &restored_playlist_mutex,
        &directory_path_mutex,
        &scan_in_progress,
        &photos_dir,
    );

    assert_eq!(
        outcome,
        RestoreOutcome::NotRestored,
        "スキャン中は復元しないはず"
    );
    assert!(restored_playlist_mutex.lock().unwrap().is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 nit: `is_some` 確認から `Some(playlist)` 設定までロックを
/// 保持し続ける（TOCTOU対策）ため、複数スレッドから同時に `perform_restore` を
/// 呼んでも、`playlist_mutex` の総順序により実際に復元するのはちょうど1本だけで、
/// 残りは（既に正しく設定された `directory_path_mutex` と一致するので）
/// `AlreadyReady` になる。`NotRestored` が紛れ込む（＝一瞬でも矛盾した状態を
/// 観測してしまう）ことは無い。
#[test]
fn perform_restore_is_race_free_under_concurrent_calls() {
    let dir = workspace("concurrent_restore");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    for i in 0..5 {
        std::fs::write(photos_dir.join(format!("img{i}.jpg")), b"x").unwrap();
    }

    let db_mutex = Arc::new(Mutex::new(
        Database::new(dir.join("sss.db")).expect("db init"),
    ));
    let playlist_mutex: Arc<Mutex<Option<Playlist>>> = Arc::new(Mutex::new(None));
    scan(&db_mutex, &playlist_mutex, &photos_dir);
    // scan()はperform_scan経由でplaylistを設定してしまうため、「再起動直後で
    // メモリ上は空」の状態を作るためにリセットする(DBには保存済み)。
    *playlist_mutex.lock().unwrap() = None;

    let directory_path_mutex: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let scan_in_progress = Arc::new(AtomicBool::new(false));

    const THREADS: usize = 8;
    let handles: Vec<_> = (0..THREADS)
        .map(|_| {
            let db_mutex = Arc::clone(&db_mutex);
            let playlist_mutex = Arc::clone(&playlist_mutex);
            let directory_path_mutex = Arc::clone(&directory_path_mutex);
            let scan_in_progress = Arc::clone(&scan_in_progress);
            let photos_dir = photos_dir.clone();
            thread::spawn(move || {
                perform_restore(
                    &db_mutex,
                    &playlist_mutex,
                    &directory_path_mutex,
                    &scan_in_progress,
                    &photos_dir,
                )
            })
        })
        .collect();

    let outcomes: Vec<RestoreOutcome> = handles.into_iter().map(|h| h.join().unwrap()).collect();

    let restored_count = outcomes
        .iter()
        .filter(|o| matches!(o, RestoreOutcome::Restored(_)))
        .count();
    let already_ready_count = outcomes
        .iter()
        .filter(|o| **o == RestoreOutcome::AlreadyReady)
        .count();
    let not_restored_count = outcomes
        .iter()
        .filter(|o| **o == RestoreOutcome::NotRestored)
        .count();

    assert_eq!(
        restored_count, 1,
        "TOCTOUが無ければ実際に復元するのはちょうど1本のはず: {outcomes:?}"
    );
    assert_eq!(
        already_ready_count,
        THREADS - 1,
        "残りは全てAlreadyReadyになるはず(NotRestoredが紛れ込まない): {outcomes:?}"
    );
    assert_eq!(not_restored_count, 0);

    let _ = std::fs::remove_dir_all(&dir);
}
