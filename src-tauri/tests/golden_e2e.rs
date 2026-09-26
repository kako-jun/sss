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

/// #61 レビュー M2/S1: `ImageScanner` はもう除外ルールを一切適用しない（ディスク上の
/// 物理的な事実だけを集める）。除外フィルタの適用は呼び出し元（`commands/scan.rs`）が
/// 別段階として行う設計になったため、テストでもその2段階を明示的に再現する。
fn included_paths(
    files: &[sss_lib::scanner::FileMetadata],
    filter: &IgnoreFilter,
    root: &Path,
) -> Vec<String> {
    files
        .iter()
        .filter(|f| !filter.is_ignored(Path::new(&f.path), root))
        .map(|f| f.path.clone())
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

    let scanner = ImageScanner::new();
    let filter = IgnoreFilter::from_patterns(&ignore_patterns());

    // 進捗コールバックの発火を記録する（並列なので Arc/Atomic で共有）。
    let calls = Arc::new(AtomicUsize::new(0));
    let last_total = Arc::new(AtomicUsize::new(0));
    let (calls_cb, last_total_cb) = (Arc::clone(&calls), Arc::clone(&last_total));

    let (files, _errors) = scanner
        .scan_directory_with_progress(&root, &filter, move |_done, total| {
            calls_cb.fetch_add(1, Ordering::Relaxed);
            last_total_cb.store(total, Ordering::Relaxed);
        })
        .expect("scan は成功するはず");

    // #61: 生スキャンはメディア判定のみ行い、ignoreは適用しない。ここでまず
    // 「メディア∧非ignore」の判定は別段階（included_paths）で行うことを確認する。
    let included = included_paths(&files, &filter, &root);

    // --- golden: 収集集合がメディア∧非ignore に厳密一致 ---
    let got = relative_set(&root, &included);
    assert_eq!(got, expected_set(), "収集されたメディア集合が期待と不一致");

    // 件数（仕様の主張）。
    assert_eq!(included.len(), 8);

    // 動画は含まれ、非メディアは含まれない（明示）。
    assert!(got.contains("movie.mp4") && got.contains("clip.webm"));
    assert!(!got.contains("notes.txt") && !got.contains("song.ogg"));

    // ignore が効いている（private 配下と screenshot_* は1つも残らない）。
    assert!(got.iter().all(|p| !p.contains("private/")));
    assert!(got.iter().all(|p| !p.starts_with("screenshot_")));

    // メタデータが埋まっている（非空ファイルなのでサイズ>0・mtime>0）。
    assert!(files.iter().all(|f| f.file_size > 0 && f.modified_time > 0));

    // 進捗コールバックが発火する（#61: 生スキャンはignore対象も含めて収集するため、
    // 最終totalは非メディアを除いた全ファイル数になる。メディア∧非ignoreの8件より
    // 多い可能性がある点が変わったので、ここでは「呼ばれたこと」だけを確認する）。
    assert!(
        calls.load(Ordering::Relaxed) >= 1,
        "進捗コールバックが呼ばれていない"
    );
    assert!(last_total.load(Ordering::Relaxed) >= 8);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn playlist_preserves_membership_and_updates() {
    let root = workspace("playlist");
    build_fixture(&root);

    let scanner = ImageScanner::new();
    let filter = IgnoreFilter::from_patterns(&ignore_patterns());
    let (files, _errors) = scanner
        .scan_directory_with_progress(&root, &filter, |_, _| {})
        .expect("scan");
    let paths: Vec<String> = included_paths(&files, &filter, &root);

    let mut playlist = Playlist::new(paths.clone());
    assert!(!playlist.is_empty());
    assert_eq!(playlist.total_count(), 8);

    // シャッフルされても集合（メンバーシップ）は保存される。
    // peek_next_n(0..len) は next_index=0（まだ何も表示していない）起点で
    // 全要素を覗ける（破壊しない）。
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

    // #61: 生スキャンなのでignoreとは無関係（このテストはscannerの差分検出だけを見る）。
    // walk_filterは空（何も刈らない）にして、生の物理的な件数を検証できるようにする。
    let scanner = ImageScanner::new();
    let no_prune_filter = IgnoreFilter::from_patterns(&[]);

    // 1回目: 前回スナップショットを作る。
    let (first, _errors) = scanner
        .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
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
        .scan_directory_incremental_with_progress(&root, previous, &no_prune_filter, |_, _| {})
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

    // 総数は変わらない（-1 +1）。変更なしのファイルは new 扱いされない。
    // #61: 生スキャンなのでignore対象（screenshot_01.png・private/secret.jpg）も
    // 総数に含まれる（8件のメディア∧非ignore + 2件のignore対象 = 10件）。
    assert_eq!(result.total_count, 10);
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

    let scanner = ImageScanner::new();
    let filter = IgnoreFilter::from_rules(&default_ignore_rules());
    let (files, _errors) = scanner
        .scan_directory_with_progress(&root, &filter, |_, _| {})
        .expect("scan");

    // #61レビュー S-a: ディレクトリ系除外はWalkDirのfilter_entryで枝刈りされるため、
    // 生スキャンの結果自体（post-hocフィルタ前）に、既に@eaDir・.thumbnails・
    // ドットフォルダ配下のファイルが一切現れない（stat/EXIF読み対象にすらならない）。
    let raw_relative = relative_set(
        &root,
        &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
    );
    assert_eq!(
        raw_relative,
        BTreeSet::from(["keep/normal.jpg".to_string()]),
        "枝刈りにより生スキャンの時点で既に@eaDir等が一切現れないはず"
    );

    let got = relative_set(&root, &included_paths(&files, &filter, &root));
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

    let scanner = ImageScanner::new();
    let filter = IgnoreFilter::from_rules(&[rule]);
    let (files, _errors) = scanner
        .scan_directory_with_progress(&root, &filter, |_, _| {})
        .expect("scan");
    let got = relative_set(&root, &included_paths(&files, &filter, &root));

    assert_eq!(
        got,
        BTreeSet::from(["dir [2020]/other.jpg".to_string(), "normal.jpg".to_string()]),
        "メタ文字ファイルだけが除外され、同名メタ文字フォルダの他ファイルは残るはず"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// #61 問題2/3: 撮影日除外は、ファイル名に日付が含まれない画像（例: `IMG_0001.jpg`）でも、
/// DBに保存済みの撮影日（`exif_cache`、表示時にEXIFから取得・保存されたもの）があれば
/// 正しく除外できることを golden e2e レベルで確認する（`IgnoreFilter` 単体のロジック）。
/// スキャン時に実際にEXIFを読み直す経路（表示履歴が無い画像の初回スキャン除外）は
/// `tests/date_and_exclusion_rescan_e2e.rs` で `scan_directory` コマンド経由で検証する
/// （#61レビュー M2: この2つは意味が異なるため両方残す）。
#[test]
fn scan_excludes_by_captured_date_even_without_date_in_filename() {
    let root = workspace("date_exclude");

    write_file(&root, "IMG_0001.jpg", b"excluded-by-captured-date");
    write_file(&root, "IMG_0002.jpg", b"kept-different-date");
    write_file(&root, "IMG_0003.jpg", b"kept-never-viewed-yet");

    // IMG_0001/0002 は過去に一度表示され、EXIF撮影日が exif_cache に保存済みという想定
    // （get_image_info 経由の遅延取得。IMG_0003 は未表示＝未取得のまま）。
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

    let scanner = ImageScanner::new();
    let (files, _errors) = scanner
        .scan_directory_with_progress(&root, &filter, |_, _| {})
        .expect("scan");
    let got = relative_set(&root, &included_paths(&files, &filter, &root));

    assert_eq!(
        got,
        BTreeSet::from(["IMG_0002.jpg".to_string(), "IMG_0003.jpg".to_string()]),
        "撮影日が一致するIMG_0001だけが除外され、ファイル名に日付が無くても正しく判定できるはず"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// #61 レビュー S-a: ディレクトリ系除外ルールが新たに追加され、前回は追跡していた
/// ファイルがWalkDirのfilter_entryで枝刈りされて生スキャンに一切現れなくなった場合、
/// `scanner.rs` はそれを「削除」ではなく「不明」（`unknown_files`）に分類する
/// （`file_metadata`/`image_stats`を消す判断は呼び出し元に委ねない、scanner自身が
/// 確定削除と不明を区別する）。
#[test]
fn incremental_scan_treats_newly_pruned_directory_as_unknown_not_deleted() {
    let root = workspace("prune_unknown");

    write_file(&root, "keep/normal.jpg", b"normal");
    write_file(&root, "@eaDir/thumb.jpg", b"synology-thumb");

    let scanner = ImageScanner::new();
    let no_prune_filter = IgnoreFilter::from_patterns(&[]);

    // 1回目: 除外ルールが無い状態でスキャンし、@eaDir/thumb.jpg も普通に追跡される。
    let (first, _errors) = scanner
        .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
        .expect("first scan");
    let previous: Vec<(String, i64, i64)> = first
        .iter()
        .map(|f| (f.path.clone(), f.modified_time, f.file_size))
        .collect();
    assert_eq!(
        previous.len(),
        2,
        "初回は@eaDir配下も含めて2件追跡されるはず"
    );

    // 2回目: @eaDir除外ルールを追加してスキャン（ファイル自体は削除されていない）。
    let prune_filter = IgnoreFilter::from_rules(&[IgnoreRule::glob("**/@eaDir/")]);
    let result = scanner
        .scan_directory_incremental_with_progress(&root, previous, &prune_filter, |_, _| {})
        .expect("incremental scan with new prune rule");

    let eadir_path = root.join("@eaDir/thumb.jpg").to_string_lossy().to_string();

    assert!(
        !result.deleted_files.contains(&eadir_path),
        "枝刈りされただけのファイルを確定削除扱いしてはいけない"
    );
    assert!(
        result.unknown_files.contains(&eadir_path),
        "枝刈りされ存在確認できないファイルはunknown_filesに分類されるはず"
    );
    assert_eq!(result.deleted_count, 0);
    assert_eq!(result.unknown_count, 1);
    // 生スキャン結果自体にも@eaDir配下は一切現れない（枝刈りの証拠）
    assert!(files_do_not_contain(&result.files, &eadir_path));

    let _ = std::fs::remove_dir_all(&root);
}

fn files_do_not_contain(files: &[sss_lib::scanner::FileMetadata], path: &str) -> bool {
    files.iter().all(|f| f.path != path)
}

/// #61レビュー S-b 計測: `should_prune_dir` に一致するディレクトリは `WalkDir::filter_entry`
/// でその枝ごと刈られ配下へ一切降りないため、枝刈りの所要時間は配下のファイル数に
/// 依存しない（配下を stat/EXIF 判定する経路自体が存在しない）はず、という
/// `scan_directory_with_progress` のコメント上の主張を実測で確認する。
///
/// 実運用は Synology の `@eaDir` 等が数万件規模になり得るが、CI/開発機の実行時間と
/// ディスク消費を抑えるため、フィクスチャは数百〜千件規模に留める（枝刈りが効いて
/// いれば配下の件数に関わらず一定時間で終わるはずなので、規模を落としても
/// 「配下の件数に比例して遅くなる」退行の検出力は失われない）。
#[test]
fn scan_skips_pruned_directory_regardless_of_its_size() {
    let root = workspace("prune_scale");

    // 通常ファイルは少量。
    const KEPT_COUNT: usize = 20;
    for i in 0..KEPT_COUNT {
        write_file(&root, &format!("keep/photo{i}.jpg"), b"normal");
    }
    // 除外対象ディレクトリ配下に数百〜千件規模のダミーファイルを敷く
    // （枝刈りされれば中身は一切読まれないはず）。
    const PRUNED_COUNT: usize = 1000;
    for i in 0..PRUNED_COUNT {
        write_file(&root, &format!("@eaDir/thumb{i}.jpg"), b"x");
    }

    let scanner = ImageScanner::new();
    let filter = IgnoreFilter::from_rules(&default_ignore_rules());

    let start = std::time::Instant::now();
    let (files, _errors) = scanner
        .scan_directory_with_progress(&root, &filter, |_, _| {})
        .expect("scan");
    let elapsed = start.elapsed();

    // 枝刈りの証拠: 生スキャン結果自体に @eaDir 配下（1000件）が一切現れない。
    let raw_relative = relative_set(
        &root,
        &files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
    );
    assert_eq!(
        raw_relative.len(),
        KEPT_COUNT,
        "@eaDir配下({PRUNED_COUNT}件)が枝刈りされず生スキャン結果に数え上げられている"
    );
    assert!(raw_relative.iter().all(|p| p.starts_with("keep/")));

    // 性能の証拠: 配下1000件を刈っても実用的な時間で終わる（レビュー実測: 数msオーダー）。
    // ディレクトリ単位の枝刈りが壊れてファイル単位のstat/EXIF判定に退行すると、
    // 配下の件数に比例して遅くなりこの上限を超えるはず。
    assert!(
        elapsed.as_secs_f64() < 2.0,
        "@eaDir 配下{PRUNED_COUNT}件の枝刈りに{:.3}秒かかった（ディレクトリ単位の枝刈りが効いていない疑い）",
        elapsed.as_secs_f64()
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// #61 レビュー nit: ファイル単位のglob除外（ディレクトリ系ではない。例: 特定ファイル
/// パスの除外パターン）はWalkDirの`filter_entry`で枝刈りされない（ディレクトリしか
/// 刈らないため、ファイルは常に列挙される）。よって、そのファイルが今回の生スキャンに
/// 現れなかったのは「祖先ディレクトリが枝刈りされ未確認」ではなく「実際にディスクから
/// 消えた」ことを意味するはずで、`unknown_files`ではなく`deleted_files`に分類される
/// べき（ディレクトリ系除外による枝刈りとの取り違えを防ぐ）。
#[test]
fn incremental_scan_treats_actually_deleted_file_level_excluded_file_as_deleted_not_unknown() {
    let root = workspace("file_glob_excluded_deleted");

    write_file(&root, "keep/normal.jpg", b"normal");
    write_file(&root, "keep/secret.jpg", b"secret");

    let scanner = ImageScanner::new();
    let no_prune_filter = IgnoreFilter::from_patterns(&[]);

    // 1回目: 除外ルールが無い状態でスキャンし、両方とも追跡される。
    let (first, _errors) = scanner
        .scan_directory_with_progress(&root, &no_prune_filter, |_, _| {})
        .expect("first scan");
    let previous: Vec<(String, i64, i64)> = first
        .iter()
        .map(|f| (f.path.clone(), f.modified_time, f.file_size))
        .collect();
    assert_eq!(previous.len(), 2, "初回は2件とも追跡されるはず");

    // secret.jpgをファイル単位のglobルール（ディレクトリ指定ではない）で除外し、
    // かつ実際にディスクから削除する。
    let secret_path = root.join("keep/secret.jpg");
    let secret_str = secret_path.to_string_lossy().to_string();
    let escaped = globset::escape(&secret_str);
    std::fs::remove_file(&secret_path).unwrap();

    let file_glob_filter = IgnoreFilter::from_rules(&[IgnoreRule::glob(escaped)]);
    let result = scanner
        .scan_directory_incremental_with_progress(&root, previous, &file_glob_filter, |_, _| {})
        .expect("incremental scan with file-level glob rule");

    assert!(
        result.deleted_files.contains(&secret_str),
        "ファイル単位のglobで除外されていても、ディレクトリは枝刈りされていない\
         （WalkDirは探索済み）ので、実際に消えたファイルは確定削除扱いになるはず"
    );
    assert!(
        !result.unknown_files.contains(&secret_str),
        "ディレクトリ系除外による枝刈りが無いのでunknownに分類してはいけない"
    );
    assert_eq!(result.deleted_count, 1);
    assert_eq!(result.unknown_count, 0);

    let _ = std::fs::remove_dir_all(&root);
}
