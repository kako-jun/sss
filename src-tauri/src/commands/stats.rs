use crate::commands::types::{AppState, Stats};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use tauri::State;

/// 統計情報を取得
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<Stats, String> {
    // #61レビュー nit: 総数はプレイリスト（除外ルール適用後の「含める集合」）の件数に
    // 揃える。以前は `file_metadata` の全件数（`get_total_image_count`）を使っており、
    // 除外ルールで対象外になったファイルまで数に含まれ、ExcludeRulesSection での
    // 除外操作の結果とGraphSectionの表示が食い違っていた。未スキャン時は0。
    let (total_images, member_paths) = {
        let playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        match playlist_lock.as_ref() {
            Some(playlist) => (playlist.total_count() as i32, playlist.current_paths()),
            None => (0, std::collections::HashSet::new()),
        }
    };

    // #63 PR#77レビュー2巡目 nit: displayed_imagesは「現在のディレクトリ配下」だけでなく
    // 「現在のプレイリスト（除外ルール適用後の含める集合）のメンバー」だけを数える。
    // ディレクトリ配下限定だけ（前回のS2修正）だと、表示した後に除外ルールが付いた
    // ファイル（`image_stats`には`display_count > 0`が残るが、プレイリストのメンバー
    // ではなくなっている）がまだ数に含まれてしまい、`displayed_images`が
    // `total_images`（プレイリストの総数）を超えてしまう矛盾したケースがあった。
    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let displayed_images = match &directory {
        Some(dir) => {
            let counts = db
                .get_all_display_counts_under(&dir.to_string_lossy())
                .map_err(|e| format!("Database error: {e}"))?;
            counts
                .iter()
                .filter(|(path, count)| *count > 0 && member_paths.contains(path))
                .count() as i32
        }
        None => 0,
    };

    Ok(Stats {
        total_images,
        displayed_images,
    })
}

/// 現在のプレイリスト状態を取得 (position, total, canGoBack)
#[tauri::command]
pub async fn get_playlist_info(
    state: State<'_, AppState>,
) -> Result<Option<(usize, usize, bool)>, String> {
    let playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(ref playlist) = *playlist_lock {
        Ok(Some((
            playlist.current_position(),
            playlist.total_count(),
            playlist.can_go_back(),
        )))
    } else {
        Ok(None)
    }
}

/// 表示回数ヒストグラムの1階級（`count` 回表示されたファイルが `files` 件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayCountBin {
    pub count: i32,
    pub files: u32,
}

/// 表示回数の分布（統計グラフ用、#67）。
///
/// 以前は全ファイルの `(パス, 表示回数)` を IPC で丸ごと返していた（10万件規模で
/// 統計タブを開くたびに数MB転送）が、フロントが使うのは回数だけだったため、
/// バックエンドで集計した要約とヒストグラムだけを返す。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayStats {
    /// 集計対象のファイル数（プレイリストのメンバー数）
    pub files: u32,
    /// 最小/最大の表示回数（`files == 0` のときは 0）
    pub min: i32,
    pub max: i32,
    /// 表示回数の平均（`files == 0` のときは 0）
    pub mean: f64,
    /// 表示回数の昇順。ファイルが1件も無い階級は含めない（疎な表現）
    pub bins: Vec<DisplayCountBin>,
}

/// 表示回数の列から要約とヒストグラムを作る純関数。
pub fn build_display_stats<I: IntoIterator<Item = i32>>(counts: I) -> DisplayStats {
    let mut histogram: BTreeMap<i32, u32> = BTreeMap::new();
    let mut files: u32 = 0;
    let mut sum: i64 = 0;
    for count in counts {
        *histogram.entry(count).or_insert(0) += 1;
        files += 1;
        sum += i64::from(count);
    }
    let min = histogram.keys().next().copied().unwrap_or(0);
    let max = histogram.keys().next_back().copied().unwrap_or(0);
    let mean = if files == 0 {
        0.0
    } else {
        sum as f64 / f64::from(files)
    };
    DisplayStats {
        files,
        min,
        max,
        mean,
        bins: histogram
            .into_iter()
            .map(|(count, files)| DisplayCountBin { count, files })
            .collect(),
    }
}

/// 統計データを取得（グラフ用）
///
/// 母集団は `get_stats` と同じ「現在のプレイリスト（除外ルール適用後の含める集合）の
/// メンバー」。`image_stats` には一度も表示していないファイルの行が無いため、
/// メンバーのうち行が無いものは表示回数 0 として数える（以前の実装は行のある
/// ファイルだけを返していたため、未表示のファイルが分布に現れなかった、#67）。
/// 未スキャン時（プレイリスト無し）は空の分布。
#[tauri::command]
pub async fn get_display_stats(state: State<'_, AppState>) -> Result<DisplayStats, String> {
    let members: Vec<String> = {
        let playlist_lock = state.playlist.lock().unwrap_or_else(|e| e.into_inner());
        match playlist_lock.as_ref() {
            Some(playlist) => playlist.shuffled_list().to_vec(),
            None => Vec::new(),
        }
    };
    let directory = state
        .directory_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let counts_by_path: HashMap<String, i32> = match &directory {
        Some(dir) => {
            let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db.get_all_display_counts_under(&dir.to_string_lossy())
                .map_err(|e| format!("Failed to get display stats: {e}"))?
                .into_iter()
                .collect()
        }
        None => HashMap::new(),
    };
    Ok(build_display_stats(members.iter().map(|path| {
        counts_by_path.get(path).copied().unwrap_or(0)
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bin(count: i32, files: u32) -> DisplayCountBin {
        DisplayCountBin { count, files }
    }

    #[test]
    fn build_display_stats_of_nothing_is_all_zero() {
        let stats = build_display_stats(std::iter::empty());
        assert_eq!(
            stats,
            DisplayStats {
                files: 0,
                min: 0,
                max: 0,
                mean: 0.0,
                bins: vec![],
            }
        );
    }

    #[test]
    fn build_display_stats_groups_counts_into_a_sorted_sparse_histogram() {
        let stats = build_display_stats([3, 1, 1, 0, 3, 3, 7]);
        assert_eq!(stats.files, 7);
        assert_eq!(stats.min, 0);
        assert_eq!(stats.max, 7);
        assert!((stats.mean - 18.0 / 7.0).abs() < 1e-9);
        assert_eq!(
            stats.bins,
            vec![bin(0, 1), bin(1, 2), bin(3, 3), bin(7, 1)],
            "昇順・ファイルが無い階級(2,4..6)は含めない"
        );
    }

    #[test]
    fn build_display_stats_perfectly_even_has_one_bin() {
        let stats = build_display_stats(std::iter::repeat_n(2, 100_000));
        assert_eq!(stats.files, 100_000);
        assert_eq!((stats.min, stats.max), (2, 2));
        assert_eq!(stats.mean, 2.0);
        assert_eq!(stats.bins, vec![bin(2, 100_000)]);
    }
}
