use crate::commands::types::AppState;
use crate::image_processor::{
    get_display_dimensions, get_exif_info, is_video_file, plan_cache_file, ImageInfo,
};
use std::path::Path;
use tauri::State;

/// 次の画像を取得（カウント+1）
#[tauri::command]
pub async fn get_next_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(ref mut playlist) = *playlist_lock {
        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        let (image_path, should_count) = playlist.advance();
        if let Some(image_path) = image_path {
            let path_str = image_path.clone();

            // 5枚先までのパスを取得（先読み用）
            let mut prefetch_paths = Vec::new();
            for i in 1..=5 {
                if let Some(path) = playlist.peek_next_n(i) {
                    prefetch_paths.push(path.clone());
                }
            }

            drop(playlist_lock);

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
            let info = get_image_info_internal(&path_str, &state, apply_rotation)?;

            // 表示回数の加算はファイル存在確認後（#60 問題9: 消失ファイルを無駄カウントしない）
            if info.is_some() && should_count {
                let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
                let _ = db.increment_display_count(&path_str);
            }

            // 5枚先まで先読みキュー投入（単一ワーカーが直列処理・重複排除・世代管理する）
            enqueue_prefetch(&state, prefetch_paths, apply_rotation);

            Ok(info)
        } else {
            Ok(None)
        }
    } else {
        Err("Playlist not initialized".to_string())
    }
}

/// 前の画像を取得（カウント増やさない）
#[tauri::command]
pub async fn get_previous_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(ref mut playlist) = *playlist_lock {
        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        if !playlist.can_go_back() {
            return Ok(None);
        }

        if let Some(image_path) = playlist.go_back() {
            let path_str = image_path.clone();

            drop(playlist_lock);

            let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
            // apply_exif_rotation 設定を取得（デフォルト true）
            let apply_rotation = db
                .get_setting("apply_exif_rotation")
                .ok()
                .flatten()
                .map(|v| v != "false")
                .unwrap_or(true);
            drop(db);

            // 画像情報を取得（カウントは増やさない）
            get_image_info_internal(&path_str, &state, apply_rotation)
        } else {
            Ok(None)
        }
    } else {
        Err("Playlist not initialized".to_string())
    }
}

/// 画像情報を取得（内部ヘルパー関数）
///
/// キャッシュが必要かつ未生成の場合は、単一ワーカースレッドへ「現在画像」として
/// 優先度付きで要求を積み、まだ存在しない間は原本のパスを返す（すぐに表示するため）。
fn get_image_info_internal(
    image_path: &str,
    state: &State<AppState>,
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

    // 画像サイズ（動画の場合は0x0）。ヘッダのみ読み、回転時は幅高さを入れ替える。
    let (width, height) = if !is_video {
        get_display_dimensions(path, apply_rotation).unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    // キャッシュ対象の判定は image_processor::plan_cache_file に一元化
    // （WebView非対応形式・回転が必要・4K超のいずれか。アニメGIF/WebPは対象外）
    let optimized_path = if is_video {
        None
    } else if let Some(cache_file) = plan_cache_file(path, apply_rotation, &state.cache_dir) {
        if cache_file.exists() {
            Some(cache_file.to_string_lossy().to_string())
        } else {
            // キャッシュがない場合は、単一ワーカーへ優先要求してから元画像を返す
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
