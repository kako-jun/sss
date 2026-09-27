use crate::cache_worker::CACHE_WAIT_TIMEOUT;
use crate::commands::playlist_persistence;
use crate::commands::types::AppState;
use crate::image_processor::{
    extract_date_only, get_display_dimensions, get_exif_info, is_video_file, plan_cache_file,
    requires_synchronous_cache, ImageInfo,
};
use crate::playlist::Playlist;
use std::path::Path;
use tauri::State;

/// 実ファイルが消えている（NAS/USB切断・外部ツールでの削除等）画像に当たった場合に
/// 内部でさらに次/前へ進み直す上限回数（#62レビュー2巡目 N-S1）。
///
/// 消えたファイルは次回スキャンでプレイリストから除去される（母集団自体から
/// 外れる）ため、ここで飛ばしても「1巡で全件ちょうど1回」という完全平等の保証には
/// 影響しない。上限を設けるのは、万一ほとんどのファイルが一斉に消えている
/// （フォルダごとアンマウント等）異常事態で無限ループにならないようにするため。
/// 上限に到達した場合は従来どおり `Ok(None)` を返す。
///
/// #62レビュー3巡目 T-M1(must): この上限は「個々のファイルが飛び飛びに消えている」
/// 場合の話であり、スキャン対象ディレクトリ自体（NAS/USB）が丸ごと外れている場合は
/// 別扱いにする。ディレクトリ自体が無いなら、`advance` するたびに（ほぼ）必ず
/// ファイルが見つからず`MAX_MISSING_FILE_SKIPS`回フルに消費してしまい、鑑賞中に
/// 数秒おきに呼ばれる`get_next_image`のたびに最大20件ずつ未表示画像を無駄に
/// 消費し続ける（「1巡で全件ちょうど1回」への実害は無くても、体感的に「見ないまま
/// 巡がどんどん進む」異常な速さになる）。ループの各反復の前に
/// `directory_root_is_accessible` でルート自体の生死を確認し、無ければその時点で
/// 一切 `advance` せずに打ち切る。
const MAX_MISSING_FILE_SKIPS: usize = 20;

/// `get_image_info_internal` の結果（#62レビュー3巡目 S-b）。
///
/// 「ファイルが存在しない」（`Missing`、軽い。次のファイルへ進み直してよい）と
/// 「存在はするがキャッシュ変換が失敗/タイムアウトした」（`ProcessingFailed`、重い。
/// `request_current_and_wait` が最大 `CACHE_WAIT_TIMEOUT`（既定5秒）待つ）を区別する。
/// 両者を同じ `None` として扱いループで読み飛ばすと、同じ理由（壊れたファイル群等）で
/// 何枚も連続して同じ待ちが発生した場合に最悪 `MAX_MISSING_FILE_SKIPS ×
/// CACHE_WAIT_TIMEOUT`（20×5秒=100秒）ブロックしてしまう。`ProcessingFailed` は
/// ループで繰り返さず1回で打ち切る。
enum ImageLookup {
    Found(ImageInfo),
    Missing,
    ProcessingFailed,
}

/// `get_next_image`/`get_previous_image` の公開結果型（#65）。
///
/// 旧実装は成功(`Some(ImageInfo)`)以外を全て `Ok(None)` に潰しており、フロントは
/// それを文字列 `'No more images'` のエラー扱いにして「ようこそ SSS へ」画面へ
/// 落としていた。これだと「本当に未設定」「読込失敗」「フォルダ接続不可」
/// 「空プレイリスト」という意味的に別の状態が区別できず、たとえば1枚読込に
/// 失敗しただけで鑑賞中の全画面が「フォルダを選択」画面に切り替わってしまう
/// 不具合の原因になっていた。この enum で意味ごとに区別し、フロント
/// （`useSlideshow`/`App.tsx`）が `'No more images'` 等の文字列比較をせず
/// `kind` フィールドで分岐できるようにする（tagged enum、`#[serde(tag = "kind",
/// content = "data")]`。JSON は `{"kind":"found","data":{...ImageInfo}}` /
/// `{"kind":"emptyPlaylist"}` のような形になる）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum ImageNavigationResult {
    /// 画像が見つかった。
    Found(ImageInfo),
    /// プレイリストが空（除外ルールで全件除外・スキャン対象に画像が1枚も無い等）。
    /// ディレクトリ自体は設定済みなので「ようこそ／フォルダを選択」とは違う専用の
    /// 案内をフロントで出す。
    EmptyPlaylist,
    /// 実ファイルは存在するがキャッシュ変換の失敗/タイムアウト、または
    /// `MAX_MISSING_FILE_SKIPS` に到達するまで実在するファイルが見つからなかった。
    /// フロントは自動で次へ進んでよい（連続失敗回数に上限を設けること）。
    LoadFailed,
    /// スキャン対象ディレクトリ自体に今アクセスできない（NAS/USB切断等）。
    /// フロントは直前の画像を維持し、控えめな再接続待ち通知を出す。
    RootUnavailable,
    /// `get_previous_image` で履歴の先頭に達し、これ以上戻れない。エラーではなく
    /// 単純な境界なので、フロントは何もしない（従来の `Ok(None)` と同じ扱い）。
    NoHistory,
}

/// スキャン対象ディレクトリ自体が今アクセス可能かどうかを確認する
/// （#62レビュー3巡目 T-M1 must）。`AppState.directory_path` が未設定（テスト等）の
/// 場合はチェック対象が無いので `true`（許可）を返す。
fn directory_root_is_accessible(state: &State<AppState>) -> bool {
    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match directory {
        Some(dir) => dir.is_dir(),
        None => true,
    }
}

/// `advance()` 後の永続化（#62）。再シャッフルが起きた場合のみ `shuffled_list` を
/// 含むフル保存（1トランザクション）、それ以外は `next_index`/履歴だけの
/// 軽量な `UPDATE` にする。10万件規模のプレイリストで毎 advance 全件を書き直すと
/// 重いため、シャッフルが確定したタイミングだけフル保存する設計（docs参照）。
fn persist_playlist_after_advance(state: &State<AppState>, playlist: &Playlist, reshuffled: bool) {
    if !reshuffled {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        playlist_persistence::save_position(&db, playlist);
        return;
    }

    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(dir) = directory {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        playlist_persistence::save_full(&db, &dir.to_string_lossy(), playlist);
    } else {
        eprintln!("advance: directory_path is not set, skipping playlist persistence");
    }
}

/// 次の画像を取得（カウント+1）
///
/// `playlist`/`db` の `MutexGuard` は非 `Send` なので、`.await`（下記の
/// `get_image_info_internal` 呼び出し）をまたいで生存させられない。ブロックで
/// スコープを切り、await の前に確実にドロップさせる（#60 レビュー2巡目
/// should(2) で `get_image_info_internal` を async 化した際に必要になった）。
///
/// #62レビュー2巡目 N-S1（#65でエラー種別が`ImageNavigationResult`化される前の
/// 経緯）: 実ファイルが消えている画像に当たった場合、1件消えただけでスライド
/// ショーが止まって見えてしまう（旧実装は`Ok(None)`を即座に返し、フロントは
/// 「No more images」のエラー画面にフォールバックしていた）不具合を直すため、
/// `MAX_MISSING_FILE_SKIPS` 回を上限に内部で次へ進み直し、最初に実在する画像が
/// 見つかったものだけを返すようにした。表示回数はその実在する画像1件にだけ加算する
/// （欠損ファイルの分は加算しない、従来どおり）。上限に到達した場合の戻り値は
/// `#65`以降 `ImageNavigationResult::LoadFailed`（旧`Ok(None)`）。
///
/// #62レビュー3巡目 T-M1(must): ループの各反復の前に、対象ディレクトリ自体が
/// アクセス可能かを確認する。無ければ（advance すら行わず）即座に返す
/// （`#65`以降 `ImageNavigationResult::RootUnavailable`、旧`Ok(None)`）。個々の
/// ファイルの消失（`ImageLookup::Missing`）とは別に、ディレクトリ自体の消失は
/// 「ほぼ全件が必ず見つからない」状態を意味するため、通常のスキップループに
/// 任せると毎回上限（20件）ぶん無駄に `advance`+保存してしまう。
///
/// #62レビュー3巡目 S-b: `ImageLookup::ProcessingFailed`（キャッシュ変換の失敗/
/// タイムアウト）は `Missing` と違ってループで読み飛ばさず、その場で打ち切る
/// （詳細は `ImageLookup` のdoc参照）。
///
/// #65: 戻り値は `ImageNavigationResult`。ディレクトリ自体が無い場合は
/// `RootUnavailable`、プレイリストが空なら `EmptyPlaylist`、変換失敗/上限到達は
/// `LoadFailed` を返す（いずれも `Err` ではなく `Ok` — 呼び出し側の通常の分岐で
/// 扱える意味のある結果であり、プログラミングエラーではないため）。
#[tauri::command]
pub async fn get_next_image(state: State<'_, AppState>) -> Result<ImageNavigationResult, String> {
    // apply_exif_rotation 設定を取得（デフォルト true）。欠損ファイルのスキップで
    // 何度もadvanceし直しても、この設定自体はループの外で一度読めば十分。
    let apply_rotation = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.get_setting("apply_exif_rotation")
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    };

    for _ in 0..MAX_MISSING_FILE_SKIPS {
        // T-M1(must): ディレクトリ自体が無いなら、ここでadvanceせず打ち切る。
        if !directory_root_is_accessible(&state) {
            return Ok(ImageNavigationResult::RootUnavailable);
        }

        let (path_str, should_count, prefetch_paths) = {
            let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
            let playlist = playlist_lock
                .as_mut()
                .ok_or_else(|| "Playlist not initialized".to_string())?;

            // プレイリストが空: ディレクトリ自体は設定済みなので専用の結果を返す
            // （#65: 「未設定」と「0件」を区別するため、Errではなく通常の結果にする）。
            if playlist.is_empty() {
                return Ok(ImageNavigationResult::EmptyPlaylist);
            }

            let (image_path, should_count, reshuffled) = playlist.advance();
            let path_str = match image_path {
                Some(p) => p.clone(),
                // is_empty() チェック直後のため通常到達しない防御的分岐。
                None => return Ok(ImageNavigationResult::EmptyPlaylist),
            };

            // 5枚先までのパスを取得（先読み用。peek_next_n(0)が次に表示される画像）
            let mut prefetch_paths = Vec::new();
            for i in 0..5 {
                if let Some(path) = playlist.peek_next_n(i) {
                    prefetch_paths.push(path.clone());
                }
            }

            // 永続化(#62): 再シャッフルが起きたときだけ shuffled_list を含むフル保存、
            // それ以外は next_index/履歴だけの軽量更新にする（10万件規模で毎advance
            // 全件書き込むと重いため）。ファイルが後で存在しないと分かった場合でも、
            // プレイリストの進行自体は「消費済み」として確定させてよい（次回スキャンで
            // 除去される前提のため、#62レビュー2巡目 N-S1 コメント参照）。
            persist_playlist_after_advance(&state, playlist, reshuffled);

            (path_str, should_count, prefetch_paths)
        };

        // 画像情報を取得（内部で存在確認・現在画像のキャッシュ要求まで行う）
        match get_image_info_internal(&path_str, &state, apply_rotation).await? {
            ImageLookup::Found(info) => {
                // 表示回数の加算はファイル存在確認後（#60 問題9: 消失ファイルを無駄カウントしない）
                if should_count {
                    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = db.increment_display_count(&path_str);
                    drop(db);
                    // #65レビューS1: 「直近に実際に加算したパス」を記録する。
                    // `undo_display_count`はこれと一致した時だけ取り消す。
                    *state
                        .last_incremented_display
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(path_str.clone());
                }

                // 5枚先まで先読みキュー投入（単一ワーカーが直列処理・重複排除・世代管理する）
                enqueue_prefetch(&state, prefetch_paths, apply_rotation);

                return Ok(ImageNavigationResult::Found(info));
            }
            ImageLookup::Missing => {
                // ファイルが存在しない: カウントせず、次のループでさらに advance し直す。
            }
            ImageLookup::ProcessingFailed => {
                // S-b: キャッシュ変換の失敗/タイムアウトはループで繰り返さず打ち切る。
                return Ok(ImageNavigationResult::LoadFailed);
            }
        }
    }

    // 上限に到達（ほとんどのファイルが一斉に消えている等の異常事態）。
    Ok(ImageNavigationResult::LoadFailed)
}

/// 前の画像を取得（カウント増やさない）。
///
/// #62レビュー2巡目 N-S1: `get_next_image` と同様、実ファイルが消えている画像に
/// 当たったら `MAX_MISSING_FILE_SKIPS` 回を上限にさらに前へ戻り直す。
/// #62レビュー3巡目 T-M1/S-b: ディレクトリ自体の消失チェックと
/// `ImageLookup::ProcessingFailed` の即時打ち切りも `get_next_image` と同様に行う。
///
/// #65: 戻り値は `ImageNavigationResult`。履歴の先頭に達して戻れない場合は
/// `NoHistory`（境界であってエラーではない。従来の `Ok(None)` と同じ意味）。
#[tauri::command]
pub async fn get_previous_image(
    state: State<'_, AppState>,
) -> Result<ImageNavigationResult, String> {
    // apply_exif_rotation 設定を取得（デフォルト true）
    let apply_rotation = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db.get_setting("apply_exif_rotation")
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    };

    for _ in 0..MAX_MISSING_FILE_SKIPS {
        // T-M1(must): ディレクトリ自体が無いなら、ここでgo_backせず打ち切る。
        if !directory_root_is_accessible(&state) {
            return Ok(ImageNavigationResult::RootUnavailable);
        }

        let path_str = {
            let mut playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
            let playlist = playlist_lock
                .as_mut()
                .ok_or_else(|| "Playlist not initialized".to_string())?;

            // プレイリストが空: ディレクトリ自体は設定済みなので専用の結果を返す。
            if playlist.is_empty() {
                return Ok(ImageNavigationResult::EmptyPlaylist);
            }

            if !playlist.can_go_back() {
                return Ok(ImageNavigationResult::NoHistory);
            }

            let path = match playlist.go_back() {
                Some(p) => p.clone(),
                None => return Ok(ImageNavigationResult::NoHistory),
            };

            // 永続化(#62): go_back は next_index を変えないため常に軽量保存でよい。
            let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
            playlist_persistence::save_position(&db, playlist);

            path
        };

        // 画像情報を取得（カウントは増やさない）
        match get_image_info_internal(&path_str, &state, apply_rotation).await? {
            ImageLookup::Found(info) => return Ok(ImageNavigationResult::Found(info)),
            ImageLookup::Missing => {
                // ファイルが存在しない: 次のループでさらに go_back し直す
                // （履歴の先頭に達したら can_go_back() が false になり NoHistory で終わる）。
            }
            ImageLookup::ProcessingFailed => {
                // S-b: キャッシュ変換の失敗/タイムアウトはループで繰り返さず打ち切る。
                return Ok(ImageNavigationResult::LoadFailed);
            }
        }
    }

    Ok(ImageNavigationResult::LoadFailed)
}

/// 画像情報を取得（内部ヘルパー関数）
///
/// キャッシュが必要（4K超・WebView非対応形式・apply_rotation=false時の回転要求）
/// かつ未生成の場合、通常は単一ワーカーへ「現在画像」として優先度付きで要求を積み、
/// まだ存在しない間は原本のパスを返す（すぐに表示するため）。ただし
/// `requires_synchronous_cache` が true のケース（原本をそのまま返すと表示が誤る:
/// WebView非対応形式、または apply_rotation=false なのにEXIF回転が必要）は、
/// ワーカーの完了を待ってからキャッシュパスを返す（#60 レビュー1巡目 must2、
/// 2巡目 must B）。失敗/タイムアウト時は `ImageLookup::ProcessingFailed` を返す
/// （#62レビュー3巡目 S-b: ファイル不在の `Missing` とは区別する。呼び出し元は
/// `ProcessingFailed` をループで読み飛ばさず即座に打ち切る。自動で次へ進める
/// 仕組み自体の本格整理は #65）。
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
) -> Result<ImageLookup, String> {
    let path = Path::new(image_path);

    if !path.exists() {
        return Ok(ImageLookup::Missing);
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
                // #62レビュー3巡目 S-b: ファイル不在(Missing)とは区別し、呼び出し元の
                // スキップループでは繰り返さず即座に打ち切らせる。
                return Ok(ImageLookup::ProcessingFailed);
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

    // データベースから統計情報を取得。ついでに撮影日を exif_cache へ保存する（#61）。
    // スキャン時に全件EXIFを読むと10万件規模で重いため、表示時（ここ）に取得した
    // 撮影日を exif_cache に書き戻し、次回スキャン以降の撮影日除外ルール判定で
    // 使えるようにする「遅延取得」方式を採る（詳細は docs/architecture.md 参照）。
    // EXIFに撮影日が無い画像も captured_date=None で記録し、スキャン時の無駄な
    // 再取得（「日付なし」判定の繰り返し）を防ぐ。file_mtime はファイルが変わったら
    // 再取得が必要と判断するための基準として現在のmtimeを使う。
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let (display_count, last_displayed) = db.get_image_stats(image_path).unwrap_or((0, None));
    if !is_video {
        let date = exif
            .as_ref()
            .and_then(|e| e.date_time.as_deref())
            .and_then(extract_date_only);
        if let Ok(metadata) = std::fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    let _ = db.upsert_exif_cache(
                        image_path,
                        date.as_deref(),
                        duration.as_secs() as i64,
                    );
                }
            }
        }
    }
    drop(db);

    Ok(ImageLookup::Found(ImageInfo {
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

/// フロントの `<img>`/`<video>` が `onError` になった場合に、既に
/// `get_next_image`/`get_previous_image` が加算した表示回数を取り消す（#65）。
///
/// バックエンドはファイルの存在とキャッシュ変換の成功までしか確認できず、
/// 実際にWebViewがデコード/描画できるかまでは分からない。取り消し方式にしたのは、
/// 「表示成功後に確定加算する」方式（加算そのものを`confirm_display`のような
/// 別コマンドへ後ろ倒しする設計）に比べて、既存の`should_count`（履歴なぞり中は
/// 加算しない等）のロジックとその実装済みテストを一切変更せずに済むため
/// （変更範囲を#65のフロント問題に閉じる目的、詳細は#65報告参照）。
///
/// #65レビューS1: `path`は`AppState.last_incremented_display`（直近に実際に
/// `increment_display_count`したパス）と一致した時だけ1回減らし、一致したら
/// 直後にクリアする（同じ`onError`が万一2回届いても2回目は不一致になり無視される。
/// 意図しない多重取り消しの防止）。`get_previous_image`（表示回数を増やさない）や
/// 履歴なぞり中の`advance`（`should_count=false`）は`last_incremented_display`を
/// 更新しないため、それらの経路の`onError`が無関係な過去の加算を誤って
/// 減らすことはない。不一致（既に次の画像へ進んでいた等）の場合は何もしない。
#[tauri::command]
pub async fn undo_display_count(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let mut last = state
        .last_incremented_display
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if last.as_deref() != Some(path.as_str()) {
        return Ok(());
    }
    *last = None;
    drop(last);

    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db.decrement_display_count(&path).map_err(|e| e.to_string())
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
