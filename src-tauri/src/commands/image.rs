use crate::commands::types::AppState;
use crate::image_processor::{
    get_exif_info, get_image_dimensions, is_video_file, optimize_image_for_4k, ImageInfo,
};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

/// 次の画像を取得（カウント+1）
#[tauri::command]
pub async fn get_next_image(state: State<'_, AppState>) -> Result<Option<ImageInfo>, String> {
    println!("get_next_image called");
    let mut playlist_lock = state.playlist.lock().unwrap();

    if let Some(ref mut playlist) = *playlist_lock {
        // プレイリストが空の場合はエラー
        if playlist.is_empty() {
            return Err("Playlist is empty".to_string());
        }

        println!(
            "Current position before advance: {}/{}",
            playlist.current_position(),
            playlist.total_count()
        );
        let (image_path, should_count) = playlist.advance();
        if let Some(image_path) = image_path {
            let path_str = image_path.clone();
            println!(
                "Advanced to: {} (position: {}/{}, should_count: {})",
                path_str,
                playlist.current_position(),
                playlist.total_count(),
                should_count
            );

            // 5枚先までのパスを取得（先読み用）
            let mut prefetch_paths = Vec::new();
            for i in 1..=5 {
                if let Some(path) = playlist.peek_next_n(i) {
                    prefetch_paths.push(path.clone());
                }
            }

            drop(playlist_lock);

            // 5枚先まで先読みキャッシュ（バックグラウンドで直列処理）
            let cache_dir = state.cache_dir.clone();
            prefetch_and_cache_multiple(prefetch_paths, cache_dir);

            // 表示回数を増やす（新しい画像の場合のみ）
            if should_count {
                let db = state.db.lock().unwrap();
                let _ = db.increment_display_count(&path_str);
                drop(db);
            }

            // プレイリスト状態を保存
            let playlist_lock = state.playlist.lock().unwrap();
            if let Some(ref playlist) = *playlist_lock {
                let state_data = playlist.get_state();
                let db = state.db.lock().unwrap();
                let _ = db.save_playlist_state(
                    state_data.current_index as i32,
                    &serde_json::to_string(&state_data.shuffled_list).unwrap(),
                    false,
                );
                drop(db);
            }
            drop(playlist_lock);

            // 画像情報を取得
            get_image_info_internal(&path_str, &state)
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
    let mut playlist_lock = state.playlist.lock().unwrap();

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

            // プレイリスト状態を保存
            let state_data = playlist.get_state();
            drop(playlist_lock);

            let db = state.db.lock().unwrap();
            let _ = db.save_playlist_state(
                state_data.current_index as i32,
                &serde_json::to_string(&state_data.shuffled_list).unwrap(),
                false,
            );
            drop(db);

            // 画像情報を取得（カウントは増やさない）
            get_image_info_internal(&path_str, &state)
        } else {
            Ok(None)
        }
    } else {
        Err("Playlist not initialized".to_string())
    }
}

/// 画像情報を取得（内部ヘルパー関数）
fn get_image_info_internal(
    image_path: &str,
    state: &State<AppState>,
) -> Result<Option<ImageInfo>, String> {
    let path = Path::new(image_path);

    if !path.exists() {
        return Ok(None);
    }

    // 動画ファイルかどうかを判定
    let is_video = is_video_file(path);

    // ファイルサイズ
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // 画像サイズ（動画の場合は0x0）
    let (width, height) = if !is_video {
        get_image_dimensions(path).unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    // 4K最適化：画像が4K(3840x2160)を超える場合はリサイズしてキャッシュ（動画は除く）
    let optimized_path = if !is_video && (width > 3840 || height > 2160) {
        // キャッシュファイル名を生成（元のファイル名のハッシュを使用）
        let hash = format!("{:x}", md5::compute(image_path));
        let cache_file = state.cache_dir.join(format!("{}.jpg", hash));

        // キャッシュが存在する場合は使用
        if cache_file.exists() {
            println!("Using cached optimized image: {:?}", cache_file);
            Some(cache_file.to_string_lossy().to_string())
        } else {
            // キャッシュがない場合は、バックグラウンドで作成して元画像を返す
            println!(
                "Cache not found, scheduling optimization for: {}",
                image_path
            );
            let cache_file_clone = cache_file.clone();
            let path_clone = path.to_path_buf();

            std::thread::spawn(move || match optimize_image_for_4k(&path_clone) {
                Ok(optimized_data) => {
                    if let Err(e) = fs::write(&cache_file_clone, optimized_data) {
                        eprintln!("Failed to write optimized image: {}", e);
                    } else {
                        println!(
                            "Created optimized image in background: {:?}",
                            cache_file_clone
                        );
                    }
                }
                Err(e) => {
                    eprintln!("Failed to optimize image: {}", e);
                }
            });

            // 元画像を返す（すぐに表示）
            None
        }
    } else {
        None
    };

    // EXIF情報（画像のみ）
    let exif = if !is_video {
        match get_exif_info(path) {
            Ok(info) => {
                if let Some(ref dt) = info.date_time {
                    println!("EXIF info loaded for {} - DateTime: {}", image_path, dt);
                } else {
                    println!("EXIF info loaded for {} - No DateTime field", image_path);
                }
                Some(info)
            }
            Err(e) => {
                println!("Failed to get EXIF info for {}: {}", image_path, e);
                None
            }
        }
    } else {
        None
    };

    // データベースから統計情報を取得
    let db = state.db.lock().unwrap();
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

/// 複数の画像を先読みしてキャッシュ作成（バックグラウンドで直列処理）
fn prefetch_and_cache_multiple(image_paths: Vec<String>, cache_dir: PathBuf) {
    use std::thread;

    thread::spawn(move || {
        for image_path in image_paths {
            let path = Path::new(&image_path);

            if !path.exists() {
                continue;
            }

            // 画像サイズを取得
            let (width, height) = match get_image_dimensions(path) {
                Ok(dims) => dims,
                Err(_) => continue,
            };

            // 4Kを超える場合のみキャッシュ作成
            if width > 3840 || height > 2160 {
                let hash = format!("{:x}", md5::compute(&image_path));
                let cache_file = cache_dir.join(format!("{}.jpg", hash));

                // キャッシュが既に存在する場合はスキップ
                if !cache_file.exists() {
                    match optimize_image_for_4k(path) {
                        Ok(optimized_data) => {
                            if let Err(e) = fs::write(&cache_file, optimized_data) {
                                eprintln!("Failed to write prefetched cache: {}", e);
                            } else {
                                println!("Prefetched and cached: {:?}", cache_file);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to optimize for prefetch: {}", e);
                        }
                    }
                }
            }
        }
    });
}
