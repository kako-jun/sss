//! #61 レビュー M2 の回帰テスト。スキャンコマンドの本体である `perform_scan`
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
//! 3. Stage 1（除外ルール読み込み）〜Stage 4（プレイリスト反映）の間に除外ルールが
//!    追加された場合でも、Stage 4直前の再読み込みにより完了時点のプレイリストに
//!    正しく反映されること（#61レビュー S-1）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

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

    let db_mutex = Mutex::new(db);
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_, _| {},
    )
    .expect("perform_scan は成功するはず");

    let playlist_slot = playlist_mutex.into_inner().unwrap();
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

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let b_path = photos_dir.join("b.jpg").to_string_lossy().to_string();
    let a_path = photos_dir.join("a.jpg").to_string_lossy().to_string();

    // 1回目のスキャン: 除外ルールは無いので両方プレイリストに含まれる
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_, _| {},
    )
    .expect("1回目のscanは成功するはず");
    assert!(
        playlist_mutex
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .current_paths()
            .contains(&b_path),
        "1回目のスキャンではb.jpgはプレイリストに含まれるはず"
    );

    // b.jpg を除外するルールを追加（表示履歴があった体で display_count を仕込む）
    {
        let db = db_mutex.lock().unwrap();
        db.increment_display_count(&b_path).unwrap();
        db.add_ignore_rule(&globset::escape(&b_path), RuleType::Glob)
            .unwrap();
    }

    // 2回目のスキャン（同じディレクトリ）: b.jpgはプレイリストから外れるが、
    // file_metadata/image_statsは残る
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        Some(photos_dir.as_path()),
        &photos_dir,
        |_, _| {},
    )
    .expect("2回目のscanは成功するはず");

    assert!(
        !playlist_mutex
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .current_paths()
            .contains(&b_path),
        "除外ルール追加後、b.jpgはプレイリストから外れるはず"
    );
    {
        let db = db_mutex.lock().unwrap();
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
    }

    // 3回目のスキャン（変化なし）: それでも除外され続ける（再度紛れ込まない）
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        Some(photos_dir.as_path()),
        &photos_dir,
        |_, _| {},
    )
    .expect("3回目のscanは成功するはず");

    let playlist_lock = playlist_mutex.lock().unwrap();
    let paths = playlist_lock.as_ref().unwrap().current_paths();
    assert!(
        !paths.contains(&b_path),
        "3回目のスキャンでもb.jpgは除外されたままのはず"
    );
    assert!(
        paths.contains(&a_path),
        "除外対象でないa.jpgは引き続きプレイリストに残るはず"
    );
    drop(playlist_lock);

    let _ = std::fs::remove_dir_all(&dir);
}

/// #61 レビュー S-1 回帰: Stage 1（前回スナップショット・除外ルール読み込み）と
/// Stage 4（プレイリスト反映）の間には生スキャン（`WalkDir`）と並列EXIF読みが挟まり、
/// 10万件規模だと数秒〜数十秒かかる。この間にユーザーがオーバーレイの「除外」操作等で
/// 新しい除外ルールを追加した場合、Stage 1で読んだ古いルールのまま「含める集合」を
/// 作ってしまうと、スキャン中に除外したはずの画像がスキャン完了時点のプレイリストに
/// 再び現れてしまう。`perform_scan` はStage 4直前でルールを読み直すため、この退行は
/// 起きないはず。
///
/// `perform_scan` はStage 1完了後・Stage 4より前というタイミングを外から直接指定
/// できないため、Stage 2内部で複数回呼ばれる`progress_callback`（生スキャン開始直後の
/// `progress_callback(0, total)`を含む）をテスト用フックとして使い、その最初の呼び出し
/// 時点でDBにルールを追加する（Stage 1のDBロックは解放済みなのでデッドロックしない）。
#[test]
fn rule_added_between_stage1_and_stage4_is_still_excluded_at_scan_completion() {
    let dir = workspace("mid_scan_rule_add");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    write_plain_jpeg(&photos_dir.join("a.jpg"));
    write_plain_jpeg(&photos_dir.join("b.jpg"));

    let db_mutex = Mutex::new(Database::new(dir.join("sss.db")).expect("db init"));
    let playlist_mutex: Mutex<Option<Playlist>> = Mutex::new(None);
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let a_path = photos_dir.join("a.jpg").to_string_lossy().to_string();
    let b_path = photos_dir.join("b.jpg").to_string_lossy().to_string();

    let added_mid_scan = AtomicBool::new(false);
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_current, _total| {
            // Stage 1完了後（DBロック解放後）に呼ばれる生スキャンの進捗コールバック内で、
            // 一度だけb.jpgを除外するルールを追加する。Stage 1が読んだルール一覧には
            // 含まれていない状態を意図的に作る。
            if !added_mid_scan.swap(true, Ordering::SeqCst) {
                let db = db_mutex.lock().unwrap();
                db.add_ignore_rule(&globset::escape(&b_path), RuleType::Glob)
                    .expect("スキャン中の除外ルール追加は成功するはず");
            }
        },
    )
    .expect("perform_scanは成功するはず");

    assert!(
        added_mid_scan.load(Ordering::SeqCst),
        "テスト前提: progress_callbackが最低1回は呼ばれ、ルールが追加されたはず"
    );

    let playlist_slot = playlist_mutex.into_inner().unwrap();
    let playlist = playlist_slot.expect("プレイリストが初期化されているはず");
    let paths = playlist.current_paths();

    assert!(
        !paths.contains(&b_path),
        "スキャン中（Stage1〜4の間）に追加した除外ルールも、Stage4直前の再読み込みで\
         反映され、完了時点のプレイリストから除外されるはず"
    );
    assert!(
        paths.contains(&a_path),
        "除外対象でないa.jpgは引き続きプレイリストに残るはず"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #62レビュー2巡目 N-S3(must) 回帰: スキャン中に `exclude_image`（ファイル即時除外。
/// DB書込→playlist更新の順）相当の操作が実スレッドで並行して割り込んでも、
/// スキャン完了時点のプレイリストにその画像が再び現れない。
///
/// 上の`rule_added_between_stage1_and_stage4_...`は「ルールをDBに足すだけ」で
/// `progress_callback`（Stage 2の間だけ発火）のタイミングに乗せて再現できたが、
/// 本来の競合は「Stage 4のルール再読み込み」〜「Stage 5のplaylistロック取得」という
/// コード上のごく狭い区間で起きていた。この修正でルール再読み込みをplaylistロック
/// 取得の**後**（同じ临界区間内）に移したため、その区間自体が無くなり
/// `progress_callback`だけでは再現できなくなった。そこで実スレッドで
/// `exclude_image`の2段階（DB書込→playlist更新）を並行実行し、スキャン側の
/// `progress_callback`にわずかな譲歩（`thread::yield_now`）を挟んで競合ウィンドウを
/// 広げたうえで、複数回試行しても最終状態が除外後のファイルを含まないことを確認する
/// （Mutexの総順序に基づく構造的な修正の妥当性を補強する回帰テスト）。
#[test]
fn exclude_racing_with_concurrent_rescan_is_never_resurrected() {
    let dir = workspace("concurrent_exclude");
    let photos_dir = dir.join("photos");
    std::fs::create_dir_all(&photos_dir).unwrap();

    write_plain_jpeg(&photos_dir.join("a.jpg"));
    write_plain_jpeg(&photos_dir.join("b.jpg"));

    let db_mutex = Arc::new(Mutex::new(
        Database::new(dir.join("sss.db")).expect("db init"),
    ));
    let playlist_mutex: Arc<Mutex<Option<Playlist>>> = Arc::new(Mutex::new(None));
    let directory_path_mutex: Mutex<Option<PathBuf>> = Mutex::new(None);
    let b_path = photos_dir.join("b.jpg").to_string_lossy().to_string();
    let b_escaped = globset::escape(&b_path);

    // 初回スキャンでプレイリストを作る(b.jpgも含む)。
    perform_scan(
        &db_mutex,
        &playlist_mutex,
        &directory_path_mutex,
        None,
        &photos_dir,
        |_, _| {},
    )
    .expect("初回scanは成功するはず");
    assert!(playlist_mutex
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .current_paths()
        .contains(&b_path));

    for trial in 0..20 {
        let db_mutex_bg = Arc::clone(&db_mutex);
        let playlist_mutex_bg = Arc::clone(&playlist_mutex);
        let b_path_bg = b_path.clone();
        let b_escaped_bg = b_escaped.clone();

        // `exclude_image`相当: DB書込→playlist更新の順で、スキャンと並行に実行する。
        let exclude_thread = thread::spawn(move || {
            let db = db_mutex_bg.lock().unwrap();
            db.add_ignore_rule(&b_escaped_bg, RuleType::Glob).unwrap();
            drop(db);
            thread::yield_now();
            let mut playlist_lock = playlist_mutex_bg.lock().unwrap();
            if let Some(ref mut playlist) = *playlist_lock {
                playlist.update_images(vec![], vec![b_path_bg]);
            }
        });

        perform_scan(
            &db_mutex,
            &playlist_mutex,
            &directory_path_mutex,
            Some(photos_dir.as_path()),
            &photos_dir,
            |_current, _total| {
                // スキャン側にわずかな譲歩を挟み、並行exclude側と競合しやすくする。
                thread::yield_now();
            },
        )
        .unwrap_or_else(|e| panic!("trial {trial}: 再scanは成功するはず: {e}"));

        exclude_thread.join().unwrap();

        {
            let playlist_lock = playlist_mutex.lock().unwrap();
            let paths = playlist_lock.as_ref().unwrap().current_paths();
            assert!(
                !paths.contains(&b_path),
                "trial {trial}: スキャンと並行したexcludeの後、b.jpgが\
                 プレイリストに復活してはいけない"
            );
        }

        // 次trialのために状態を元に戻す(除外ルールを消し、b.jpgをプレイリストへ復帰)。
        db_mutex
            .lock()
            .unwrap()
            .remove_ignore_rule(&b_escaped, RuleType::Glob)
            .unwrap();
        playlist_mutex
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .update_images(vec![b_path.clone()], vec![]);
    }

    let _ = std::fs::remove_dir_all(&dir);
}
