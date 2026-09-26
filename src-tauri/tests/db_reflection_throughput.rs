//! #63 (6) 計測用ベンチマーク。「DB反映は10万件のパス配列を直接与える」形で、
//! `Database::apply_file_metadata_changes`（Stage3のfile_metadata反映本体。
//! 新規/変更のupsert＋確定削除を1トランザクション・prepare_cachedで行う）単体の
//! 所要時間を実測する。ディスク上に実ファイルは作らず、合成パス文字列の配列を
//! 直接渡す（このベンチの狙いはDB反映そのものの速度で、WalkDir/EXIF読みを含まない）。
//!
//! 通常の `cargo test` では実行しない（`#[ignore]`）。計測は:
//!
//! ```sh
//! cargo test --release -- --ignored --nocapture db_reflection_throughput
//! ```
//!
//! で行う。DBファイルはテスト終了時（パニック時含む）に必ず削除する。

use std::path::PathBuf;
use std::time::Instant;

use sss_lib::database::Database;

const FIXTURE_COUNT: usize = 100_000;

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `df -h /` の空き容量が閾値を下回っていないか確認する（macOSの `df` 前提。
/// 失敗時は測れないだけなので測定は続行し、標準エラーに警告を出す）。
fn warn_if_disk_low() {
    let Ok(output) = std::process::Command::new("df").arg("-k").arg("/").output() else {
        return;
    };
    let Ok(text) = String::from_utf8(output.stdout) else {
        return;
    };
    if let Some(line) = text.lines().nth(1) {
        if let Some(avail_kb) = line
            .split_whitespace()
            .nth(3)
            .and_then(|s| s.parse::<u64>().ok())
        {
            let avail_gb = avail_kb as f64 / 1024.0 / 1024.0;
            if avail_gb < 1.5 {
                eprintln!(
                    "警告: ディスク空きが {avail_gb:.2}GB しかありません（閾値1.5GB）。中止を検討してください。"
                );
            }
        }
    }
}

fn synthetic_entries(count: usize, mtime_offset: i64) -> Vec<(String, i64, i64)> {
    (0..count)
        .map(|i| {
            (
                format!("/synthetic/photos/dir{}/IMG_{i:06}.jpg", i / 1000),
                1_700_000_000 + mtime_offset,
                123_456,
            )
        })
        .collect()
}

#[test]
#[ignore]
fn db_reflection_throughput() {
    warn_if_disk_low();

    let path = std::env::temp_dir().join(format!(
        "sss_db_reflection_throughput_{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _guard = TempFileGuard(path.clone());

    let db = Database::new(path.clone()).expect("db init");

    // --- 1. 初回反映: 10万件を新規upsert（確定削除は0件）。
    let entries = synthetic_entries(FIXTURE_COUNT, 0);
    let start = Instant::now();
    db.apply_file_metadata_changes(&entries, &[])
        .expect("初回のapply_file_metadata_changesは成功するはず");
    let insert_elapsed = start.elapsed();

    assert_eq!(db.get_total_image_count().unwrap(), FIXTURE_COUNT as i32);

    let secs = insert_elapsed.as_secs_f64();
    println!(
        "[#63計測] apply_file_metadata_changes 新規{FIXTURE_COUNT}件upsert / {secs:.3}秒 / {:.1}件/秒",
        FIXTURE_COUNT as f64 / secs
    );

    // --- 2. 差分反映: 全件のmtimeを変えて「変更あり」として再upsert（実運用の最悪ケース＝
    //    ほぼ全件が新規/変更扱いになるシナリオ）。
    let changed_entries = synthetic_entries(FIXTURE_COUNT, 1);
    let start = Instant::now();
    db.apply_file_metadata_changes(&changed_entries, &[])
        .expect("差分upsertは成功するはず");
    let update_elapsed = start.elapsed();

    let secs = update_elapsed.as_secs_f64();
    println!(
        "[#63計測] apply_file_metadata_changes 全{FIXTURE_COUNT}件updateupsert / {secs:.3}秒 / {:.1}件/秒",
        FIXTURE_COUNT as f64 / secs
    );

    // --- 3. 確定削除: 半分(5万件)を同じ呼び出しで削除する（Stage3の実運用パターン）。
    let deleted_paths: Vec<String> = changed_entries
        .iter()
        .take(FIXTURE_COUNT / 2)
        .map(|(p, ..)| p.clone())
        .collect();
    let start = Instant::now();
    db.apply_file_metadata_changes(&[], &deleted_paths)
        .expect("確定削除は成功するはず");
    let delete_elapsed = start.elapsed();

    assert_eq!(
        db.get_total_image_count().unwrap(),
        (FIXTURE_COUNT - FIXTURE_COUNT / 2) as i32
    );

    let secs = delete_elapsed.as_secs_f64();
    println!(
        "[#63計測] apply_file_metadata_changes {}件確定削除 / {secs:.3}秒 / {:.1}件/秒",
        FIXTURE_COUNT / 2,
        (FIXTURE_COUNT / 2) as f64 / secs
    );

    warn_if_disk_low();
}
