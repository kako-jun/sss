//! #63 (6) 計測用ベンチマーク。「ファイル実体1万件程度でのWalkDir〜DB反映の所要時間」を
//! 実測し、docs（architecture.md 等）に載せる実測値の根拠にする。
//!
//! `perform_scan`（Tauri非依存の本体）を、実際にディスク上へ書いた `FIXTURE_COUNT` 件の
//! フィクスチャファイルに対して呼び、WalkDir・（撮影日ルールなしなのでEXIF読みは無し）・
//! Stage1〜4のDB/playlist反映まで含めた一気通貫の所要時間を測る。
//!
//! 通常の `cargo test` では実行しない（`#[ignore]`）。計測は:
//!
//! ```sh
//! cargo test --release -- --ignored --nocapture scan_reflection_throughput
//! ```
//!
//! で行う。tempdir はテスト終了時（パニック時含む）に必ず削除する。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use sss_lib::commands::scan::perform_scan;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;

/// 実運用（10万件規模）の縮小版。ディスク・実行時間を抑えつつ「1万件規模」を測る。
const FIXTURE_COUNT: usize = 10_000;

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
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

#[test]
#[ignore]
fn scan_reflection_throughput() {
    warn_if_disk_low();

    let dir = std::env::temp_dir().join(format!(
        "sss_scan_reflection_throughput_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = TempDirGuard(dir.clone());

    for i in 0..FIXTURE_COUNT {
        // サイズ・内容は問わない（scanner は拡張子のみでメディア判定し中身は読まない）。
        std::fs::write(dir.join(format!("IMG_{i:06}.jpg")), b"x").unwrap();
    }

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);

    // --- 1回目: 初回スキャン（全件が新規）。WalkDir + Stage1〜4のDB/playlist反映を含む。
    let start = Instant::now();
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &dir,
        |_, _| {},
    )
    .expect("初回scanは成功するはず");
    let first_elapsed = start.elapsed();

    assert_eq!(progress.total_files, FIXTURE_COUNT);
    assert_eq!(progress.new_files, FIXTURE_COUNT);
    assert_eq!(progress.error_count, 0);

    let secs = first_elapsed.as_secs_f64();
    let per_sec = FIXTURE_COUNT as f64 / secs;
    println!(
        "[#63計測] 初回scan(全件新規) {FIXTURE_COUNT}件 / {secs:.3}秒 / {per_sec:.1}件/秒 (WalkDir〜DB/playlist反映込み)"
    );

    // --- 2回目: 差分なしの再スキャン（全件「変更なし」。#63の狙い＝ここが速いこと）。
    let start = Instant::now();
    let progress = perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        Some(&dir),
        &dir,
        |_, _| {},
    )
    .expect("2回目のno-op scanは成功するはず");
    let second_elapsed = start.elapsed();

    assert_eq!(progress.new_files, 0, "2回目は新規0件のはず");
    assert_eq!(progress.deleted_files, 0);

    let secs2 = second_elapsed.as_secs_f64();
    println!(
        "[#63計測] 2回目scan(差分なし) {FIXTURE_COUNT}件 / {secs2:.3}秒 (file_metadataへの書込は0件のはず)"
    );

    warn_if_disk_low();
}
