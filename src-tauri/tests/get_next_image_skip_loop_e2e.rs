//! #62レビュー3巡目 T-M1(must)/S-a/S-b の回帰テスト: `get_next_image`/`get_previous_image`
//! の「消えたファイルを内部で読み飛ばす」スキップループについて、次の3点を直接検証する。
//! (1) スキャン対象ディレクトリ自体が丸ごと無い場合は一切 `advance` しないこと（T-M1）。
//! (2) 個々のファイル欠損は複数件連続でも正しく読み飛ばし、実在する1件だけをカウントし、
//! 上限（20件）で確実に打ち切ること（S-a）。
//! (3) キャッシュ変換の失敗/タイムアウトはファイル欠損と区別し、ループで繰り返さず
//! 即座に打ち切ること（S-b）。
//!
//! `#[tauri::command]` な非同期関数は `State<'_, AppState>` を引数に取るため、
//! `tauri::test::mock_app()`（`get_next_image_missing_file.rs` と同じ手法）を使う。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::image::{get_next_image, get_previous_image, ImageNavigationResult};
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

/// `get_next_image`/`get_previous_image` 内の `MAX_MISSING_FILE_SKIPS` と同じ値
/// （private constのためテスト側でも同じ値を明示する）。
const MAX_MISSING_FILE_SKIPS: usize = 20;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_get_next_image_skip_loop_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn build_app(
    playlist: Playlist,
    directory_path: Option<PathBuf>,
    cache_dir: PathBuf,
) -> tauri::App<tauri::test::MockRuntime> {
    std::fs::create_dir_all(&cache_dir).unwrap();
    let db = Database::new(cache_dir.join("sss.db")).expect("db init");
    let app = tauri::test::mock_app();
    app.manage(AppState {
        db: Mutex::new(db),
        playlist: Mutex::new(Some(playlist)),
        directory_path: Mutex::new(directory_path),
        cache_dir: cache_dir.clone(),
        cache_worker: CacheWorker::spawn(cache_dir),
        _keep_awake: None,
        scan_in_progress: std::sync::atomic::AtomicBool::new(false),
        last_incremented_display: Mutex::new(None),
    });
    app
}

/// #62レビュー3巡目 T-M1(must): 対象ディレクトリ自体が存在しない場合、
/// `get_next_image` は一切 `advance` せず即座に `None` を返す。
#[test]
fn get_next_image_does_not_advance_when_directory_root_is_missing() {
    let dir = workspace("root_missing");
    let missing_root = dir.join("does_not_exist_at_all");
    assert!(!missing_root.exists());

    let playlist = Playlist::new(vec![
        missing_root.join("a.jpg").to_string_lossy().to_string(),
        missing_root.join("b.jpg").to_string_lossy().to_string(),
        missing_root.join("c.jpg").to_string_lossy().to_string(),
    ]);

    let app = build_app(playlist, Some(missing_root), dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state.clone()))
        .expect("get_next_imageはエラーにならないはず");

    assert!(
        matches!(result, ImageNavigationResult::RootUnavailable),
        "ルート不在ならRootUnavailableを返すはず"
    );
    {
        let playlist_lock = state.playlist.lock().unwrap();
        let playlist = playlist_lock.as_ref().unwrap();
        assert_eq!(
            playlist.next_index(),
            0,
            "T-M1: ルート不在ならadvanceが一切行われずnext_indexは進まないはず"
        );
        assert!(
            playlist.current().is_none(),
            "advanceしていないのでcurrentもNoneのはず"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 T-M1(must): 複数回呼んでも、ルートが無い間はnext_indexが
/// 一切進まない（=鑑賞中にNAS/USBが外れても、タイマーで何度呼ばれても未表示画像を
/// 消費し続けない）ことを確認する。
#[test]
fn get_next_image_stays_at_same_position_across_repeated_calls_while_root_missing() {
    let dir = workspace("root_missing_repeated");
    let missing_root = dir.join("gone");

    let playlist = Playlist::new(
        (0..5)
            .map(|i| {
                missing_root
                    .join(format!("img{i}.jpg"))
                    .to_string_lossy()
                    .to_string()
            })
            .collect(),
    );

    let app = build_app(playlist, Some(missing_root), dir.join("cache"));
    let state = app.state::<AppState>();

    for _ in 0..5 {
        let result = tauri::async_runtime::block_on(get_next_image(state.clone())).unwrap();
        assert!(matches!(result, ImageNavigationResult::RootUnavailable));
    }

    let playlist_lock = state.playlist.lock().unwrap();
    assert_eq!(
        playlist_lock.as_ref().unwrap().next_index(),
        0,
        "ルート不在のまま何度呼んでもnext_indexは0のままのはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 S-a: 消失→消失→実在の順で並んでいる場合、1回の呼び出しで
/// 実在する1件だけが返り、表示回数もその1件だけに加算され、next_indexは3進む。
#[test]
fn get_next_image_skips_consecutive_missing_files_and_returns_first_existing() {
    let dir = workspace("skip_two_then_found");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();

    let missing1 = root.join("missing1.jpg").to_string_lossy().to_string();
    let missing2 = root.join("missing2.jpg").to_string_lossy().to_string();
    let existing_path = root.join("exists.jpg");
    std::fs::write(&existing_path, b"fixture").unwrap();
    let existing = existing_path.to_string_lossy().to_string();

    // シャッフル順を固定するため from_persisted で直接組み立てる
    // （next_index=0・履歴空=まだ何も表示していない状態）。
    let playlist = Playlist::from_persisted(
        vec![missing1.clone(), missing2.clone(), existing.clone()],
        0,
        vec![],
        0,
    );

    let app = build_app(playlist, Some(root.clone()), dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state.clone()))
        .expect("get_next_imageはエラーにならないはず");

    let info = match result {
        ImageNavigationResult::Found(info) => info,
        other => panic!("3件目は実在するので画像が返るはず: {other:?}"),
    };
    assert_eq!(info.path, existing);

    {
        let playlist_lock = state.playlist.lock().unwrap();
        let playlist = playlist_lock.as_ref().unwrap();
        assert_eq!(
            playlist.next_index(),
            3,
            "S-a: 消失2件+実在1件の3回ぶんadvanceが進むはず"
        );
    }
    {
        let db = state.db.lock().unwrap();
        let (count, _) = db.get_image_stats(&existing).unwrap();
        assert_eq!(count, 1, "実在した1件だけ表示回数が加算されるはず");
        let (missing1_count, _) = db.get_image_stats(&missing1).unwrap();
        let (missing2_count, _) = db.get_image_stats(&missing2).unwrap();
        assert_eq!(missing1_count, 0, "消失ファイルは加算されないはず");
        assert_eq!(missing2_count, 0, "消失ファイルは加算されないはず");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 S-a: 上限（`MAX_MISSING_FILE_SKIPS`=20件）まで全て消失している
/// 場合、ちょうど20回ぶんadvanceして`None`を返す（無限ループしない・21回目には
/// 進まない）。
#[test]
fn get_next_image_gives_up_after_max_missing_file_skips() {
    let dir = workspace("skip_upper_bound");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();

    // MAX_MISSING_FILE_SKIPSより多い件数を用意し、全て実在しないパスにする。
    let paths: Vec<String> = (0..(MAX_MISSING_FILE_SKIPS + 5))
        .map(|i| {
            root.join(format!("missing{i}.jpg"))
                .to_string_lossy()
                .to_string()
        })
        .collect();

    let playlist = Playlist::from_persisted(paths, 0, vec![], 0);

    let app = build_app(playlist, Some(root.clone()), dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state.clone())).unwrap();
    assert!(
        matches!(result, ImageNavigationResult::LoadFailed),
        "全件消失しているのでLoadFailedのはず"
    );

    let playlist_lock = state.playlist.lock().unwrap();
    assert_eq!(
        playlist_lock.as_ref().unwrap().next_index(),
        MAX_MISSING_FILE_SKIPS,
        "上限ちょうどの件数だけadvanceして打ち切るはず(無限ループしない)"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 S-a: `get_previous_image` も同様に、履歴を戻る途中で欠損した
/// ファイルを読み飛ばし、実在する古い画像を返す。
#[test]
fn get_previous_image_skips_missing_file_in_history_and_returns_older_existing_one() {
    let dir = workspace("previous_skip");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();

    let f1_path = root.join("f1.jpg");
    let f2_path = root.join("f2.jpg");
    let f3_path = root.join("f3.jpg");
    std::fs::write(&f1_path, b"fixture").unwrap();
    std::fs::write(&f2_path, b"fixture").unwrap();
    std::fs::write(&f3_path, b"fixture").unwrap();
    let f1 = f1_path.to_string_lossy().to_string();
    let f2 = f2_path.to_string_lossy().to_string();
    let f3 = f3_path.to_string_lossy().to_string();

    // f1→f2→f3の順に既に表示済みで、現在f3を表示中という状態を直接組み立てる。
    let playlist = Playlist::from_persisted(
        vec![f1.clone(), f2.clone(), f3.clone()],
        3,
        vec![f1.clone(), f2.clone(), f3.clone()],
        2,
    );

    // f2をディスクから消す(f1・f3は実在)。
    std::fs::remove_file(&f2_path).unwrap();

    let app = build_app(playlist, Some(root.clone()), dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_previous_image(state.clone()))
        .expect("get_previous_imageはエラーにならないはず");
    let info = match result {
        ImageNavigationResult::Found(info) => info,
        other => panic!("f2は消えているがf1が実在するので画像が返るはず: {other:?}"),
    };
    assert_eq!(info.path, f1);

    let playlist_lock = state.playlist.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert_eq!(
        playlist.history_position(),
        0,
        "f2を読み飛ばしてf1(履歴の先頭)まで戻るはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー3巡目 S-b(must): キャッシュ変換の失敗（壊れたTIFF、WebView非対応形式の
/// ため必ず同期変換待ちになる）は、ファイル欠損とは違いループで読み飛ばさず即座に
/// 打ち切る。もし誤って`Missing`と同じ扱いでループを続けていたら、後続の画像を
/// 試みてしまう（このテストでは後続画像への表示回数加算が起きないことで検出する）上、
/// 同種の失敗が続けば最悪 `MAX_MISSING_FILE_SKIPS × CACHE_WAIT_TIMEOUT`
/// （20×5秒=100秒）ブロックしうる。ここでは1回ぶんの失敗検出が速い
/// （実質ミリ秒オーダー）ことも合わせて確認する。
#[test]
fn get_next_image_stops_immediately_on_processing_failure_without_retrying() {
    let dir = workspace("processing_failed");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();

    // 拡張子.tiffはWebView非対応形式として常に同期キャッシュ変換待ちになるが、
    // 中身が壊れているためワーカーの変換(decode)は失敗し、mark_failed+notifyで
    // request_current_and_waitは(タイムアウトを待たず)即座にfalseを返す。
    let bad_tiff_path = root.join("broken.tiff");
    std::fs::write(&bad_tiff_path, b"not a real tiff file, decode must fail").unwrap();
    let bad_tiff = bad_tiff_path.to_string_lossy().to_string();

    let good_path = root.join("good.jpg");
    std::fs::write(&good_path, b"fixture").unwrap();
    let good = good_path.to_string_lossy().to_string();

    let playlist = Playlist::from_persisted(vec![bad_tiff.clone(), good.clone()], 0, vec![], 0);

    let app = build_app(playlist, Some(root.clone()), dir.join("cache"));
    let state = app.state::<AppState>();

    let started = Instant::now();
    let result = tauri::async_runtime::block_on(get_next_image(state.clone()))
        .expect("get_next_imageはエラーにならないはず");
    let elapsed = started.elapsed();

    assert!(
        matches!(result, ImageNavigationResult::LoadFailed),
        "キャッシュ変換に失敗したのでLoadFailedが返るはず(goodへは進まない)"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "1回の失敗検出は速いはず(タイムアウトを1回も待たず即座に打ち切られる): {elapsed:?}"
    );

    let playlist_lock = state.playlist.lock().unwrap();
    let playlist = playlist_lock.as_ref().unwrap();
    assert_eq!(
        playlist.next_index(),
        1,
        "S-b: 変換失敗はその場で打ち切るため、後続のgoodへは進まないはず"
    );
    drop(playlist_lock);

    let db = state.db.lock().unwrap();
    let (good_count, _) = db.get_image_stats(&good).unwrap();
    assert_eq!(
        good_count, 0,
        "打ち切られているのでgoodは一度も試されず表示回数も0のはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
