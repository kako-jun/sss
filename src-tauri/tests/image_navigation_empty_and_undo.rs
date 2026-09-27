//! #65 で追加された `ImageNavigationResult::EmptyPlaylist` 分岐と `undo_display_count`
//! コマンドの回帰テスト。
//!
//! 実装した本人のセルフレビューでは、`ImageNavigationResult` のenumバリアント追加
//! （#65）のうち `EmptyPlaylist`（プレイリストが空）と、新規追加コマンド
//! `undo_display_count`（フロントの `<img>`/`<video>` onError から呼ばれ、
//! 既に加算済みの表示回数を取り消す）が、どちらもコマンド層の統合テストとして
//! 一度もカバーされていなかった。`get_next_image_skip_loop_e2e.rs` と同じ
//! `tauri::test::mock_app()` 手法を使う。

use std::path::PathBuf;
use std::sync::Mutex;

use sss_lib::cache_worker::CacheWorker;
use sss_lib::commands::image::{
    get_next_image, get_previous_image, undo_display_count, ImageNavigationResult,
};
use sss_lib::commands::AppState;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;
use tauri::Manager;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_image_navigation_empty_and_undo_{tag}_{}",
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

/// #65: プレイリストが空（除外ルールで全件除外・スキャン対象0件等）の場合、
/// `get_next_image` は `Err` でも `RootUnavailable` でもなく `EmptyPlaylist` を返す
/// （ディレクトリ自体は設定済みという意味区別。`directory_path` を `None` にして
/// 「ルートは常にアクセス可能」の条件下でプレイリストの空だけを検証する）。
#[test]
fn get_next_image_returns_empty_playlist_when_playlist_is_empty() {
    let dir = workspace("next_empty");
    let playlist = Playlist::new(vec![]);
    let app = build_app(playlist, None, dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state))
        .expect("get_next_imageはエラーにならないはず");

    assert!(
        matches!(result, ImageNavigationResult::EmptyPlaylist),
        "空プレイリストはEmptyPlaylistを返すはず: {result:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 同上、`get_previous_image` 側。
#[test]
fn get_previous_image_returns_empty_playlist_when_playlist_is_empty() {
    let dir = workspace("previous_empty");
    let playlist = Playlist::new(vec![]);
    let app = build_app(playlist, None, dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_previous_image(state))
        .expect("get_previous_imageはエラーにならないはず");

    assert!(
        matches!(result, ImageNavigationResult::EmptyPlaylist),
        "空プレイリストはEmptyPlaylistを返すはず: {result:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65: `undo_display_count` は `get_next_image` が既に加算した表示回数を1減らす。
/// フロントの `<img onError>` から呼ばれる想定の結線をコマンド層で検証する。
#[test]
fn undo_display_count_decrements_the_count_get_next_image_just_incremented() {
    let dir = workspace("undo_after_increment");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();
    let photo_path = root.join("a.jpg");
    std::fs::write(&photo_path, b"fixture").unwrap();
    let photo = photo_path.to_string_lossy().to_string();

    let playlist = Playlist::new(vec![photo.clone()]);
    let app = build_app(playlist, Some(root), dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(get_next_image(state.clone()))
        .expect("get_next_imageはエラーにならないはず");
    assert!(
        matches!(result, ImageNavigationResult::Found(_)),
        "唯一の実在ファイルなのでFoundのはず: {result:?}"
    );

    {
        let db = state.db.lock().unwrap();
        let (count, _) = db.get_image_stats(&photo).unwrap();
        assert_eq!(count, 1, "前提: get_next_imageで1加算されているはず");
    }

    tauri::async_runtime::block_on(undo_display_count(state.clone(), photo.clone()))
        .expect("undo_display_countはエラーにならないはず");

    {
        let db = state.db.lock().unwrap();
        let (count, _) = db.get_image_stats(&photo).unwrap();
        assert_eq!(count, 0, "onErrorでの取り消し後は0に戻るはず");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65: 一度も表示されていない（`image_stats` に行が無い）パスに対して
/// `undo_display_count` を呼んでもエラーにならない（二重発火・古い応答等の防御）。
#[test]
fn undo_display_count_on_never_displayed_path_does_not_error() {
    let dir = workspace("undo_unknown");
    let playlist = Playlist::new(vec![]);
    let app = build_app(playlist, None, dir.join("cache"));
    let state = app.state::<AppState>();

    let result = tauri::async_runtime::block_on(undo_display_count(
        state.clone(),
        "/never/displayed.jpg".to_string(),
    ));
    assert!(
        result.is_ok(),
        "未登録パスへのundo_display_countはErrにならないはず"
    );

    let db = state.db.lock().unwrap();
    let (count, last) = db.get_image_stats("/never/displayed.jpg").unwrap();
    assert_eq!((count, last), (0, None), "行が新規作成されないはず");

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65レビューS1: `undo_display_count`は`AppState.last_incremented_display`
/// （直近に実際に加算したパス）と一致した時だけ減らす。既に次の画像へ進んで
/// いた等で古い/無関係なパスを渡された場合は何もしない（誤って別の画像の
/// カウントを減らさない）。
#[test]
fn undo_display_count_does_nothing_when_path_does_not_match_last_incremented() {
    let dir = workspace("undo_mismatch");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();
    let a_path = root.join("a.jpg");
    std::fs::write(&a_path, b"fixture").unwrap();
    let a = a_path.to_string_lossy().to_string();

    let playlist = Playlist::new(vec![a.clone()]);
    let app = build_app(playlist, Some(root), dir.join("cache"));
    let state = app.state::<AppState>();

    tauri::async_runtime::block_on(get_next_image(state.clone()))
        .expect("get_next_imageはエラーにならないはず");
    {
        let db = state.db.lock().unwrap();
        let (count, _) = db.get_image_stats(&a).unwrap();
        assert_eq!(count, 1, "前提: aが1加算されているはず");
    }

    // aとは無関係な(直近加算していない)パスでundoを呼んでも何も起きない。
    tauri::async_runtime::block_on(undo_display_count(
        state.clone(),
        "/somewhere/else.jpg".to_string(),
    ))
    .expect("undo_display_countはエラーにならないはず");

    let db = state.db.lock().unwrap();
    let (count, _) = db.get_image_stats(&a).unwrap();
    assert_eq!(count, 1, "一致しないパスなのでaの加算は取り消されないはず");

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65レビューS1: `get_previous_image`（表示回数を増やさない）の直後に
/// `undo_display_count` を呼んでも、無関係な過去の加算を誤って減らさない。
///
/// #65レビュー2巡目M3(must): `Playlist::new` はシャッフルするため、2件の
/// パスのどちらが1回目/2回目に返るかは決め打ちできない（旧実装は`vec![a,b]`の
/// 並び順のまま`a`が1回目に出る前提で書かれており、約50%の確率でFAILしていた）。
/// 1回目の`get_next_image`が実際に返したパスを`first_path`として使い、
/// `undo_display_count`には`get_previous_image`が実際に返したパスを渡すことで、
/// シャッフル順に依存しないようにする。
#[test]
fn undo_display_count_does_not_decrement_after_get_previous_image() {
    let dir = workspace("undo_previous_noop");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();
    let a_path = root.join("a.jpg");
    let b_path = root.join("b.jpg");
    std::fs::write(&a_path, b"a").unwrap();
    std::fs::write(&b_path, b"b").unwrap();
    let a = a_path.to_string_lossy().to_string();
    let b = b_path.to_string_lossy().to_string();

    let playlist = Playlist::new(vec![a.clone(), b.clone()]);
    let app = build_app(playlist, Some(root), dir.join("cache"));
    let state = app.state::<AppState>();

    let extract_found_path = |result: ImageNavigationResult| match result {
        ImageNavigationResult::Found(info) => info.path,
        other => panic!("実在する2件のうちの1件なのでFoundのはず: {other:?}"),
    };

    // 2件を1回ずつ進める。シャッフル順は問わない
    // （first_path/second_pathを実際の結果から取り出す）。
    let first_result = tauri::async_runtime::block_on(get_next_image(state.clone())).unwrap();
    let first_path = extract_found_path(first_result);
    tauri::async_runtime::block_on(get_next_image(state.clone())).unwrap();

    let first_count_before = state
        .db
        .lock()
        .unwrap()
        .get_image_stats(&first_path)
        .unwrap()
        .0;
    assert_eq!(
        first_count_before, 1,
        "前提: 1回目に表示した画像は1加算されているはず"
    );

    // 履歴を1つ戻る（表示回数は加算されない = last_incremented_displayは更新されない）。
    // 2件しか無いプレイリストなので、1つ戻ると必ず1回目に表示したものに戻る。
    let back_result = tauri::async_runtime::block_on(get_previous_image(state.clone()))
        .expect("get_previous_imageはエラーにならないはず");
    let back_path = extract_found_path(back_result);
    assert_eq!(
        back_path, first_path,
        "1つ戻ると1回目に表示したものに戻るはず"
    );

    // 「前へ」で表示した画像（get_previous_imageが実際に返したパス）がonErrorに
    // なった、というシナリオでundoを呼んでも、get_previous_imageは
    // last_incremented_displayを更新していないため無視される。
    tauri::async_runtime::block_on(undo_display_count(state.clone(), back_path))
        .expect("undo_display_countはエラーにならないはず");

    let first_count_after = state
        .db
        .lock()
        .unwrap()
        .get_image_stats(&first_path)
        .unwrap()
        .0;
    assert_eq!(
        first_count_after, first_count_before,
        "get_previous_image由来のonErrorは既存カウントを減らさないはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #65レビューS1: 一致して1回減らした後は`last_incremented_display`がクリアされる
/// ため、同じ`onError`が万一2回届いても2回目は無視される（多重取り消しの防止）。
#[test]
fn undo_display_count_only_applies_once_even_if_called_twice() {
    let dir = workspace("undo_twice");
    let root = dir.join("photos");
    std::fs::create_dir_all(&root).unwrap();
    let photo_path = root.join("a.jpg");
    std::fs::write(&photo_path, b"fixture").unwrap();
    let photo = photo_path.to_string_lossy().to_string();

    let playlist = Playlist::new(vec![photo.clone()]);
    let app = build_app(playlist, Some(root), dir.join("cache"));
    let state = app.state::<AppState>();

    tauri::async_runtime::block_on(get_next_image(state.clone())).unwrap();
    assert_eq!(
        state.db.lock().unwrap().get_image_stats(&photo).unwrap().0,
        1
    );

    tauri::async_runtime::block_on(undo_display_count(state.clone(), photo.clone())).unwrap();
    assert_eq!(
        state.db.lock().unwrap().get_image_stats(&photo).unwrap().0,
        0
    );

    // 2回目は既にlast_incremented_displayがクリアされているので何もしない
    // （0未満にならないことはdecrement_display_count自体のMAXガードでも保証されて
    // いるが、そもそも呼ばれないことをここでは確認する）。
    tauri::async_runtime::block_on(undo_display_count(state.clone(), photo.clone())).unwrap();
    assert_eq!(
        state.db.lock().unwrap().get_image_stats(&photo).unwrap().0,
        0
    );

    let _ = std::fs::remove_dir_all(&dir);
}
