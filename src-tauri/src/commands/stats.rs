use crate::commands::types::AppState;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use tauri::State;

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
/// 母集団は「現在のプレイリスト（除外ルール適用後の含める集合）のメンバー」。`image_stats` には一度も表示していないファイルの行が無いため、
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

    // ---- 独立QA観点表からの追加テスト（#67） ----

    #[test]
    fn build_display_stats_all_unshown_is_a_single_zero_bin() {
        let stats = build_display_stats(std::iter::repeat_n(0, 1234));
        assert_eq!(stats.files, 1234);
        assert_eq!((stats.min, stats.max), (0, 0));
        assert_eq!(stats.mean, 0.0);
        assert_eq!(stats.bins, vec![bin(0, 1234)]);
    }

    #[test]
    fn build_display_stats_single_file_has_min_max_mean_equal() {
        let stats = build_display_stats([5]);
        assert_eq!(stats.files, 1);
        assert_eq!((stats.min, stats.max), (5, 5));
        assert_eq!(stats.mean, 5.0);
        assert_eq!(stats.bins, vec![bin(5, 1)]);
    }

    /// 合計は i64 で持つ。i32::MAX を複数足しても溢れず、平均が正しく出る。
    #[test]
    fn build_display_stats_sum_does_not_overflow_i32() {
        let stats = build_display_stats([i32::MAX, i32::MAX, i32::MAX, 0]);
        assert_eq!(stats.files, 4);
        assert_eq!((stats.min, stats.max), (0, i32::MAX));
        let expected = 3.0 * f64::from(i32::MAX) / 4.0;
        assert!((stats.mean - expected).abs() < 1.0, "mean={}", stats.mean);
        assert_eq!(stats.bins, vec![bin(0, 1), bin(i32::MAX, 3)]);
    }
}
