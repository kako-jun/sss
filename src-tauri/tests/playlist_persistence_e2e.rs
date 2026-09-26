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
use std::sync::{Arc, Mutex};
use std::thread;

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
            playlist.next_index(),
            playlist.history(),
            playlist.history_position(),
        )
        .unwrap();
    } else {
        db.save_playlist_position(
            playlist.next_index(),
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
    let directory_path_mutex_1: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_1,
        &directory_path_mutex_1,
        None,
        &photos_dir,
        |_, _| {},
    )
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
    let directory_path_mutex_2: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_2,
        &directory_path_mutex_2,
        None,
        &photos_dir,
        |_, _| {},
    )
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
            "復元後は保存済みのnext_indexの続きになっているはず（先頭に巻き戻っていない）"
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
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);

    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_, _| {},
    )
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
        &directory_path_mutex,
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
    let directory_path_mutex_1: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_1,
        &directory_path_mutex_1,
        None,
        &photos_dir_a,
        |_, _| {},
    )
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
    let directory_path_mutex_2: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_2,
        &directory_path_mutex_2,
        None,
        &photos_dir_b,
        |_, _| {},
    )
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
        "新規作成されたプレイリストはまだ何も表示していない(next_index==0かつ履歴も空)はず"
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

/// #63 直接の回帰テスト: フォルダA→B→Aと切り替えてスキャンしても、Aの
/// `file_metadata`/`image_stats`（表示統計）が消えない。
///
/// 以前は差分比較（前回スキャンとの突き合わせ）に `get_all_file_metadata`
/// （DB全件）を使っていたため、Bをスキャンした時点で「今回の生スキャン（B配下）
/// には存在しない」と誤判定されたAのfile_metadataが確定削除されてしまう事故が
/// あった。`get_file_metadata_under`（スキャン対象ディレクトリ配下だけに限定）に
/// 直したことで、Aへ戻ったときに削除0件・件数維持・表示統計維持となることを
/// 直接検証する。
#[test]
fn switching_a_to_b_and_back_to_a_preserves_a_file_metadata_and_display_stats() {
    let dir = workspace("a_b_a_roundtrip");
    let photos_dir_a = dir.join("photos_a");
    let photos_dir_b = dir.join("photos_b");
    std::fs::create_dir_all(&photos_dir_a).unwrap();
    std::fs::create_dir_all(&photos_dir_b).unwrap();

    const TOTAL_A: usize = 5;
    for i in 0..TOTAL_A {
        write_jpeg(&photos_dir_a.join(format!("img{i}.jpg")));
    }
    write_jpeg(&photos_dir_b.join("pic0.jpg"));

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));

    // 1. フォルダAを初回スキャンし、1枚表示して display_count を進める。
    let playlist_mutex_a1: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex_a1: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_a1,
        &directory_path_mutex_a1,
        None,
        &photos_dir_a,
        |_, _| {},
    )
    .expect("フォルダAの初回scanは成功するはず");
    let advanced_path = {
        let db = db_mutex.lock().unwrap();
        let mut playlist_lock = playlist_mutex_a1.lock().unwrap();
        let playlist = playlist_lock.as_mut().unwrap();
        let path = advance_and_persist(&db, &photos_dir_a.to_string_lossy(), playlist);
        // `advance_and_persist`（テストヘルパー）自体は位置の永続化だけで表示回数を
        // 増やさない（実アプリでは `get_next_image` コマンドが別途
        // `increment_display_count` を呼ぶ）。ここでは「表示統計が消えないこと」を
        // 検証したいので、直接1回分の表示統計を作る。
        db.increment_display_count(&path).unwrap();
        path
    };
    {
        let db = db_mutex.lock().unwrap();
        let (count, _) = db.get_image_stats(&advanced_path).unwrap();
        assert_eq!(count, 1, "increment直後は表示回数1のはず");
        let a_metadata_count = db
            .get_file_metadata_under(&photos_dir_a.to_string_lossy())
            .unwrap()
            .len();
        assert_eq!(a_metadata_count, TOTAL_A);
    }

    // 2. フォルダBへ切り替えてスキャン（再起動想定: current_directory=None）。
    let playlist_mutex_b: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex_b: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_b,
        &directory_path_mutex_b,
        None,
        &photos_dir_b,
        |_, _| {},
    )
    .expect("フォルダBへのscanは成功するはず");

    // 3. 再度フォルダAへ切り替えてスキャン。
    let playlist_mutex_a2: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex_a2: Mutex<Option<PathBuf>> = Mutex::new(None);
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex_a2,
        &directory_path_mutex_a2,
        None,
        &photos_dir_a,
        |_, _| {},
    )
    .expect("フォルダAへの再scanは成功するはず");

    // Aのfile_metadataが全件残っている（Bのスキャンで誤って確定削除されていない）。
    assert_eq!(
        progress.deleted_files, 0,
        "Aへ戻った再scanで削除扱いは0件のはず"
    );
    let db = db_mutex.lock().unwrap();
    let a_metadata_count_after = db
        .get_file_metadata_under(&photos_dir_a.to_string_lossy())
        .unwrap()
        .len();
    assert_eq!(
        a_metadata_count_after, TOTAL_A,
        "フォルダBを挟んでもAのfile_metadataは消えないはず"
    );

    // Aの表示統計（display_count）も保持されている。
    let (count, _) = db.get_image_stats(&advanced_path).unwrap();
    assert_eq!(count, 1, "フォルダBを挟んでもAの表示統計は保持されるはず");
    drop(db);

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
    let directory_path_mutex_1: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_1,
        &directory_path_mutex_1,
        None,
        &photos_dir,
        |_, _| {},
    )
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
    let directory_path_mutex_2: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex_2,
        &directory_path_mutex_2,
        None,
        &photos_dir,
        |_, _| {},
    )
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

/// #63 テスト観点補完（並行: async化したsettingsと同時スキャン）: `save_setting`/
/// `get_setting`（`commands/settings.rs`）は #63 で非同期コマンドに変更されたが、
/// 実体は他の全DBコマンドと同じ `AppState.db`（`Mutex<Database>`）を取り合うだけで、
/// `perform_scan`（Stage 1/Stage 3で同じMutexを短時間だけ取る）と排他制御の仕組みは
/// 変わっていない。設定の読み書きを別スレッドから連打しながらスキャンしても、
/// デッドロックせず両方が正しく完了し、最後に書いた設定値がそのまま読めることを
/// 検証する（Tauriコマンド層を経由しない分、`Database`のメソッドを直接叩く）。
#[test]
fn settings_read_write_do_not_deadlock_or_corrupt_during_concurrent_scan() {
    let dir = workspace("settings_concurrent_scan");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    const TOTAL: usize = 300;
    for i in 0..TOTAL {
        write_jpeg(&photos_dir.join(format!("img{i}.jpg")));
    }

    let db_mutex = Arc::new(Mutex::new(
        Database::new(dir.join("sss.db")).expect("db init"),
    ));

    // スキャンと並行して、別スレッドから設定の保存/取得を繰り返す。
    // #63 PR#77レビュー S6: 以前は書いた値を読み捨てるだけで「壊れていないこと」を
    // 何も検証していなかった。save直後に同じロック内でget_settingし、必ず直前に
    // 書いた値が読めることを毎回assertする（他スレッドが割り込む余地がないことを
    // 意味のある形で固定する）。
    let settings_db_mutex = Arc::clone(&db_mutex);
    let settings_thread = thread::spawn(move || {
        for i in 0..200 {
            let value = format!("v{i}");
            let db = settings_db_mutex.lock().unwrap();
            db.save_setting("concurrent_test_key", &value)
                .expect("save_settingは同時実行下でも失敗しないはず");
            let read_back = db.get_setting("concurrent_test_key").unwrap();
            assert_eq!(
                read_back,
                Some(value),
                "save直後・同じロック内でのget_settingは必ず直前に書いた値と一致するはず"
            );
        }
    });

    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_, _| {},
    )
    .expect("設定の同時読み書きがあってもscanは成功するはず（デッドロックしない）");

    settings_thread
        .join()
        .expect("設定スレッドはpanicせず完了するはず");

    // #63 PR#77レビュー S6: 「スキャン結果も正しい」を実際に検証する
    // （以前はperform_scanの戻り値を一切見ていなかった）。
    assert_eq!(
        progress.total_files, TOTAL,
        "設定の同時アクセスがあってもtotal_filesは正しいはず"
    );
    assert_eq!(progress.new_files, TOTAL, "初回スキャンは全件新規のはず");
    assert_eq!(progress.deleted_files, 0);
    assert_eq!(progress.error_count, 0);

    // 最後に書いた値がそのまま読める(競合で壊れていない)ことを確認する。
    {
        let db = db_mutex.lock().unwrap();
        db.save_setting("concurrent_test_key", "final").unwrap();
        assert_eq!(
            db.get_setting("concurrent_test_key").unwrap(),
            Some("final".to_string())
        );
    }

    let playlist_lock = playlist_mutex.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert_eq!(
        playlist.total_count(),
        TOTAL,
        "設定の同時アクセスがあってもスキャン結果自体は正しいはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #63 PR#77レビュー S6: 入れ子ディレクトリ（A→A/sub→A、A/sub→A のいずれの順でも）
/// をまたいでスキャンしても、共有されるファイル（A/sub配下）の`file_metadata`/
/// `image_stats`が消えず、二重管理（同じパスが複数行になる等）も起きないことを
/// 検証する。`get_file_metadata_under`の区切り文字境界の正しさ（M1/S1の範囲クエリ
/// 修正）の直接的な統合テストでもある。
#[test]
fn nested_directory_scans_preserve_shared_file_stats_without_duplication() {
    let dir = workspace("nested_dir_scan");
    let root = dir.join("A");
    let sub = root.join("sub");
    std::fs::create_dir_all(&sub).unwrap();

    write_jpeg(&root.join("top.jpg"));
    write_jpeg(&sub.join("child.jpg"));

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));

    // 1. A全体をスキャンし、A/sub/child.jpgの表示回数を1にする。
    let playlist_mutex_1: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex_1: Mutex<Option<PathBuf>> = Mutex::new(None);
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex_1,
        &directory_path_mutex_1,
        None,
        &root,
        |_, _| {},
    )
    .expect("Aの初回scanは成功するはず");
    assert_eq!(progress.total_files, 2);
    assert_eq!(progress.new_files, 2);
    let child_path = sub.join("child.jpg").to_string_lossy().to_string();
    {
        let db = db_mutex.lock().unwrap();
        db.increment_display_count(&child_path).unwrap();
    }

    // 2. A/subだけをスキャン（親Aとは別のディレクトリを選び直した想定）。
    //    get_file_metadata_underがA/sub配下だけを正しく返せば、child.jpgは
    //    「既存・変更なし」と判定され新規/削除どちらにもならない。
    let playlist_mutex_2: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex_2: Mutex<Option<PathBuf>> = Mutex::new(None);
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex_2,
        &directory_path_mutex_2,
        None,
        &sub,
        |_, _| {},
    )
    .expect("A/subのscanは成功するはず");
    assert_eq!(progress.total_files, 1, "A/sub配下はchild.jpgの1件だけ");
    assert_eq!(
        progress.new_files, 0,
        "既にfile_metadataにある(mtime不変)ので新規扱いにならないはず"
    );
    assert_eq!(progress.deleted_files, 0);

    // 3. 再度Aをスキャン。top.jpg/child.jpgとも「既存」のまま、二重管理も起きない。
    let playlist_mutex_3: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex_3: Mutex<Option<PathBuf>> = Mutex::new(None);
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex_3,
        &directory_path_mutex_3,
        None,
        &root,
        |_, _| {},
    )
    .expect("Aへの再scanは成功するはず");
    assert_eq!(progress.total_files, 2);
    assert_eq!(
        progress.new_files, 0,
        "A/subスキャンを挟んでもtop.jpg/child.jpgは既存のまま(新規扱いにならない)はず"
    );
    assert_eq!(progress.deleted_files, 0);

    let db = db_mutex.lock().unwrap();
    let all = db.get_all_file_metadata().unwrap();
    assert_eq!(
        all.len(),
        2,
        "同じパスが複数行になる二重管理は起きていないはず（file_metadataは2行ちょうど）"
    );
    let (count, _) = db.get_image_stats(&child_path).unwrap();
    assert_eq!(
        count, 1,
        "A/subスキャンやAへの再scanを挟んでもchild.jpgの表示統計は消えないはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// この環境で `chmod 0o000` が実際に読み取りを拒否するかどうかを直接試して判定する
/// （root権限だと拒否が効かないため、`libc`のFFIを増やさず実際の効果で判定する。
/// `src/scanner.rs`のユニットテストにある同名ヘルパーと同じ考え方だが、tests/以下は
/// 別クレートなので個別に持つ）。
#[cfg(unix)]
fn chmod_000_actually_denies_read() -> bool {
    use std::os::unix::fs::PermissionsExt;
    let probe_dir = std::env::temp_dir().join(format!(
        "sss_e2e_root_probe_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&probe_dir).unwrap();
    std::fs::write(probe_dir.join("x"), b"x").unwrap();
    std::fs::set_permissions(&probe_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
    let denied = std::fs::read_dir(&probe_dir).is_err();
    std::fs::set_permissions(&probe_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let _ = std::fs::remove_dir_all(&probe_dir);
    denied
}

/// #63 PR#77レビュー M2(must) 直接の回帰テスト: スキャンエラー（ディレクトリの
/// 権限拒否）で生スキャン結果に一切現れなくなったサブツリーがあっても、
/// `perform_scan`レベルでプレイリストの件数・シャッフル位置(next_index)・履歴が
/// 保たれる（誤ってプレイリストから除去されない）こと。
///
/// 修正前は、エラー由来の「不明」ファイルも通常の「含めるべき集合」に入らないため
/// Stage4の差分計算で`removed`に入り、`update_images`でプレイリストから除去されて
/// next_index・履歴がずれてしまっていた。
#[test]
#[cfg(unix)]
fn scan_error_subtree_does_not_disturb_playlist_position_or_history() {
    use std::os::unix::fs::PermissionsExt;

    if !chmod_000_actually_denies_read() {
        eprintln!("root権限で実行されているためスキップ（chmodによる権限拒否が効かない）");
        return;
    }

    let dir = workspace("scan_error_subtree_playlist");
    let root = dir.join("photos");
    let locked_dir = root.join("locked");
    std::fs::create_dir_all(&locked_dir).unwrap();
    write_jpeg(&locked_dir.join("a.jpg"));
    write_jpeg(&locked_dir.join("b.jpg"));
    write_jpeg(&root.join("top1.jpg"));
    write_jpeg(&root.join("top2.jpg"));

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);

    // 1. 初回スキャン（全ファイル読める状態）。
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &root,
        |_, _| {},
    )
    .expect("初回scanは成功するはず");
    assert_eq!(progress.total_files, 4);
    assert_eq!(progress.error_count, 0);

    // 2巡ぶん進めて next_index/history に意味のある状態を作る。
    let (next_index_before, history_len_before, history_position_before, total_before) = {
        let mut playlist_lock = playlist_mutex.lock().unwrap();
        let playlist = playlist_lock.as_mut().unwrap();
        let db = db_mutex.lock().unwrap();
        advance_and_persist(&db, &root.to_string_lossy(), playlist);
        advance_and_persist(&db, &root.to_string_lossy(), playlist);
        (
            playlist.next_index(),
            playlist.history().len(),
            playlist.history_position(),
            playlist.total_count(),
        )
    };
    assert_eq!(next_index_before, 2, "2回advanceしたのでnext_index=2のはず");

    // 2. lockedディレクトリの読み取り権限を奪い、同じディレクトリを再スキャンする
    //    （current_directory=Some(root)。実アプリの「同じフォルダを再スキャン」と同条件）。
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        Some(&root),
        &root,
        |_, _| {},
    );
    // 後片付け（remove_dir_allの前に権限を戻す）は結果に関わらず必ず行う。
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let progress = progress.expect("エラーサブツリーがあってもscan自体は成功するはず");

    assert!(
        progress.error_count >= 1,
        "lockedディレクトリの読み取りエラーが1件以上あるはず"
    );

    let playlist_lock = playlist_mutex.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();

    assert_eq!(
        playlist.total_count(),
        total_before,
        "エラーサブツリー(locked配下2件)がプレイリストから除去されてはいけない"
    );
    assert_eq!(
        playlist.next_index(),
        next_index_before,
        "エラーによってnext_indexがずれてはいけない"
    );
    assert_eq!(
        playlist.history().len(),
        history_len_before,
        "エラーによって履歴が変わってはいけない"
    );
    assert_eq!(
        playlist.history_position(),
        history_position_before,
        "エラーによって履歴位置が変わってはいけない"
    );

    let current_paths = playlist.current_paths();
    let a_str = locked_dir.join("a.jpg").to_string_lossy().to_string();
    let b_str = locked_dir.join("b.jpg").to_string_lossy().to_string();
    assert!(
        current_paths.contains(&a_str) && current_paths.contains(&b_str),
        "locked配下の2件はプレイリストの所属を維持したままのはず: {current_paths:?}"
    );

    drop(playlist_lock);
    let _ = std::fs::remove_dir_all(&dir);
}

/// #63 PR#77レビュー2巡目 S-b 直接の回帰テスト: 一時的なスキャンエラー（chmod 000）で
/// 「不明」扱いになったファイルが、後で本当に確定削除されるケースを正しく扱えること。
///
/// エラー由来の「不明」はプレイリスト所属・`file_metadata`/`image_stats`を無期限に
/// 保護し続けるわけではない。権限を戻して（エラーが解消して）から実際にファイルを
/// 削除して再スキャンすると、次回はエラー無しで生スキャンが完了し、
/// 前回追跡していたが今回見つからないパスとして正しく「確定削除」判定され、
/// `file_metadata`/`image_stats`から消え、プレイリストからも除去されることを検証する。
#[test]
#[cfg(unix)]
fn file_that_was_error_unknown_is_deleted_once_error_clears_and_file_is_actually_gone() {
    use std::os::unix::fs::PermissionsExt;

    if !chmod_000_actually_denies_read() {
        eprintln!("root権限で実行されているためスキップ（chmodによる権限拒否が効かない）");
        return;
    }

    let dir = workspace("error_unknown_then_really_deleted");
    let root = dir.join("photos");
    let locked_dir = root.join("locked");
    std::fs::create_dir_all(&locked_dir).unwrap();
    write_jpeg(&locked_dir.join("a.jpg"));
    write_jpeg(&locked_dir.join("b.jpg"));
    write_jpeg(&root.join("top.jpg"));

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);

    let a_str = locked_dir.join("a.jpg").to_string_lossy().to_string();
    let b_str = locked_dir.join("b.jpg").to_string_lossy().to_string();
    let top_str = root.join("top.jpg").to_string_lossy().to_string();

    // 1. 初回スキャン（全ファイル読める状態）。
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &root,
        |_, _| {},
    )
    .expect("初回scanは成功するはず");

    // 2. lockedの権限を奪って再スキャン（エラー発生、a/bは「不明」としてプレイリスト・
    //    file_metadataとも維持される。#63 M2の挙動）。
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        Some(&root),
        &root,
        |_, _| {},
    );
    // 後片付け含め、この時点で必ず権限を戻す（次のステップの前提でもある）。
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let progress = progress.expect("エラーサブツリーがあってもscan自体は成功するはず");
    assert!(progress.error_count >= 1, "1回目の再scanはエラーが出るはず");
    {
        let db = db_mutex.lock().unwrap();
        assert_eq!(
            db.get_file_metadata_under(&root.to_string_lossy())
                .unwrap()
                .len(),
            3,
            "エラー直後はa/bともfile_metadataに残っているはず"
        );
    }

    // 3. 権限を戻した後、今度は本当にlocked配下を削除する
    //    （「エラーが解消してからファイルを消した」を再現する）。
    std::fs::remove_dir_all(&locked_dir).unwrap();

    // 4. 再スキャン。今回はエラー無しで生スキャンが完了し、a/bは「前回追跡していたが
    //    今回見つからない」＝確定削除と判定されるはず。
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        Some(&root),
        &root,
        |_, _| {},
    )
    .expect("エラー解消後のscanは成功するはず");

    assert_eq!(progress.error_count, 0, "今回はエラーが無いはず");
    assert_eq!(
        progress.deleted_files, 2,
        "本当に消えたa/bの2件が確定削除と判定されるはず"
    );

    let db = db_mutex.lock().unwrap();
    let remaining = db.get_file_metadata_under(&root.to_string_lossy()).unwrap();
    let remaining_paths: Vec<&str> = remaining.iter().map(|(p, ..)| p.as_str()).collect();
    assert_eq!(
        remaining_paths,
        vec![top_str.as_str()],
        "確定削除されたa/bはfile_metadataから消え、top.jpgだけが残るはず"
    );

    let (a_count, a_last) = db.get_image_stats(&a_str).unwrap();
    assert_eq!(
        (a_count, a_last),
        (0, None),
        "確定削除されたaのimage_statsも消えている（未登録扱いの既定値）はず"
    );
    let (b_count, b_last) = db.get_image_stats(&b_str).unwrap();
    assert_eq!(
        (b_count, b_last),
        (0, None),
        "確定削除されたbのimage_statsも消えている（未登録扱いの既定値）はず"
    );
    drop(db);

    let playlist_lock = playlist_mutex.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert_eq!(
        playlist.total_count(),
        1,
        "確定削除されたa/bはプレイリストからも除去され、top.jpgの1件だけになるはず"
    );
    let current_paths = playlist.current_paths();
    assert!(
        !current_paths.contains(&a_str) && !current_paths.contains(&b_str),
        "確定削除されたa/bはプレイリストに残っていてはいけない: {current_paths:?}"
    );
    assert!(current_paths.contains(&top_str));
    drop(playlist_lock);

    let _ = std::fs::remove_dir_all(&dir);
}
