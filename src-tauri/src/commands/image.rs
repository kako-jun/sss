use crate::cache_worker::CACHE_WAIT_TIMEOUT;
use crate::commands::types::AppState;
use crate::image_processor::{
    get_display_dimensions, get_exif_info, is_video_file, plan_cache_file,
    requires_synchronous_cache, ImageInfo,
};
use std::path::Path;
use tauri::State;

/// 次の画像を取得（カウント+1）
///
/// `playlist`/`db` の `MutexGuard` は非 `Send` なので、`.await`（下記の
/// `get_image_info_internal` 呼び出し）をまたいで生存させられない。ブロックで
/// スコープを切り、await の前に確実にドロップさせる（#60 レビュー2巡目
/// should(2) で `get_image_info_internal` を async 化した際に必要になった）。
#[tauri::command]
pub async fn get_next_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    let (path_str, should_count, prefetch_paths) = {
        let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        let playlist = playlist_lock
            .as_mut()
            .ok_or_else(|| "Playlist not initialized".to_string())?;

        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        let (image_path, should_count) = playlist.advance();
        let path_str = match image_path {
            Some(p) => p.clone(),
            None => return Ok(None),
        };

        // 5枚先までのパスを取得（先読み用）
        let mut prefetch_paths = Vec::new();
        for i in 1..=5 {
            if let Some(path) = playlist.peek_next_n(i) {
                prefetch_paths.push(path.clone());
            }
        }

        (path_str, should_count, prefetch_paths)
    };

    // apply_exif_rotation 設定を取得（デフォルト true）
    let apply_rotation = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.get_setting("apply_exif_rotation")
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    };

    // 画像情報を取得（内部で存在確認・現在画像のキャッシュ要求まで行う）
    let info = get_image_info_internal(&path_str, &state, apply_rotation).await?;

    // 表示回数の加算はファイル存在確認後（#60 問題9: 消失ファイルを無駄カウントしない）
    if info.is_some() && should_count {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db.increment_display_count(&path_str);
    }

    // 5枚先まで先読みキュー投入（単一ワーカーが直列処理・重複排除・世代管理する）
    enqueue_prefetch(&state, prefetch_paths, apply_rotation);

    Ok(info)
}

/// 前の画像を取得（カウント増やさない）
#[tauri::command]
pub async fn get_previous_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    let path_str = {
        let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        let playlist = playlist_lock
            .as_mut()
            .ok_or_else(|| "Playlist not initialized".to_string())?;

        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        if !playlist.can_go_back() {
            return Ok(None);
        }

        match playlist.go_back() {
            Some(p) => p.clone(),
            None => return Ok(None),
        }
    };

    // apply_exif_rotation 設定を取得（デフォルト true）
    let apply_rotation = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.get_setting("apply_exif_rotation")
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    };

    // 画像情報を取得（カウントは増やさない）
    get_image_info_internal(&path_str, &state, apply_rotation).await
}

/// 画像情報を取得（内部ヘルパー関数）
///
/// キャッシュが必要（4K超・WebView非対応形式・apply_rotation=false時の回転要求）
/// かつ未生成の場合、通常は単一ワーカーへ「現在画像」として優先度付きで要求を積み、
/// まだ存在しない間は原本のパスを返す（すぐに表示するため）。ただし
/// `requires_synchronous_cache` が true のケース（原本をそのまま返すと表示が誤る:
/// WebView非対応形式、または apply_rotation=false なのにEXIF回転が必要）は、
/// ワーカーの完了を待ってからキャッシュパスを返す（#60 レビュー1巡目 must2、
/// 2巡目 must B）。失敗/タイムアウト時はファイル不在と同様に `Ok(None)` を返し
/// スキップさせる（自動で次へ進める仕組み自体は #65）。
///
/// この同期待ちは `tauri::async_runtime::spawn_blocking` に逃がし、非同期コマンドの
/// 実行スレッドを最大 `CACHE_WAIT_TIMEOUT` 秒ブロックしないようにする
/// （#60 レビュー2巡目 should(2)）。
///
/// 回転（EXIF Orientation）は原則 WebView 既定の `image-orientation: from-image`
/// に任せる（#60 レビュー2巡目 must B）。ここではキャッシュ生成が必要になった
/// 場合にだけ `apply_rotation` に従って画素へ焼き込む/焼き込まない
/// （`plan_cache_file`/`optimize_image_for_4k`）。
async fn get_image_info_internal(
    image_path: &str,
    state: &State<'_, AppState>,
    apply_rotation: bool,
) -> Result<Option<ImageInfo>, String> {
    let path = Path::new(image_path);

    if !path.exists() {
        return Ok(None);
    }

    // 動画ファイルかどうかを判定
    let is_video = is_video_file(path);

    // ファイルサイズ
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // 画像サイズ（動画の場合は0x0）。ヘッダのみ読み、apply_rotation=true なら
    // 表示上の幅高さ（90/270度系は入替）を返す。実際の回転はWebView既定の
    // from-imageが行う。
    let (width, height) = if !is_video {
        get_display_dimensions(path, apply_rotation).unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    // キャッシュ対象の判定は image_processor::plan_cache_file に一元化
    // （WebView非対応形式・4K超・apply_rotation=false時の回転要求のいずれか。
    // apply_rotation=true での回転要求だけではキャッシュしない。アニメGIF/WebPは対象外）
    let optimized_path = if is_video {
        None
    } else if let Some(cache_file) = plan_cache_file(path, apply_rotation, &state.cache_dir) {
        if cache_file.exists() {
            state.cache_worker.mark_served(cache_file.clone());
            Some(cache_file.to_string_lossy().to_string())
        } else if requires_synchronous_cache(path, apply_rotation) {
            // 原本をそのまま返すと表示が誤るため、変換完了を待ってからキャッシュ
            // パスを返す。ブロッキング待ちは spawn_blocking へ逃がす（should2）。
            let worker = state.cache_worker.clone();
            let wait_path = path.to_path_buf();
            let wait_cache_file = cache_file.clone();
            let ready = tauri::async_runtime::spawn_blocking(move || {
                worker.request_current_and_wait(
                    wait_path,
                    wait_cache_file,
                    apply_rotation,
                    CACHE_WAIT_TIMEOUT,
                )
            })
            .await
            .unwrap_or(false);

            if ready && cache_file.exists() {
                state.cache_worker.mark_served(cache_file.clone());
                Some(cache_file.to_string_lossy().to_string())
            } else {
                // 失敗/タイムアウト: 表示不能/表示が誤る原本を返すよりスキップ扱いにする。
                return Ok(None);
            }
        } else {
            // 4K超のみが理由の場合は非同期。単一ワーカーへ優先要求してから元画像を返す
            // （原本もWebViewで正しく表示できる形式・向きなので、生成完了までは
            // 原本で表示できる）。
            state
                .cache_worker
                .request_current(path.to_path_buf(), cache_file, apply_rotation);
            None
        }
    } else {
        None
    };

    // EXIF情報（画像のみ）
    let exif = if !is_video {
        get_exif_info(path).ok()
    } else {
        None
    };

    // データベースから統計情報を取得
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let (display_count, last_displayed) = db.get_image_stats(image_path).unwrap_or((0, None));
    drop(db);

    Ok(Some(ImageInfo {
        path: image_path.to_string(),
        optimized_path,
        is_video,
        width,
        height,
        file_size,
        exif,
        display_count,
        last_displayed,
    }))
}

/// 先読み対象パスをキャッシュ要否判定した上でワーカーへまとめて投入する。
fn enqueue_prefetch(state: &State<AppState>, prefetch_paths: Vec<String>, apply_rotation: bool) {
    let items: Vec<_> = prefetch_paths
        .into_iter()
        .filter_map(|p| {
            let path = Path::new(&p);
            if !path.exists() || is_video_file(path) {
                return None;
            }
            plan_cache_file(path, apply_rotation, &state.cache_dir)
                .map(|cache_file| (path.to_path_buf(), cache_file))
        })
        .collect();

    // 空でも呼ぶ: 古い世代の先読み要求（is_current でないもの）をここで破棄させるため
    state.cache_worker.request_prefetch(items, apply_rotation);
}
