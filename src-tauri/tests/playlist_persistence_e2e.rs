//! #62 の golden e2e: プレイリストの永続化・再起動跨ぎの復元・スキャン時の
//! modified 重複防止を、`perform_scan`（Tauri非依存の本体）と `Database`/`Playlist`
//! を直接組み合わせて検証する。
//!
//! `get_next_image`/`get_previous_image`（Tauriコマンド層）が行う「advanceのたびに
//! `save_playlist_position`/`save_playlist_full` を呼ぶ」永続化を、ここでは
//! Tauri抜きで手動再現する（`tauri::test::mock_app` は非同期コマンドの都合上
//! `get_next_image_missing_file.rs` で使っているが、ここでは `Playlist`/`Database`
//! のAPIだけで完結させる方が単純で狙いに直結する）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sss_lib::commands::scan::perform_scan;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_playlist_persistence_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_jpeg(path: &Path) {
    std::fs::write(path, b"fixture-bytes").unwrap();
}

/// `get_next_image` が行う永続化（reshuffleならフル保存、それ以外は軽量保存）を
/// テスト側で手動再現する。
fn advance_and_persist(db: &Database, directory: &str, playlist: &mut Playlist) -> String {
    let (path, _should_count, reshuffled) = playlist.advance();
    let path = path
        .expect("空でないプレイリストならNoneにならないはず")
        .clone();

    if reshuffled {
        db.save_playlist_full(
            directory,
            playlist.shuffled_list(),
            playlist.current_index(),
            playlist.history(),
            playlist.history_position(),
        )
        .unwrap();
    } else {
        db.save_playlist_position(
            playlist.current_index(),
            playlist.history(),
            playlist.history_position(),
        )
        .unwrap();
    }

    path
}

/// #62 元issue問題1: 起動のたびに再シャッフルされ、完全平等が達成できない問題の
/// 直接的な回帰テスト。
///
/// 1. 初回スキャンでプレイリストを作り、DBへ保存しつつ半分だけ進める。
/// 2. 「アプリ再起動」を模して、新しい `Mutex<Option<Playlist>>`（=メモリ上は空）で
///    `perform_scan` を呼ぶ（`current_directory=None`。実アプリでも起動直後は
///    `AppState.directory_path` が `None` のため、この呼び出し条件は実際の
///    起動シーケンスと一致する）。
/// 3. 復元されたプレイリストで残り半分を進め、1巡ぶん全件がちょうど1回ずつ
///    表示されたことを確認する。
#[test]
fn scan_directory_restores_saved_playlist_across_simulated_restart() {
    let dir = workspace("restart");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    const TOTAL: usize = 10;
    for i in 0..TOTAL {
        write_jpeg(&photos_dir.join(format!("img{i}.jpg")));
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let directory_str = photos_dir.to_string_lossy().to_string();

    // --- 1回目の起動: 初回スキャン ---
    let playlist_mutex_1: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex_1, None, &photos_dir, |_, _| {})
        .expect("初回scanは成功するはず");

    let mut shown = Vec::new();
    {
        let db = db_mutex.lock().unwrap();
        let mut playlist_lock = playlist_mutex_1.lock().unwrap();
        let playlist = playlist_lock.as_mut().unwrap();
        assert_eq!(playlist.total_count(), TOTAL);

        // 半分だけ進める（このプロセスが終了/クラッシュした想定）
        for _ in 0..(TOTAL / 2) {
            shown.push(advance_and_persist(&db, &directory_str, playlist));
        }
    }
    // playlist_mutex_1 はここで（プロセス終了相当として）破棄する

    // --- 2回目の起動: current_directory=None（実アプリの起動直後と同条件）で
    //     再度 perform_scan を呼ぶ。メモリ上のプレイリストは無い(新しいMutex)。 ---
    let playlist_mutex_2: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex_2, None, &photos_dir, |_, _| {})
        .expect("2回目(復元)のscanは成功するはず");

    {
        let mut playlist_lock = playlist_mutex_2.lock().unwrap();
        let playlist = playlist_lock.as_mut().unwrap();

        // 復元されていれば「続きから」なので、total_countは変わらず、
        // 既に表示した分がまだ残っているはず（=先頭から作り直されていない）。
        assert_eq!(
            playlist.total_count(),
            TOTAL,
            "復元されたプレイリストの総数は変わらないはず"
        );
        assert_eq!(
            playlist.current_position(),
            TOTAL / 2,
            "復元後は保存済みのcurrent_indexの続きになっているはず（先頭に巻き戻っていない）"
        );

        let db = db_mutex.lock().unwrap();
        // 残り半分を進める
        for _ in 0..(TOTAL - TOTAL / 2) {
            shown.push(advance_and_persist(&db, &directory_str, playlist));
        }
    }

    let shown_set: HashSet<String> = shown.iter().cloned().collect();
    let expected_set: HashSet<String> = (0..TOTAL)
        .map(|i| {
            photos_dir
                .join(format!("img{i}.jpg"))
                .to_string_lossy()
                .to_string()
        })
        .collect();

    assert_eq!(
        shown.len(),
        TOTAL,
        "再起動を跨いでも重複や欠落なく1巡ぶん表示されるはず"
    );
    assert_eq!(
        shown_set, expected_set,
        "再起動を跨いでも1巡で全件ちょうど1回表示されるはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62: mtime が変わっただけの既存ファイル（modified）は、再スキャンでプレイリストに
/// 重複追加されない（`shuffled_list`の件数がユニークなパス数と一致し続ける）。
#[test]
fn rescanning_a_modified_file_does_not_duplicate_it_in_the_playlist() {
    let dir = workspace("modified_no_dup");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    let changed_path = photos_dir.join("changed.jpg");
    write_jpeg(&changed_path);
    write_jpeg(&photos_dir.join("stable.jpg"));

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);

    perform_scan(&db_mutex, &playlist_mutex, None, &photos_dir, |_, _| {})
        .expect("1回目のscanは成功するはず");
    {
        let playlist_lock = playlist_mutex.lock().unwrap();
        let playlist = playlist_lock.as_ref().unwrap();
        assert_eq!(playlist.total_count(), 2);
        assert_eq!(
            playlist.shuffled_list().len(),
            playlist.current_paths().len(),
            "1回目のスキャン直後は重複が無いはず"
        );
    }

    // changed.jpg の内容とmtimeを変える（新規ではなく既存パスの更新＝modified）
    std::fs::write(&changed_path, b"changed-content-longer").unwrap();
    let new_mtime = std::time::SystemTime::now() + std::time::Duration::from_secs(120);
    std::fs::File::options()
        .write(true)
        .open(&changed_path)
        .unwrap()
        .set_modified(new_mtime)
        .unwrap();

    // 同じディレクトリを再スキャン（current_directory を一致させ、同一ディレクトリの
    // 差分更新パスを通す）
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        Some(photos_dir.as_path()),
        &photos_dir,
        |_, _| {},
    )
    .expect("2回目のscanは成功するはず");

    let playlist_lock = playlist_mutex.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert_eq!(
        playlist.total_count(),
        2,
        "modifiedファイルは既存メンバーのままで件数は変わらないはず"
    );
    assert_eq!(
        playlist.shuffled_list().len(),
        playlist.current_paths().len(),
        "modifiedファイルが重複してshuffled_listに追加されていないはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62 空・未設定(directory_path不一致): 保存済みのプレイリスト状態が別ディレクトリの
/// ものだった場合、それを引き継がず今回のディレクトリで新規シャッフルする。
#[test]
fn scan_directory_mismatch_discards_saved_state_and_shuffles_fresh() {
    let dir = workspace("dir_mismatch");
    let photos_dir_a = dir.join("photos_a");
    let photos_dir_b = dir.join("photos_b");
    std::fs::create_dir_all(&photos_dir_a).unwrap();
    std::fs::create_dir_all(&photos_dir_b).unwrap();

    const TOTAL_A: usize = 6;
    for i in 0..TOTAL_A {
        write_jpeg(&photos_dir_a.join(format!("img{i}.jpg")));
    }
    const TOTAL_B: usize = 4;
    for i in 0..TOTAL_B {
        write_jpeg(&photos_dir_b.join(format!("pic{i}.jpg")));
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));

    // フォルダAをスキャンして少し進め、DBに保存する(directory_path = photos_a)。
    let playlist_mutex_1: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex_1, None, &photos_dir_a, |_, _| {})
        .expect("フォルダAの初回scanは成功するはず");
    {
        let db = db_mutex.lock().unwrap();
        let mut playlist_lock = playlist_mutex_1.lock().unwrap();
        let playlist = playlist_lock.as_mut().unwrap();
        for _ in 0..3 {
            advance_and_persist(&db, &photos_dir_a.to_string_lossy(), playlist);
        }
    }

    // 「再起動してフォルダBを選び直した」想定(current_directory=None、メモリ上の
    // プレイリストも新しいMutexで空)。
    let playlist_mutex_2: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex_2, None, &photos_dir_b, |_, _| {})
        .expect("フォルダBへのscanは成功するはず");

    let playlist_lock = playlist_mutex_2.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert_eq!(
        playlist.total_count(),
        TOTAL_B,
        "保存されていたフォルダAの状態を引き継がず、フォルダBの件数で新規作成されるはず"
    );
    assert!(
        playlist.current().is_none(),
        "新規作成されたプレイリストはまだ何も表示していない(before_start)はず"
    );
    let paths = playlist.current_paths();
    for i in 0..TOTAL_B {
        let expected = photos_dir_b
            .join(format!("pic{i}.jpg"))
            .to_string_lossy()
            .to_string();
        assert!(
            paths.contains(&expected),
            "フォルダBの画像が含まれているはず"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62 事故パターン: 保存済みのプレイリストが指していた画像が、再起動までの間に
/// フォルダごと全部物理削除されていた場合、復元処理はクラッシュせず、
/// 差分適用の結果として空のプレイリストになる。
#[test]
fn restart_with_all_saved_files_physically_deleted_yields_empty_playlist_without_crash() {
    let dir = workspace("all_deleted");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    const TOTAL: usize = 5;
    for i in 0..TOTAL {
        write_jpeg(&photos_dir.join(format!("img{i}.jpg")));
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let directory_str = photos_dir.to_string_lossy().to_string();

    let playlist_mutex_1: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex_1, None, &photos_dir, |_, _| {})
        .expect("初回scanは成功するはず");
    {
        let db = db_mutex.lock().unwrap();
        let mut playlist_lock = playlist_mutex_1.lock().unwrap();
        let playlist = playlist_lock.as_mut().unwrap();
        assert_eq!(playlist.total_count(), TOTAL);
        for _ in 0..2 {
            advance_and_persist(&db, &directory_str, playlist);
        }
    }

    // フォルダの中身を全部消す(外部ツール等での一括削除を模す)。
    for i in 0..TOTAL {
        std::fs::remove_file(photos_dir.join(format!("img{i}.jpg"))).unwrap();
    }

    // 再起動相当: メモリ上のプレイリストは無い。同じフォルダを再スキャンする。
    let playlist_mutex_2: Mutex<Option<Playlist>> = Mutex::new(None);
    perform_scan(&db_mutex, &playlist_mutex_2, None, &photos_dir, |_, _| {})
        .expect("全件削除後の再scanでもクラッシュせず成功するはず");

    let playlist_lock = playlist_mutex_2.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert!(
        playlist.is_empty(),
        "保存されていた画像が全て物理的に消えていれば、復元後のプレイリストも空になるはず"
    );
    assert_eq!(playlist.total_count(), 0);
    assert!(playlist.current().is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
