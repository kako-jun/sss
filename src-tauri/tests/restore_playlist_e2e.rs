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
use std::sync::Mutex;

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

/// #62レビュー2巡目 N-S2: `playlist_mutex` が既に `Some`（既に復元済み/
/// 初期化済み）なら、何もせず`AlreadyReady`（呼び出し元はtrue）を返す（既存維持）。
#[test]
fn restore_playlist_returns_already_ready_without_changes_when_playlist_already_set() {
    let dir = workspace("already_set");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    std::fs::write(photos_dir.join("img.jpg"), b"x").unwrap();

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    // 意図的に、DBには何も保存していない状態で、メモリ上にだけ既にプレイリストがある
    // 状況を作る(scan_directoryが先に完了していた等を模す)。
    let existing_playlist = Playlist::new(vec!["/already/loaded.jpg".to_string()]);
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(Some(existing_playlist));
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
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
    assert!(
        directory_path_mutex.lock().unwrap().is_none(),
        "既存維持パスではdirectory_pathも書き換えないはず"
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
