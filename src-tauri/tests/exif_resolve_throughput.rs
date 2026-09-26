//! #61 S-b 計測用ベンチマーク。撮影日除外ルールが1件以上ある状態でスキャンすると、
//! `exif_cache` に未取得（または mtime 不一致で古い）画像だけを対象に、
//! `commands::scan::resolve_captured_dates` が rayon で並列に EXIF `DateTimeOriginal` を
//! 読み直す。この処理単体（DB/Tauri を挟まない）の所要時間を実測し、
//! docs（architecture.md / user-guide.md）に載せる実測値の根拠にする。
//!
//! 通常の `cargo test` では実行しない（`#[ignore]`）。計測は:
//!
//! ```sh
//! cargo test --release -- --ignored --nocapture exif_resolve_throughput
//! ```
//!
//! で行う（このリポジトリでは `src-tauri/target` が元クローンへの symlink で共有されて
//! おり、既存のビルド成果物を再利用できるため release ビルドを選んだ。debug で測る場合は
//! その旨を明記すること）。tempdir はテスト終了時（パニック時含む）に必ず削除する。

use std::path::{Path, PathBuf};
use std::time::Instant;

use sss_lib::commands::scan::resolve_captured_dates;
use sss_lib::database::ExifCacheRow;
use sss_lib::ignore::IgnoreFilter;
use sss_lib::scanner::FileMetadata;

/// 件数。実運用（数万〜10万件規模）を模すには小さいが、CI/開発機のディスクと
/// 実行時間を抑えるため実測用の規模に留める（docs にはこの規模での実測値である旨も書く）。
const FIXTURE_COUNT: usize = 1000;

/// テスト終了時（パニック時含む）にディレクトリを削除する RAII ガード。
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `tests/date_and_exclusion_rescan_e2e.rs` と同じ手法（TIFF/APP1セグメントを直接組み立てる）
/// で `DateTimeOriginal` を埋め込んだ最小JPEGを作る。EXIFライブラリに依存せず、
/// kamadak-exif が実際にパースする形のバイト列を用意する。
fn build_exif_datetime_original_tiff(date_time: &str) -> Vec<u8> {
    assert_eq!(
        date_time.len(),
        19,
        "expected 'YYYY:MM:DD HH:MM:SS' (19 chars)"
    );
    let mut ascii = date_time.as_bytes().to_vec();
    ascii.push(0); // NUL終端 → 20バイト
    let str_len = ascii.len() as u32;

    let exif_ifd_offset: u32 = 26; // ヘッダ(8) + IFD0(2+12+4=18)
    let string_offset: u32 = 44; // exif_ifd_offset(26) + ExifサブIFD(2+12+4=18)

    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0オフセット

    // IFD0: ExifIFDPointerの1件のみ
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x8769u16.to_le_bytes()); // タグ: Exif IFD Pointer
    tiff.extend_from_slice(&4u16.to_le_bytes()); // 型: LONG
    tiff.extend_from_slice(&1u32.to_le_bytes()); // 個数
    tiff.extend_from_slice(&exif_ifd_offset.to_le_bytes()); // 値: Exif サブIFDへのオフセット
    tiff.extend_from_slice(&0u32.to_le_bytes()); // 次のIFDオフセット（無し）
    debug_assert_eq!(tiff.len() as u32, exif_ifd_offset);

    // Exif サブIFD: DateTimeOriginal の1件のみ
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x9003u16.to_le_bytes()); // タグ: DateTimeOriginal
    tiff.extend_from_slice(&2u16.to_le_bytes()); // 型: ASCII
    tiff.extend_from_slice(&str_len.to_le_bytes()); // 個数（NUL込み）
    tiff.extend_from_slice(&string_offset.to_le_bytes()); // 値: 文字列データへのオフセット
    tiff.extend_from_slice(&0u32.to_le_bytes()); // 次のIFDオフセット（無し）
    debug_assert_eq!(tiff.len() as u32, string_offset);

    tiff.extend_from_slice(&ascii);
    tiff
}

fn build_exif_app1_segment(date_time: &str) -> Vec<u8> {
    let tiff = build_exif_datetime_original_tiff(date_time);
    let mut app1 = vec![0xFFu8, 0xE1];
    let content_len = (2 + 6 + tiff.len()) as u16;
    app1.extend_from_slice(&content_len.to_be_bytes());
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&tiff);
    app1
}

fn write_jpeg_with_exif_date(path: &Path, date_time: &str) {
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(4, 4));
    let mut jpeg_bytes = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut jpeg_bytes),
        image::ImageFormat::Jpeg,
    )
    .unwrap();

    let mut out = Vec::new();
    out.extend_from_slice(&jpeg_bytes[0..2]); // SOI
    out.extend_from_slice(&build_exif_app1_segment(date_time));
    out.extend_from_slice(&jpeg_bytes[2..]);

    std::fs::write(path, out).unwrap();
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

/// S-b 計測本体: `exif_cache` が空（=全件未取得）の状態で `FIXTURE_COUNT` 件の
/// 実EXIF付きJPEGに対して `resolve_captured_dates` を実行し、所要時間・件/秒を出す。
#[test]
#[ignore]
fn exif_resolve_throughput() {
    warn_if_disk_low();

    let dir = std::env::temp_dir().join(format!(
        "sss_exif_resolve_throughput_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let _guard = TempDirGuard(dir.clone());

    let mut files = Vec::with_capacity(FIXTURE_COUNT);
    for i in 0..FIXTURE_COUNT {
        let path = dir.join(format!("IMG_{i:05}.jpg"));
        write_jpeg_with_exif_date(&path, "2023:05:15 10:30:00");
        let modified_time = std::fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        files.push(FileMetadata {
            path: path.to_string_lossy().to_string(),
            modified_time,
            file_size: std::fs::metadata(&path).unwrap().len() as i64,
        });
    }

    // exif_cache は空（全件未取得）= 初回スキャン相当の最悪ケース。
    let exif_cache_entries: Vec<ExifCacheRow> = Vec::new();
    // glob/dirルールなし。全件がEXIF読みの候補になる。
    let walk_filter = IgnoreFilter::from_rules(&[]);

    let start = Instant::now();
    let (captured_dates, freshly_read) =
        resolve_captured_dates(exif_cache_entries, &files, &walk_filter, &dir);
    let elapsed = start.elapsed();

    assert_eq!(
        captured_dates.len(),
        FIXTURE_COUNT,
        "全件のEXIF撮影日が取れているはず"
    );
    assert_eq!(
        freshly_read.len(),
        FIXTURE_COUNT,
        "全件が未取得だったので全件読み直したはず"
    );

    let secs = elapsed.as_secs_f64();
    let per_sec = FIXTURE_COUNT as f64 / secs;
    println!(
        "[S-b計測] {FIXTURE_COUNT}件 / {secs:.3}秒 / {per_sec:.1}件/秒 (resolve_captured_dates単体、exif_cache全未取得の最悪ケース)"
    );

    warn_if_disk_low();
}
