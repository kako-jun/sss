//! バックエンドの golden e2e: 実フィクスチャのフォルダ木を生成し、
//! scan → ignore 除外 → playlist 構築 → 差分検出 の一気通貫を機械検証する。
//!
//! デスクトップアプリなので Web e2e はできないが、フィクスチャ駆動なら人手なしで
//! 「どのファイルがスライドショーに乗るか」という芯を回帰から守れる。
//!
//! scan は WalkDir+rayon 並列、playlist は乱数シャッフルで**順序は非決定**なので、
//! 判定の根拠は順序ではなく **集合・件数・差分** に置く（ソートして比較）。

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use sss_lib::ignore::{IgnoreFilter, IgnoreRule};
use sss_lib::playlist::Playlist;
use sss_lib::scanner::ImageScanner;

/// テスト専用のユニークな作業ディレクトリ（並列テストでも衝突しない）。
fn workspace(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("sss_e2e_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

/// 親ディレクトリごと非空ファイルを書く（scan は拡張子のみ判定し内容は読まない）。
fn write_file(root: &Path, rel: &str, contents: &[u8]) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// 典型的なフォトフォルダのフィクスチャを敷く。
/// 含まれるべき: 画像(jpg/PNG/webp/jpeg/gif)・動画(mp4/webm)、ネストも含む。
/// 除外されるべき: 非メディア(txt/ogg)、ignore 対象(private/・screenshot_*.png)。
fn build_fixture(root: &Path) {
    // 含まれる: ルート直下の画像・動画
    write_file(root, "a.jpg", b"fixture-a");
    write_file(root, "b.PNG", b"fixture-b"); // 大文字拡張子も拾う
    write_file(root, "c.webp", b"fixture-c");
    write_file(root, "movie.mp4", b"fixture-movie"); // 動画
    write_file(root, "clip.webm", b"fixture-clip"); // 動画
                                                    // 含まれる: ネストしたフォルダ
    write_file(root, "sub/d.jpeg", b"fixture-d");
    write_file(root, "sub/e.gif", b"fixture-e");
    write_file(root, "2023-05-15/old.jpg", b"fixture-old");
    // 除外: 非メディア
    write_file(root, "notes.txt", b"not media");
    write_file(root, "song.ogg", b"audio not video"); // ogg は動画対象外
                                                      // 除外: ignore 対象
    write_file(root, "screenshot_01.png", b"screenshot"); // screenshot_*.png
    write_file(root, "private/secret.jpg", b"secret"); // **/private/**
    write_file(root, "temp.tmp", b"temp"); // 非メディア かつ *.tmp
}

/// 除外パターン（DB から来るのと同じ glob 文字列）。
fn ignore_patterns() -> Vec<String> {
    vec![
        "*.tmp".to_string(),
        "**/private/**".to_string(),
        "screenshot_*.png".to_string(),
    ]
}

/// scan 結果の絶対パスを root 相対・スラッシュ正規化した集合に変換する。
fn relative_set(root: &Path, paths: &[String]) -> BTreeSet<String> {
    paths
        .iter()
        .map(|p| {
            Path::new(p)
                .strip_prefix(root)
                .expect("scan したパスは root 配下のはず")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

/// 期待される収集集合（メディアかつ非 ignore）。
fn expected_set() -> BTreeSet<String> {
    [
        "a.jpg",
        "b.PNG",
        "c.webp",
        "movie.mp4",
        "clip.webm",
        "sub/d.jpeg",
        "sub/e.gif",
        "2023-05-15/old.jpg",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn scan_collects_exactly_media_minus_ignored() {
    let root = workspace("scan");
    build_fixture(&root);

    let scanner = ImageScanner::new(IgnoreFilter::from_patterns(&ignore_patterns()));

    // 進捗コールバックの発火を記録する（並列なので Arc/Atomic で共有）。
    let calls = Arc::new(AtomicUsize::new(0));
    let last_total = Arc::new(AtomicUsize::new(0));
    let (calls_cb, last_total_cb) = (Arc::clone(&calls), Arc::clone(&last_total));

    let files = scanner
        .scan_directory_with_progress(&root, move |_done, total| {
            calls_cb.fetch_add(1, Ordering::Relaxed);
            last_total_cb.store(total, Ordering::Relaxed);
        })
        .expect("scan は成功するはず");

    // --- golden: 収集集合がメディア∧非ignore に厳密一致 ---
    let got = relative_set(
        &root,
        &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
    );
    assert_eq!(got, expected_set(), "収集されたメディア集合が期待と不一致");

    // 件数（仕様の主張）。
    assert_eq!(files.len(), 8);

    // 動画は含まれ、非メディアは含まれない（明示）。
    assert!(got.contains("movie.mp4") && got.contains("clip.webm"));
    assert!(!got.contains("notes.txt") && !got.contains("song.ogg"));

    // ignore が効いている（private 配下と screenshot_* は1つも残らない）。
    assert!(got.iter().all(|p| !p.contains("private/")));
    assert!(got.iter().all(|p| !p.starts_with("screenshot_")));

    // メタデータが埋まっている（非空ファイルなのでサイズ>0・mtime>0）。
    assert!(files.iter().all(|f| f.file_size > 0 && f.modified_time > 0));

    // 進捗コールバックが発火し、最終 total が件数と一致する。
    assert!(
        calls.load(Ordering::Relaxed) >= 1,
        "進捗コールバックが呼ばれていない"
    );
    assert_eq!(last_total.load(Ordering::Relaxed), 8);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn playlist_preserves_membership_and_updates() {
    let root = workspace("playlist");
    build_fixture(&root);

    let scanner = ImageScanner::new(IgnoreFilter::from_patterns(&ignore_patterns()));
    let files = scanner
        .scan_directory_with_progress(&root, |_, _| {})
        .expect("scan");
    let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

    let mut playlist = Playlist::new(paths.clone());
    assert!(!playlist.is_empty());
    assert_eq!(playlist.total_count(), 8);

    // シャッフルされても集合（メンバーシップ）は保存される。
    // peek_next_n(0..len) は current_index=0 起点で全要素を覗ける（破壊しない）。
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for n in 0..playlist.total_count() {
        seen.insert(playlist.peek_next_n(n).expect("要素があるはず").clone());
    }
    let input_set: BTreeSet<String> = paths.iter().cloned().collect();
    assert_eq!(seen, input_set, "playlist がメンバーシップを保存していない");

    // 追加で件数が増える。
    playlist.update_images(
        vec![root.join("added.jpg").to_string_lossy().to_string()],
        vec![],
    );
    assert_eq!(playlist.total_count(), 9);

    // 削除で件数が減る。
    playlist.update_images(vec![], vec![paths[0].clone()]);
    assert_eq!(playlist.total_count(), 8);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn incremental_scan_detects_added_and_deleted() {
    let root = workspace("incremental");
    build_fixture(&root);

    let scanner = ImageScanner::new(IgnoreFilter::from_patterns(&ignore_patterns()));

    // 1回目: 前回スナップショットを作る。
    let first = scanner
        .scan_directory_with_progress(&root, |_, _| {})
        .expect("first scan");
    let previous: Vec<(String, i64, i64)> = first
        .iter()
        .map(|f| (f.path.clone(), f.modified_time, f.file_size))
        .collect();

    // フィクスチャを変更: 1枚追加・1枚削除。
    write_file(&root, "added.jpg", b"freshly-added");
    let removed_abs = root.join("a.jpg");
    std::fs::remove_file(&removed_abs).unwrap();

    // 2回目: 差分検出付きスキャン。
    let result = scanner
        .scan_directory_incremental_with_progress(&root, previous, |_, _| {})
        .expect("incremental scan");

    let added_abs = root.join("added.jpg").to_string_lossy().to_string();
    let removed_str = removed_abs.to_string_lossy().to_string();

    // 追加 / 削除が検出される。
    assert!(
        result.new_files.contains(&added_abs),
        "追加ファイルが new_files に無い"
    );
    assert!(
        result.deleted_files.contains(&removed_str),
        "削除ファイルが deleted_files に無い"
    );
    assert_eq!(result.new_count, result.new_files.len());
    assert_eq!(result.deleted_count, result.deleted_files.len());

    // 総数は 8 のまま（-1 +1）。変更なしのファイルは new 扱いされない。
    assert_eq!(result.total_count, 8);
    assert_eq!(
        result.new_files.len(),
        1,
        "変更なしファイルまで new に混ざっている"
    );
    assert_eq!(result.deleted_files.len(), 1);

    let _ = std::fs::remove_dir_all(&root);
}

/// database.rs の既定除外ルールと同じ文字列（#61で判定ロジックを直した対象そのもの）。
/// 実際の既定値と乖離しないよう、ここでも同じリテラルを使う。
fn default_ignore_rules() -> Vec<IgnoreRule> {
    [
        "**/.thumbnails/",
        "**/Thumbs.db",
        "**/.DS_Store",
        "**/@eaDir/",
        "**/desktop.ini",
        "**/.**/",
    ]
    .into_iter()
    .map(IgnoreRule::glob)
    .collect()
}

/// #61 問題1: 既定ルール（末尾 `/` のディレクトリ指定）が、Synologyのサムネ
/// フォルダ（`@eaDir`）・`.thumbnails`・任意のドットフォルダ配下のファイルを
/// スキャン結果から実際に除外することを golden e2e レベルで確認する。
#[test]
fn scan_excludes_default_dotfolder_and_synology_thumbs_rules() {
    let root = workspace("default_rules");

    write_file(&root, "keep/normal.jpg", b"normal");
    write_file(&root, "@eaDir/thumb.jpg", b"synology-thumb");
    write_file(
        &root,
        "sub/@eaDir/nested/thumb.jpg",
        b"synology-thumb-nested",
    );
    write_file(&root, ".thumbnails/x.jpg", b"thumbnail");
    write_file(&root, ".git/config.jpg", b"dotfolder-catch-all");
    write_file(&root, "Thumbs.db", b"windows-thumb-cache"); // 拡張子非対応なのでそもそも非メディア

    let scanner = ImageScanner::new(IgnoreFilter::from_rules(&default_ignore_rules()));
    let files = scanner
        .scan_directory_with_progress(&root, |_, _| {})
        .expect("scan");
    let got = relative_set(
        &root,
        &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
    );

    assert_eq!(
        got,
        BTreeSet::from(["keep/normal.jpg".to_string()]),
        "@eaDir・.thumbnails・ドットフォルダ配下はすべて除外され、通常ファイルだけが残るはず"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// #61 問題4: globのメタ文字（`[`,`]`）を含むファイル名・フォルダ名も、
/// `globset::escape` した文字列をパターンとして登録すれば自分自身を正しく除外できる
/// （エスケープ無しでは自己マッチせず、黙って除外できないバグがあった）。
#[test]
fn scan_excludes_metachar_named_file_via_escaped_pattern() {
    let root = workspace("metachar");

    write_file(&root, "dir [2020]/photo[1].jpg", b"metachar-file");
    write_file(&root, "dir [2020]/other.jpg", b"kept-sibling");
    write_file(&root, "normal.jpg", b"kept-normal");

    let excluded_path = root.join("dir [2020]/photo[1].jpg");
    let rule = IgnoreRule::glob(globset::escape(&excluded_path.to_string_lossy()));

    let scanner = ImageScanner::new(IgnoreFilter::from_rules(&[rule]));
    let files = scanner
        .scan_directory_with_progress(&root, |_, _| {})
        .expect("scan");
    let got = relative_set(
        &root,
        &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
    );

    assert_eq!(
        got,
        BTreeSet::from(["dir [2020]/other.jpg".to_string(), "normal.jpg".to_string()]),
        "メタ文字ファイルだけが除外され、同名メタ文字フォルダの他ファイルは残るはず"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// #61 問題2/3: 撮影日除外は、ファイル名に日付が含まれない画像（例: `IMG_0001.jpg`）でも、
/// DBに保存済みの撮影日（`file_metadata.captured_date`、表示時にEXIFから取得・保存された
/// もの）があれば正しく除外できることを golden e2e レベルで確認する。
#[test]
fn scan_excludes_by_captured_date_even_without_date_in_filename() {
    let root = workspace("date_exclude");

    write_file(&root, "IMG_0001.jpg", b"excluded-by-captured-date");
    write_file(&root, "IMG_0002.jpg", b"kept-different-date");
    write_file(&root, "IMG_0003.jpg", b"kept-never-viewed-yet");

    // IMG_0001/0002 は過去に一度表示され、EXIF撮影日がDBに保存済みという想定
    // （get_image_info 経由の遅延取得。IMG_0003 は未表示＝captured_date 未取得のまま）。
    let mut captured_dates = HashMap::new();
    captured_dates.insert(
        root.join("IMG_0001.jpg").to_string_lossy().to_string(),
        "2023-05-15".to_string(),
    );
    captured_dates.insert(
        root.join("IMG_0002.jpg").to_string_lossy().to_string(),
        "2023-05-16".to_string(),
    );

    let rules = vec![IgnoreRule::date("2023-05-15")];
    let filter = IgnoreFilter::from_rules_with_captured_dates(&rules, captured_dates);

    let scanner = ImageScanner::new(filter);
    let files = scanner
        .scan_directory_with_progress(&root, |_, _| {})
        .expect("scan");
    let got = relative_set(
        &root,
        &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
    );

    assert_eq!(
        got,
        BTreeSet::from(["IMG_0002.jpg".to_string(), "IMG_0003.jpg".to_string()]),
        "撮影日が一致するIMG_0001だけが除外され、ファイル名に日付が無くても正しく判定できるはず"
    );

    let _ = std::fs::remove_dir_all(&root);
}
