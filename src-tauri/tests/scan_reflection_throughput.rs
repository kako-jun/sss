//! #63 (6) / PR#77レビューM4(must) 計測用ベンチマーク。「ファイル実体10万件規模での
//! WalkDir〜DB反映の所要時間」を実測し、docs（architecture.md 等）に載せる実測値の
//! 根拠にする。
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
//! で行う。tempdir はテスト終了時（パニック時含む）に必ず削除する。ディスク空きが
//! 閾値（1.5GB）を切ったらフィクスチャ作成を中断してpanicする（`abort_if_disk_low`）。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use sss_lib::commands::scan::perform_scan;
use sss_lib::database::Database;
use sss_lib::playlist::Playlist;

/// #63の狙い（10万枚規模での差分スキャン）そのままの規模で計測する
/// （PR#77レビューM4: 以前は1万件に縮小していたが、10万件の通しで計測すること）。
const FIXTURE_COUNT: usize = 100_000;

/// ディスク空き容量チェックの間隔（フィクスチャ作成件数ベース）。
const DISK_CHECK_INTERVAL: usize = 20_000;

/// ディスク空きの下限閾値（GB）。これを切ったら測定を中止する。
const MIN_FREE_DISK_GB: f64 = 1.5;

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `df -k /` の空き容量（GB）を返す（macOSの `df` 前提）。取得に失敗したら
/// `None`（判定不能。呼び出し元は続行してよい）。
fn free_disk_gb() -> Option<f64> {
    let output = std::process::Command::new("df")
        .arg("-k")
        .arg("/")
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.lines().nth(1)?;
    let avail_kb: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_kb as f64 / 1024.0 / 1024.0)
}

/// #63(6)/PR#77レビューM4: ディスク空きが `MIN_FREE_DISK_GB` を切っていたら
/// 即座にpanicして測定を中止する（警告するだけで続行はしない）。
fn abort_if_disk_low(context: &str) {
    if let Some(avail_gb) = free_disk_gb() {
        assert!(
            avail_gb >= MIN_FREE_DISK_GB,
            "ディスク空きが{avail_gb:.2}GBまで低下しました（閾値{MIN_FREE_DISK_GB}GB、{context}）。測定を中止します。"
        );
    }
}

#[test]
#[ignore]
fn scan_reflection_throughput() {
    abort_if_disk_low("開始前");

    let dir = std::env::temp_dir().join(format!(
        "sss_scan_reflection_throughput_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = TempDirGuard(dir.clone());

    for i in 0..FIXTURE_COUNT {
        if i.is_multiple_of(DISK_CHECK_INTERVAL) {
            abort_if_disk_low(&format!("フィクスチャ作成中 {i}/{FIXTURE_COUNT}件"));
        }
        // サイズ・内容は問わない（scanner は拡張子のみでメディア判定し中身は読まない）。
        std::fs::write(dir.join(format!("IMG_{i:06}.jpg")), b"x").unwrap();
    }
    abort_if_disk_low("フィクスチャ作成完了後");

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

    abort_if_disk_low("終了時");
}
