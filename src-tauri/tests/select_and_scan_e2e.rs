//! #93 の回帰テスト: フォルダ選択（ダイアログ）とスキャンを Rust 側で統合した
//! `select_and_scan` / `rescan_last_directory` / `select_share_directory` の本体
//! （`perform_*`）を、ダイアログを差し替えたスタブ `DirectoryPicker` で検証する。
//!
//! 確認する性質:
//! - ダイアログで選ばれたフォルダだけがスキャンされ、`last_directory_path` に保存される
//! - キャンセルはエラーでなく `Cancelled` で、何も変更しない
//! - DB 保存済みの前回フォルダは引数なしで再スキャンできる（保存が無ければ `noLastDirectory`）
//! - ダイアログを経ない任意パスの指定経路が無い（`save_setting` は管理下パスの基準キーを
//!   書けない。ピック先も不正パスは拒否される）

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use sss_lib::commands::dialog::DirectoryPicker;
use sss_lib::commands::scan::{
    acquire_dialog_guard, perform_rescan_last_directory, perform_select_and_scan,
    SelectScanOutcome, LAST_DIRECTORY_KEY,
};
use sss_lib::commands::settings::{
    perform_save_setting, perform_select_share_directory, WRITABLE_SETTING_KEYS,
};
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;

/// ダイアログの代わりに固定の結果を返すスタブ。`None` はキャンセル。
struct StubPicker(Option<PathBuf>);

impl DirectoryPicker for StubPicker {
    fn pick_directory(&self, _title: Option<&str>) -> Option<PathBuf> {
        self.0.clone()
    }
}

struct Env {
    root: PathBuf,
    db: Mutex<Database>,
    playlist: Mutex<Option<Playlist>>,
    directory_path: Mutex<Option<PathBuf>>,
    scan_in_progress: AtomicBool,
}

fn env(tag: &str) -> Env {
    let root =
        std::env::temp_dir().join(format!("sss_select_and_scan_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    Env {
        db: Mutex::new(Database::new(root.join("sss.db")).expect("db init")),
        playlist: Mutex::new(None),
        directory_path: Mutex::new(None),
        scan_in_progress: AtomicBool::new(false),
        root,
    }
}

fn photos(root: &Path, name: &str, count: usize) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..count {
        std::fs::write(dir.join(format!("img{i}.jpg")), b"x").unwrap();
    }
    dir
}

fn select(env: &Env, picker: &StubPicker) -> Result<SelectScanOutcome, String> {
    perform_select_and_scan(
        picker,
        Some("title"),
        &env.db,
        &env.playlist,
        &env.directory_path,
        &env.scan_in_progress,
        |_, _| {},
    )
}

fn last_directory(env: &Env) -> Option<String> {
    env.db
        .lock()
        .unwrap()
        .get_setting(LAST_DIRECTORY_KEY)
        .unwrap()
}

#[test]
fn select_and_scan_scans_only_the_chosen_directory_and_persists_it() {
    let env = env("chosen");
    let chosen = photos(&env.root, "chosen", 4);
    let other = photos(&env.root, "other", 9);

    let outcome = select(&env, &StubPicker(Some(chosen.clone()))).unwrap();
    match outcome {
        SelectScanOutcome::Scanned(progress, safe_dir) => {
            assert_eq!(progress.total_files, 4);
            assert_eq!(safe_dir, chosen.canonicalize().unwrap());
        }
        other => panic!("選択したフォルダがスキャンされるはず: {other:?}"),
    }
    assert_eq!(
        last_directory(&env),
        Some(chosen.to_string_lossy().to_string())
    );
    assert_eq!(
        env.directory_path.lock().unwrap().as_deref(),
        Some(chosen.as_path())
    );
    assert_eq!(
        env.playlist.lock().unwrap().as_ref().unwrap().total_count(),
        4
    );
    // 選んでいないフォルダのファイルは DB に入らない
    let known = env
        .db
        .lock()
        .unwrap()
        .get_file_metadata_under(&other.to_string_lossy())
        .unwrap();
    assert!(known.is_empty());

    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn cancelled_dialog_is_not_an_error_and_changes_nothing() {
    let env = env("cancel");
    let outcome = select(&env, &StubPicker(None)).unwrap();
    assert!(matches!(outcome, SelectScanOutcome::Cancelled));
    assert_eq!(last_directory(&env), None);
    assert!(env.playlist.lock().unwrap().is_none());
    assert!(env.directory_path.lock().unwrap().is_none());

    // 既に前回フォルダがある状態でキャンセルしても、保存値は変わらない
    let first = photos(&env.root, "first", 2);
    select(&env, &StubPicker(Some(first.clone()))).unwrap();
    let outcome = select(&env, &StubPicker(None)).unwrap();
    assert!(matches!(outcome, SelectScanOutcome::Cancelled));
    assert_eq!(
        last_directory(&env),
        Some(first.to_string_lossy().to_string())
    );

    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn switching_directory_updates_last_directory() {
    let env = env("switch");
    let a = photos(&env.root, "a", 2);
    let b = photos(&env.root, "b", 3);
    select(&env, &StubPicker(Some(a))).unwrap();
    select(&env, &StubPicker(Some(b.clone()))).unwrap();
    assert_eq!(last_directory(&env), Some(b.to_string_lossy().to_string()));
    assert_eq!(
        env.playlist.lock().unwrap().as_ref().unwrap().total_count(),
        3
    );
    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn invalid_chosen_paths_are_rejected_with_error_codes_and_not_saved() {
    let env = env("invalid");
    let missing = env.root.join("missing");
    let err = select(&env, &StubPicker(Some(missing.clone()))).unwrap_err();
    // 選んだパスがエラーコードの detail に載る（フロントは旧フォルダでなくこれを表示する）
    assert_eq!(err, format!("directoryNotFound:{}", missing.display()));
    assert_eq!(last_directory(&env), None);

    // 相対パス（実在しても sanitize_allow_dir が拒否する）
    let err = select(&env, &StubPicker(Some(PathBuf::from(".")))).unwrap_err();
    assert_eq!(err, "directoryUnsafe:.");
    assert_eq!(last_directory(&env), None);

    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn select_fails_with_scan_in_progress_when_another_scan_runs() {
    let env = env("busy");
    let dir = photos(&env.root, "busy", 1);
    env.scan_in_progress
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let err = select(&env, &StubPicker(Some(dir))).unwrap_err();
    assert_eq!(err, "scanInProgress");
    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn rescan_last_directory_uses_saved_directory_without_any_path_argument() {
    let env = env("rescan");
    let dir = photos(&env.root, "lib", 3);
    select(&env, &StubPicker(Some(dir.clone()))).unwrap();

    // 新しい画像を足してから引数なしで再スキャン
    std::fs::write(dir.join("new.jpg"), b"x").unwrap();
    let (progress, safe_dir) = perform_rescan_last_directory(
        &env.db,
        &env.playlist,
        &env.directory_path,
        &env.scan_in_progress,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(progress.total_files, 4);
    assert_eq!(progress.new_files, 1);
    assert_eq!(safe_dir, dir.canonicalize().unwrap());

    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn rescan_last_directory_without_saved_directory_is_no_last_directory_error() {
    let env = env("rescan_none");
    let err = perform_rescan_last_directory(
        &env.db,
        &env.playlist,
        &env.directory_path,
        &env.scan_in_progress,
        |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, "noLastDirectory");
    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn rescan_last_directory_reports_missing_saved_directory() {
    let env = env("rescan_gone");
    let dir = photos(&env.root, "gone", 1);
    select(&env, &StubPicker(Some(dir.clone()))).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    let err = perform_rescan_last_directory(
        &env.db,
        &env.playlist,
        &env.directory_path,
        &env.scan_in_progress,
        |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, format!("directoryNotFound:{}", dir.display()));
    let _ = std::fs::remove_dir_all(&env.root);
}

/// WebView から呼べる汎用の `save_setting` では、管理下パスの基準になるキーを
/// 書き換えられない（ダイアログを経ない経路を塞ぐ）。拒否時は DB 値が不変。
#[test]
fn save_setting_rejects_protected_keys_and_leaves_db_untouched() {
    let env = env("save_setting");
    {
        let db = env.db.lock().unwrap();
        db.save_setting(LAST_DIRECTORY_KEY, "/original").unwrap();
        db.save_setting("share_directory_path", "/orig-share")
            .unwrap();
        for protected in [
            LAST_DIRECTORY_KEY,
            "share_directory_path",
            "sssignore_migrated",
            "unknown_key",
        ] {
            let err = perform_save_setting(&db, protected, "/etc").unwrap_err();
            assert_eq!(err, "settingKeyNotWritable", "{protected}");
        }
        assert_eq!(
            db.get_setting(LAST_DIRECTORY_KEY).unwrap(),
            Some("/original".to_string())
        );
        assert_eq!(
            db.get_setting("share_directory_path").unwrap(),
            Some("/orig-share".to_string())
        );
        assert_eq!(db.get_setting("sssignore_migrated").unwrap(), None);
        assert_eq!(db.get_setting("unknown_key").unwrap(), None);
    }
    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn save_setting_saves_every_allowed_key() {
    let env = env("save_setting_ok");
    {
        let db = env.db.lock().unwrap();
        for key in WRITABLE_SETTING_KEYS {
            perform_save_setting(&db, key, "v").unwrap();
            assert_eq!(db.get_setting(key).unwrap(), Some("v".to_string()), "{key}");
        }
        // UI が実際に保存する設定は書ける
        for key in [
            "display_interval",
            "language",
            "apply_exif_rotation",
            "video_audio_enabled",
            "video_max_duration_sec",
        ] {
            assert!(WRITABLE_SETTING_KEYS.contains(&key), "{key}");
        }
    }
    let _ = std::fs::remove_dir_all(&env.root);
}

/// ダイアログを出す前に、スキャン実行中なら `scanInProgress`、別のダイアログが表示中なら
/// `dialogInProgress` で弾く。ガードを drop すれば再び取れる。
#[test]
fn dialog_guard_rejects_when_scanning_or_dialog_already_open() {
    let scan = AtomicBool::new(false);
    let dialog = AtomicBool::new(false);

    let guard = acquire_dialog_guard(&scan, &dialog, true).unwrap();
    assert_eq!(
        acquire_dialog_guard(&scan, &dialog, true).err(),
        Some("dialogInProgress".to_string())
    );
    drop(guard);
    assert!(acquire_dialog_guard(&scan, &dialog, true).is_ok());

    scan.store(true, std::sync::atomic::Ordering::SeqCst);
    let dialog2 = AtomicBool::new(false);
    assert_eq!(
        acquire_dialog_guard(&scan, &dialog2, true).err(),
        Some("scanInProgress".to_string())
    );
    // ダイアログは出ていない（フラグを取っていない）
    assert!(!dialog2.load(std::sync::atomic::Ordering::SeqCst));
    // ピック先の選択はスキャン中でも開ける
    assert!(acquire_dialog_guard(&scan, &dialog2, false).is_ok());
}

#[test]
fn select_share_directory_saves_acceptable_choice_and_cancel_is_none() {
    let env = env("share");
    let home = env.root.join("home");
    let picked = home.join("Pictures").join("my-picks");
    std::fs::create_dir_all(&picked).unwrap();

    let saved = perform_select_share_directory(
        &StubPicker(Some(picked.clone())),
        None,
        &env.db,
        Some(&home),
    )
    .unwrap();
    assert_eq!(saved, Some(picked.clone()));
    assert_eq!(
        env.db
            .lock()
            .unwrap()
            .get_setting("share_directory_path")
            .unwrap(),
        Some(picked.to_string_lossy().to_string())
    );

    // キャンセルは None で、保存値は変わらない
    let cancelled =
        perform_select_share_directory(&StubPicker(None), None, &env.db, Some(&home)).unwrap();
    assert_eq!(cancelled, None);
    assert_eq!(
        env.db
            .lock()
            .unwrap()
            .get_setting("share_directory_path")
            .unwrap(),
        Some(picked.to_string_lossy().to_string())
    );

    let _ = std::fs::remove_dir_all(&env.root);
}

#[test]
fn select_share_directory_rejects_broad_paths_and_keeps_previous_value() {
    let env = env("share_invalid");
    let home = env.root.join("home");
    std::fs::create_dir_all(&home).unwrap();

    // ホームそのもの・ルートはピック先にできない（#87/#91 の検証を通る）
    for bad in [
        home.clone(),
        PathBuf::from("/"),
        PathBuf::from("relative/dir"),
    ] {
        let err =
            perform_select_share_directory(&StubPicker(Some(bad)), None, &env.db, Some(&home))
                .unwrap_err();
        assert_eq!(err, "shareDirectoryInvalid");
    }
    assert_eq!(
        env.db
            .lock()
            .unwrap()
            .get_setting("share_directory_path")
            .unwrap(),
        None
    );
    let _ = std::fs::remove_dir_all(&env.root);
}
