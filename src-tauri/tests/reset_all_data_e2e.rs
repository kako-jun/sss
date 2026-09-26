//! #64 回帰テスト: `reset_all_data` の中核ロジック（DBを開いたままの全ユーザーデータ
//! テーブルのリセット＋メモリ上のplaylist/directory_pathのクリア）を実行した後、
//! DBファイル・接続を作り直さずに新しいディレクトリを問題なく再スキャンできることを
//! 確認する。
//!
//! `reset_all_data` コマンド自体は `AppHandle`（Wry固定のruntimeジェネリクス）を
//! 取るため、`perform_scan`/`perform_restore` と同じ理由で `tauri::test::mock_app()`
//! の `MockRuntime` では直接呼び出せない（各e2eテストのコメント参照）。ここでは
//! Tauri非依存の中核部分（`Database::reset_to_defaults` と `Mutex` のクリア）を
//! 直接組み立てて呼び、実際の `perform_scan` で再スキャンできることまで確認する。
//! （asset scopeの`forbid_directory`呼び出しはTauri依存のため対象外。
//! `Database::reset_to_defaults`単体の詳細な網羅は`src/database.rs`のユニットテスト、
//! スキャン中の排他は`src/commands/scan.rs`の`ScanGuard`ユニットテストが担う）

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::commands::scan::perform_scan;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_reset_all_data_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn reset_clears_state_and_allows_scanning_a_new_directory_afterward() {
    let dir = workspace("rescan");
    let old_photos = dir.join("old_photos");
    std::fs::create_dir_all(&old_photos).unwrap();
    for i in 0..3 {
        std::fs::write(old_photos.join(format!("img{i}.jpg")), b"x").unwrap();
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);

    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &old_photos,
        |_, _| {},
    )
    .unwrap();

    // スキャン直後はplaylist/directory_pathが両方セットされているはず
    assert!(playlist_mutex.lock().unwrap().is_some());
    assert!(directory_path_mutex.lock().unwrap().is_some());
    assert_eq!(db_mutex.lock().unwrap().get_total_image_count().unwrap(), 3);

    // --- ここから `commands::system::reset_all_data` の中核部分を再現する ---
    // 1. DBを開いたまま（接続を作り直さず）全ユーザーデータテーブルをリセット
    db_mutex.lock().unwrap().reset_to_defaults().unwrap();
    // 2. メモリ上のplaylist/directory_pathをクリア
    *playlist_mutex.lock().unwrap() = None;
    *directory_path_mutex.lock().unwrap() = None;
    // --- ここまで ---

    {
        let db = db_mutex.lock().unwrap();
        assert_eq!(
            db.get_total_image_count().unwrap(),
            0,
            "file_metadataは空になるはず"
        );
        assert_eq!(
            db.get_ignore_rules().unwrap().len(),
            6,
            "既定除外ルールが再投入されるはず"
        );
    }
    assert!(
        playlist_mutex.lock().unwrap().is_none(),
        "プレイリストはメモリ上からも消えるはず"
    );
    assert!(
        directory_path_mutex.lock().unwrap().is_none(),
        "directory_pathもメモリ上からクリアされるはず"
    );

    // リセット後、DB接続・スキーマを開いたままの状態で新しいディレクトリを
    // 問題なくスキャンできること（開いたままリセットしても以後の実運用に支障が
    // ないことの実質的な確認）
    let new_photos = dir.join("new_photos");
    std::fs::create_dir_all(&new_photos).unwrap();
    for i in 0..5 {
        std::fs::write(new_photos.join(format!("photo{i}.png")), b"y").unwrap();
    }

    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &new_photos,
        |_, _| {},
    )
    .unwrap();

    assert_eq!(
        progress.total_files, 5,
        "新しいディレクトリの全件が対象になるはず"
    );
    assert!(playlist_mutex.lock().unwrap().is_some());
    assert_eq!(
        directory_path_mutex.lock().unwrap().as_deref(),
        Some(new_photos.as_path())
    );
    assert_eq!(db_mutex.lock().unwrap().get_total_image_count().unwrap(), 5);

    let _ = std::fs::remove_dir_all(&dir);
}

/// 状態遷移: スキャン→reset→**同じ**ディレクトリを再スキャンした場合。
/// `reset_to_defaults` で `file_metadata` が空になるため、以前と同じファイルでも
/// 「新規追加」として再検出されること（#63の差分比較はDB上の記録が基準であり、
/// resetでその記録が消えれば実ファイルが変わっていなくても新規扱いになる）を確認する。
///
/// 注: asset scope（`convertFileSrc` が読み込めるディレクトリ）の
/// `forbid_directory`/`allow_directory` は `AppHandle` が必要なため、この
/// perform_scan直呼びテストの対象外（`commands::system::reset_all_data`本体の
/// コメント参照）。**そちらを直接検証したところ、同じディレクトリに対して
/// `forbid_directory` した後に `allow_directory` を呼んでも許可は復活しない
/// （forbidが恒久的に優先され続ける）ことを確認済み。** これは
/// `reset_all_data`→同一ディレクトリ再スキャンという運用上あり得る手順で、
/// 再スキャン後も画像がasset scopeにより読み込めなくなり続ける実装バグの疑いが
/// 強い（詳細はテスト結果報告を参照。本ファイルでは修正・追加テストをしない）。
#[test]
fn reset_clears_state_and_allows_rescanning_the_same_directory_afterward() {
    let dir = workspace("rescan_same_dir");
    let photos = dir.join("photos");
    std::fs::create_dir_all(&photos).unwrap();
    for i in 0..4 {
        std::fs::write(photos.join(format!("img{i}.jpg")), b"x").unwrap();
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);

    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(db_mutex.lock().unwrap().get_total_image_count().unwrap(), 4);

    // --- reset_all_data の中核部分を再現 ---
    db_mutex.lock().unwrap().reset_to_defaults().unwrap();
    *playlist_mutex.lock().unwrap() = None;
    *directory_path_mutex.lock().unwrap() = None;
    // --- ここまで ---

    assert_eq!(
        db_mutex.lock().unwrap().get_total_image_count().unwrap(),
        0,
        "resetでfile_metadataは空になるはず"
    );

    // 同じディレクトリ（ファイルも一切変更していない）を再スキャンする
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos,
        |_, _| {},
    )
    .unwrap();

    assert_eq!(
        progress.total_files, 4,
        "同じディレクトリの全件が対象になるはず"
    );
    assert_eq!(
        progress.new_files, 4,
        "resetでfile_metadataの記録が消えているため、既存ファイルでも新規追加として\
         再検出されるはず"
    );
    assert!(playlist_mutex.lock().unwrap().is_some());
    assert_eq!(
        directory_path_mutex.lock().unwrap().as_deref(),
        Some(photos.as_path())
    );
    assert_eq!(db_mutex.lock().unwrap().get_total_image_count().unwrap(), 4);

    let _ = std::fs::remove_dir_all(&dir);
}
