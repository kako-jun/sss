//! #61 レビュー M2 の回帰テスト。`scan_directory` コマンドの本体である `perform_scan`
//! （Tauri非依存の純粋関数。`AppHandle` は runtime ジェネリクスが `Wry` 固定で
//! `tauri::test::mock_app()` の `MockRuntime` を受け付けないため、コマンドの薄い
//! シェルではなく本体を直接呼ぶ）を通して以下の2点を検証する:
//!
//! 1. 撮影日ルールが設定されている場合、**一度も表示していない**（＝ exif_cache に
//!    未取得の）画像でも、初回スキャン時に EXIF を読み直して正しく除外されること
//!    （スキャン時の rayon 並列EXIF取得パス）。
//! 2. 除外ルールで対象外になったファイルは「削除」と区別され、`file_metadata` から
//!    消えない（プレイリストからのみ外れる）こと。また複数回スキャンしても
//!    除外され続けること（一度外れたファイルが再度紛れ込まない）。

use std::path::{Path, PathBuf};

use sss_lib::commands::scan::perform_scan;
use sss_lib::database::Database;
use sss_lib::ignore::RuleType;
use sss_lib::playlist::Playlist;

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sss_date_exclusion_e2e_{tag}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// EXIF `DateTimeOriginal`（タグ 0x9003, Exif サブIFD）だけを埋め込んだ TIFF ヘッダを
/// 組み立てる（テスト専用）。リトルエンディアン固定。
/// IFD0 に ExifIFDPointer(0x8769) が1件だけあり、その先の Exif サブIFDに
/// DateTimeOriginal(0x9003, ASCII) が1件ある、という最小構成。
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

/// DateTimeOriginal を含む APP1 (Exif) セグメントを組み立てる。
fn build_exif_app1_segment(date_time: &str) -> Vec<u8> {
    let tiff = build_exif_datetime_original_tiff(date_time);
    let mut app1 = vec![0xFFu8, 0xE1];
    let content_len = (2 + 6 + tiff.len()) as u16;
    app1.extend_from_slice(&content_len.to_be_bytes());
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&tiff);
    app1
}

/// `DateTimeOriginal` を埋め込んだ最小の JPEG フィクスチャを書き出す。
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

/// EXIFを持たない（撮影日不明の）最小JPEGを書き出す。
fn write_plain_jpeg(path: &Path) {
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(4, 4));
    img.save(path).unwrap();
}

/// #61 レビュー M2 回帰: 表示履歴が無い（exif_cacheに未取得の）画像でも、撮影日ルールが
/// 1件以上あれば、初回スキャンでEXIFを読み直して正しく除外される。
#[test]
fn first_scan_excludes_never_displayed_image_by_reading_exif_directly() {
    let dir = workspace("first_scan_date");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    // IMG_0001: ファイル名に日付を含まないが、EXIF DateTimeOriginal=2023-05-15
    write_jpeg_with_exif_date(&photos_dir.join("IMG_0001.jpg"), "2023:05:15 10:30:00");
    // IMG_0002: 別の日付
    write_jpeg_with_exif_date(&photos_dir.join("IMG_0002.jpg"), "2023:05:16 10:30:00");

    let db = Database::new(dir.join("sss.db")).expect("db init");
    // 撮影日ルールを事前に追加（一度も表示していないのでexif_cacheは空のまま）
    db.add_ignore_rule("2023-05-15", RuleType::Date)
        .expect("add date rule");

    let mut playlist_slot: Option<Playlist> = None;
    perform_scan(&db, &mut playlist_slot, None, &photos_dir, |_, _| {})
        .expect("perform_scan は成功するはず");

    let playlist = playlist_slot.expect("プレイリストが初期化されているはず");
    let paths = playlist.current_paths();

    assert!(
        !paths.contains(
            &photos_dir
                .join("IMG_0001.jpg")
                .to_string_lossy()
                .to_string()
        ),
        "撮影日2023-05-15のIMG_0001は初回スキャンで除外されるはず（表示履歴が無くても）"
    );
    assert!(
        paths.contains(
            &photos_dir
                .join("IMG_0002.jpg")
                .to_string_lossy()
                .to_string()
        ),
        "撮影日が異なるIMG_0002はプレイリストに残るはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #61 レビュー M2 回帰: 既存ファイルに新しい除外ルールが付いても「削除」とは区別され、
/// `file_metadata` からは消えない（プレイリストからのみ外れる）。かつ複数回スキャンしても
/// 除外され続ける（再度紛れ込まない）。
#[test]
fn excluded_file_survives_in_file_metadata_and_stays_excluded_across_rescans() {
    let dir = workspace("exclude_rescan");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    write_plain_jpeg(&photos_dir.join("a.jpg"));
    write_plain_jpeg(&photos_dir.join("b.jpg"));

    let db = Database::new(dir.join("sss.db")).expect("db init");
    let b_path = photos_dir.join("b.jpg").to_string_lossy().to_string();
    let a_path = photos_dir.join("a.jpg").to_string_lossy().to_string();

    // 1回目のスキャン: 除外ルールは無いので両方プレイリストに含まれる
    let mut playlist_slot: Option<Playlist> = None;
    perform_scan(&db, &mut playlist_slot, None, &photos_dir, |_, _| {})
        .expect("1回目のscanは成功するはず");
    assert!(
        playlist_slot
            .as_ref()
            .unwrap()
            .current_paths()
            .contains(&b_path),
        "1回目のスキャンではb.jpgはプレイリストに含まれるはず"
    );

    // b.jpg を除外するルールを追加（表示履歴があった体で display_count を仕込む）
    db.increment_display_count(&b_path).unwrap();
    db.add_ignore_rule(&globset::escape(&b_path), RuleType::Glob)
        .unwrap();

    // 2回目のスキャン（同じディレクトリ）: b.jpgはプレイリストから外れるが、
    // file_metadata/image_statsは残る
    perform_scan(
        &db,
        &mut playlist_slot,
        Some(photos_dir.as_path()),
        &photos_dir,
        |_, _| {},
    )
    .expect("2回目のscanは成功するはず");

    assert!(
        !playlist_slot
            .as_ref()
            .unwrap()
            .current_paths()
            .contains(&b_path),
        "除外ルール追加後、b.jpgはプレイリストから外れるはず"
    );
    let files = db.get_all_file_metadata().unwrap();
    assert!(
        files.iter().any(|(p, ..)| p == &b_path),
        "除外は「削除」ではないのでfile_metadataからb.jpgが消えてはいけない"
    );
    let (display_count, _) = db.get_image_stats(&b_path).unwrap();
    assert_eq!(
        display_count, 1,
        "除外は「削除」ではないのでimage_statsの表示回数が失われてはいけない"
    );

    // 3回目のスキャン（変化なし）: それでも除外され続ける（再度紛れ込まない）
    perform_scan(
        &db,
        &mut playlist_slot,
        Some(photos_dir.as_path()),
        &photos_dir,
        |_, _| {},
    )
    .expect("3回目のscanは成功するはず");

    let paths = playlist_slot.as_ref().unwrap().current_paths();
    assert!(
        !paths.contains(&b_path),
        "3回目のスキャンでもb.jpgは除外されたままのはず"
    );
    assert!(
        paths.contains(&a_path),
        "除外対象でないa.jpgは引き続きプレイリストに残るはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
