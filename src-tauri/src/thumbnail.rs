//! 設定画面（履歴・ピック済みタブ）用の小さなサムネイル生成（#67）。
//!
//! 以前はサムネイルのために原本（5000万画素級の JPEG 等）をそのまま `<img>` で
//! 読ませていたため、1 枚ごとに巨大な画像デコードが走って重く、動画は壊れた
//! アイコンになっていた。ここでは長辺 [`THUMB_MAX_EDGE`] px の JPEG を作って
//! キャッシュディレクトリ配下（`<cache_dir>/thumbs/`）に保存し、そのパスを返す。
//! 保存先はキャッシュ配下なので起動時に asset scope へ許可済みで、起動・リセット時の
//! `clear_cache_dir` で他のキャッシュと同様に掃除される（次回は再生成されるだけ）。

use crate::image_processor::load_and_orient;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// サムネイルの長辺（px）。設定画面の 4 列グリッドで Retina でも十分な大きさ。
pub const THUMB_MAX_EDGE: u32 = 256;
const THUMB_JPEG_QUALITY: u8 = 80;
const THUMBS_SUBDIR: &str = "thumbs";

/// `<cache_dir>/thumbs/` 専用のサイズ上限（256MB。256px の JPEG なら1万数千枚分）。
/// 本体のキャッシュ上限（[`crate::cache_worker::CACHE_MAX_BYTES`]）は `cache_dir` 直下の
/// ファイルだけを数えるため、サムネイルは別枠でここで抑える。起動時の `clear_cache_dir`
/// が効くのは次回起動時なので、それまでの1セッション中に履歴・ピックを見続けても
/// 無制限には増えない。
pub const THUMBS_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// 上限チェックの間隔（サムネイルを何枚生成するごとに走査するか）。毎回ディレクトリを
/// 走査するのは無駄なので、キャッシュワーカーと同様にまとめて確認する。
const THUMBS_ENFORCE_INTERVAL: u32 = 50;

/// 生成したサムネイル枚数（プロセス全体）。
static THUMBS_WRITTEN: AtomicU32 = AtomicU32::new(0);

/// 巨大画像のデコードが同時に何本も走ってメモリを食わないよう直列化する。
static GENERATION_LOCK: Mutex<()> = Mutex::new(());

/// サムネイルの保存先パス。キーは「パス + 更新日時 + サイズ」なので、原本が
/// 差し替わったら別ファイル名になり古いサムネイルを掴まない。
pub fn thumbnail_cache_path(
    cache_dir: &Path,
    source: &Path,
    mtime_secs: u64,
    size: u64,
) -> PathBuf {
    let key = format!(
        "{:x}",
        md5::compute(format!(
            "{}:{}:{}",
            source.to_string_lossy(),
            mtime_secs,
            size
        ))
    );
    cache_dir.join(THUMBS_SUBDIR).join(format!("{key}.jpg"))
}

/// アルファを黒背景に合成して RGB にする（UI が暗色なので、透過部の下に残った
/// 元の色が見えてしまうのを避ける）。
fn flatten_on_black(img: &image::DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let mut out = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = u32::from(px[3]);
        let blend = |c: u8| ((u32::from(c) * a + 127) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
    }
    out
}

/// `source` のサムネイルを（無ければ）作り、保存先パスを返す。
/// EXIF Orientation は常に画素へ焼き込む（表示設定に依存せず正しい向きで見せる）。
pub fn ensure_thumbnail(source: &Path, cache_dir: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(source).map_err(|e| format!("Failed to stat image: {e}"))?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let dest = thumbnail_cache_path(cache_dir, source, mtime_secs, meta.len());
    if dest.exists() {
        touch_modified(&dest);
        return Ok(dest);
    }

    let _guard = GENERATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 待っている間に別呼び出しが作り終えているかもしれない。
    if dest.exists() {
        touch_modified(&dest);
        return Ok(dest);
    }

    let img = load_and_orient(source, true)?;
    // `thumbnail` は拡大もしてしまうので、既に小さい画像はそのまま使う。
    let small = if img.width() > THUMB_MAX_EDGE || img.height() > THUMB_MAX_EDGE {
        img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE)
    } else {
        img
    };
    let rgb = flatten_on_black(&small);

    let mut buffer = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::Cursor::new(&mut buffer),
        THUMB_JPEG_QUALITY,
    );
    rgb.write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode thumbnail: {e}"))?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail directory: {e}"))?;
    }
    crate::cache_worker::write_atomic(&dest, &buffer)
        .map_err(|e| format!("Failed to write thumbnail: {e}"))?;
    if let Some(parent) = dest.parent() {
        maybe_enforce_thumbs_limit(
            parent,
            &dest,
            &THUMBS_WRITTEN,
            THUMBS_ENFORCE_INTERVAL,
            THUMBS_MAX_BYTES,
        );
    }
    Ok(dest)
}

/// キャッシュヒットしたサムネイルの mtime を現在時刻へ更新する（失敗は無視）。
/// 上限超過時の削除は mtime の古い順なので、生成時刻のままだと「よく見るのに古い」
/// ものから消える FIFO になってしまう。ヒットのたびに更新して実質 LRU にする。
/// 読み取り専用オープンだと Windows で `set_modified` に必要な権限が無く失敗しうるため、
/// 内容を変えない `append(true)` で開く（`cache_worker::mark_served` と同じ方式）。
fn touch_modified(path: &Path) {
    if let Ok(file) = std::fs::OpenOptions::new().append(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
}

/// `counter` を1つ進め、`interval` 枚ごとに `thumbs_dir` の合計が `max_bytes` 以下に
/// なるよう mtime の古いものから削除する（ヒット時に mtime を更新するので実質 LRU）。いま書いた `just_written` は消さない。
/// 失敗してもサムネイル生成自体は成功扱い（上限管理は付随処理）。
fn maybe_enforce_thumbs_limit(
    thumbs_dir: &Path,
    just_written: &Path,
    counter: &AtomicU32,
    interval: u32,
    max_bytes: u64,
) {
    let written = counter.fetch_add(1, Ordering::Relaxed) + 1;
    if !written.is_multiple_of(interval) {
        return;
    }
    let mut exclude = HashSet::new();
    exclude.insert(just_written.to_path_buf());
    if let Err(e) = crate::cache_worker::enforce_cache_limit(thumbs_dir, max_bytes, &exclude) {
        eprintln!("thumbnail: failed to enforce thumbs limit: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sss_thumbnail_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cache_path_changes_with_mtime_and_size_and_lives_under_thumbs() {
        let cache = Path::new("/cache");
        let src = Path::new("/photos/a.jpg");
        let base = thumbnail_cache_path(cache, src, 100, 10);
        assert!(base.starts_with("/cache/thumbs"));
        assert_eq!(base.extension().unwrap(), "jpg");
        assert_eq!(base, thumbnail_cache_path(cache, src, 100, 10));
        assert_ne!(base, thumbnail_cache_path(cache, src, 101, 10));
        assert_ne!(base, thumbnail_cache_path(cache, src, 100, 11));
        assert_ne!(
            base,
            thumbnail_cache_path(cache, Path::new("/photos/b.jpg"), 100, 10)
        );
    }

    #[test]
    fn generates_small_jpeg_keeping_aspect_and_reuses_cache() {
        let dir = workspace("gen");
        let src = dir.join("wide.png");
        image::RgbImage::from_pixel(1000, 500, image::Rgb([200, 30, 30]))
            .save(&src)
            .unwrap();
        let cache = dir.join("cache");

        let thumb = ensure_thumbnail(&src, &cache).unwrap();
        assert!(thumb.starts_with(cache.join("thumbs")));
        let decoded = image::open(&thumb).unwrap();
        assert_eq!(decoded.width(), THUMB_MAX_EDGE);
        assert_eq!(decoded.height(), THUMB_MAX_EDGE / 2);

        // 2 回目は再生成せず同じファイルを返す。同じ画像から作り直しても同じバイト列に
        // なるため、単なるバイト比較では再生成を見分けられない。キャッシュ済みの中身を
        // 別の目印バイト列に置き換えておき、ヒットでそれが上書きされない（＝再生成
        // されていない）ことを確かめる。
        let marker = b"cached-thumbnail-marker";
        std::fs::write(&thumb, marker).unwrap();
        let again = ensure_thumbnail(&src, &cache).unwrap();
        assert_eq!(again, thumb);
        assert_eq!(
            std::fs::read(&again).unwrap(),
            marker,
            "キャッシュヒットで再生成されない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// キャッシュヒットでサムネイルの mtime が現在へ更新される（上限削除が LRU になる）。
    #[test]
    fn cache_hit_refreshes_thumbnail_mtime_so_trim_is_lru() {
        let dir = workspace("lru");
        let src = dir.join("a.png");
        image::RgbImage::from_pixel(64, 64, image::Rgb([10, 20, 30]))
            .save(&src)
            .unwrap();
        let cache = dir.join("cache");
        let thumb = ensure_thumbnail(&src, &cache).unwrap();

        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        // 再生成されたかを見分けるため、中身を目印のバイト列に置き換える（同じ画像から
        // 作り直すとバイト列が同じになり、元の中身との比較では区別できない）。
        let bytes = b"cached-thumbnail-marker".to_vec();
        std::fs::write(&thumb, &bytes).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&thumb)
            .unwrap()
            .set_modified(past)
            .unwrap();
        #[cfg(unix)]
        let inode_before = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&thumb).unwrap().ino()
        };

        let again = ensure_thumbnail(&src, &cache).unwrap();
        assert_eq!(again, thumb);
        assert_eq!(
            std::fs::read(&thumb).unwrap(),
            bytes,
            "ヒットでは再生成されない（目印の中身が残る）"
        );
        // 再生成は一時ファイル→rename で別 inode になるので、同じ inode のままであることでも担保する。
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                std::fs::metadata(&thumb).unwrap().ino(),
                inode_before,
                "ヒットでは書き換え（rename）されない"
            );
        }
        let refreshed = std::fs::metadata(&thumb).unwrap().modified().unwrap();
        assert!(
            refreshed > past + std::time::Duration::from_secs(3000),
            "ヒットで mtime が現在へ更新される"
        );

        // 上限超過の削除では、ヒットで更新された方が残り、更新されなかった古い方が先に消える。
        let stale = write_aged(&cache.join("thumbs"), "stale.jpg", 1800);
        maybe_enforce_thumbs_limit(
            &cache.join("thumbs"),
            &cache.join("thumbs").join("none.jpg"),
            &AtomicU32::new(0),
            1,
            u64::try_from(bytes.len()).unwrap(),
        );
        assert!(thumb.exists(), "最近ヒットしたものは残る");
        assert!(!stale.exists(), "ヒットしていない古いものが先に消える");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_source_is_not_upscaled() {
        let dir = workspace("small");
        let src = dir.join("tiny.png");
        image::RgbImage::from_pixel(40, 30, image::Rgb([1, 2, 3]))
            .save(&src)
            .unwrap();
        let thumb = ensure_thumbnail(&src, &dir.join("cache")).unwrap();
        let decoded = image::open(&thumb).unwrap();
        assert!(decoded.width() <= 40 && decoded.height() <= 30);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transparent_pixels_are_flattened_on_black() {
        let dir = workspace("alpha");
        let src = dir.join("clear.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([255, 255, 255, 0]))
            .save(&src)
            .unwrap();
        let thumb = ensure_thumbnail(&src, &dir.join("cache")).unwrap();
        let px = image::open(&thumb).unwrap().to_rgb8().get_pixel(32, 32).0;
        assert!(px.iter().all(|c| *c < 8), "透過は黒になるはず: {px:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_image_and_missing_files_fail_without_writing() {
        let dir = workspace("fail");
        let bogus = dir.join("notes.jpg");
        std::fs::write(&bogus, b"not an image").unwrap();
        let cache = dir.join("cache");
        assert!(ensure_thumbnail(&bogus, &cache).is_err());
        assert!(ensure_thumbnail(&dir.join("missing.jpg"), &cache).is_err());
        let written = cache.join("thumbs").exists()
            && std::fs::read_dir(cache.join("thumbs"))
                .unwrap()
                .next()
                .is_some();
        assert!(!written);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_aged(dir: &Path, name: &str, age_secs: u64) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"0123456789").unwrap();
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        path
    }

    /// #67: `<cache_dir>/thumbs/` は本体キャッシュの上限管理の外にあったため、
    /// 専用の上限で古い順に削除する（interval 枚ごとにだけ走査する）。
    #[test]
    fn thumbs_dir_is_trimmed_oldest_first_only_on_the_interval() {
        let dir = workspace("trim");
        let thumbs = dir.join("thumbs");
        std::fs::create_dir_all(&thumbs).unwrap();
        for (i, age) in [500u64, 400, 300, 200].iter().enumerate() {
            write_aged(&thumbs, &format!("t{i}.jpg"), *age);
        }
        let newest = write_aged(&thumbs, "new.jpg", 1);
        let counter = AtomicU32::new(0);

        // 1 枚目（interval=2 の途中）は走査しない。上限超過でも何も消えない。
        maybe_enforce_thumbs_limit(&thumbs, &newest, &counter, 2, 20);
        assert_eq!(std::fs::read_dir(&thumbs).unwrap().count(), 5);

        // 2 枚目で走査。合計 50B を 20B 以下にするため古い 3 枚が消える。
        maybe_enforce_thumbs_limit(&thumbs, &newest, &counter, 2, 20);
        let mut left: Vec<String> = std::fs::read_dir(&thumbs)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, ["new.jpg", "t3.jpg"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn thumbs_trim_never_deletes_the_thumbnail_just_written() {
        let dir = workspace("trim_keep");
        let thumbs = dir.join("thumbs");
        std::fs::create_dir_all(&thumbs).unwrap();
        write_aged(&thumbs, "old.jpg", 100);
        let newest = write_aged(&thumbs, "new.jpg", 1);
        // 上限 0 でも、いま書いたものは返り値のパスとして使われるので消さない。
        maybe_enforce_thumbs_limit(&thumbs, &newest, &AtomicU32::new(0), 1, 0);
        assert!(newest.exists());
        assert!(!thumbs.join("old.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 独立QA観点表からの追加テスト（#67） ----

    /// EXIF Orientation だけを持つ最小の APP1(Exif) セグメント（リトルエンディアン）。
    fn exif_orientation_segment(orientation: u16) -> Vec<u8> {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0u8, 0u8]);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut app1 = vec![0xFFu8, 0xE1];
        app1.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        app1
    }

    fn encode_jpeg(img: &image::RgbImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(img.clone())
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        bytes
    }

    /// 決定的な疑似ノイズ画像（JPEG が十分な大きさになり、途中で切れば壊れる）。
    fn noisy_image(w: u32, h: u32) -> image::RgbImage {
        let mut state: u32 = 0x1234_5678;
        image::RgbImage::from_fn(w, h, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            image::Rgb([(state >> 24) as u8, (state >> 16) as u8, (state >> 8) as u8])
        })
    }

    fn png_of_size(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let path = dir.join(name);
        image::RgbImage::from_pixel(w, h, image::Rgb([10, 200, 90]))
            .save(&path)
            .unwrap();
        path
    }

    fn thumb_dims(thumb: &Path) -> (u32, u32) {
        let img = image::open(thumb).unwrap();
        (img.width(), img.height())
    }

    fn leftover_tmp_files(cache: &Path) -> Vec<String> {
        std::fs::read_dir(cache.join("thumbs"))
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.starts_with('.') || n.contains(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn exif_orientation_6_swaps_width_and_height_in_the_thumbnail() {
        let dir = workspace("exif6");
        let src = dir.join("rotated.jpg");
        // 格納は横長 40x20。Orientation=6（90度回転）なので表示は縦長 20x40 になる。
        let base = encode_jpeg(&image::RgbImage::from_pixel(
            40,
            20,
            image::Rgb([90, 90, 200]),
        ));
        let mut bytes = base[0..2].to_vec();
        bytes.extend_from_slice(&exif_orientation_segment(6));
        bytes.extend_from_slice(&base[2..]);
        std::fs::write(&src, bytes).unwrap();

        let thumb = ensure_thumbnail(&src, &dir.join("cache")).unwrap();
        assert_eq!(thumb_dims(&thumb), (20, 40));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_edge_at_or_below_256_keeps_original_size_and_257_is_downscaled() {
        let dir = workspace("edges");
        let cache = dir.join("cache");
        let t255 = ensure_thumbnail(&png_of_size(&dir, "e255.png", 255, 100), &cache).unwrap();
        assert_eq!(thumb_dims(&t255), (255, 100));
        let t256 = ensure_thumbnail(&png_of_size(&dir, "e256.png", 256, 100), &cache).unwrap();
        assert_eq!(thumb_dims(&t256), (256, 100));
        let t257 = ensure_thumbnail(&png_of_size(&dir, "e257.png", 257, 100), &cache).unwrap();
        let (w, h) = thumb_dims(&t257);
        assert_eq!(w, THUMB_MAX_EDGE, "長辺 257 は 256 に縮小される");
        assert!(h <= 100, "縦横比を保って縮む: {h}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portrait_source_is_limited_by_height_not_width() {
        let dir = workspace("portrait");
        let src = png_of_size(&dir, "tall.png", 100, 1000);
        let thumb = ensure_thumbnail(&src, &dir.join("cache")).unwrap();
        let (w, h) = thumb_dims(&thumb);
        assert_eq!(h, THUMB_MAX_EDGE);
        assert!(w < h, "縦長のまま: {w}x{h}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changing_source_mtime_or_size_yields_a_new_thumbnail_path() {
        let dir = workspace("invalidate");
        let cache = dir.join("cache");
        let src = png_of_size(&dir, "a.png", 300, 300);
        let first = ensure_thumbnail(&src, &cache).unwrap();

        // 内容（サイズ）を変えて書き直す → 別パスで再生成される。
        image::RgbImage::from_pixel(400, 200, image::Rgb([1, 1, 1]))
            .save(&src)
            .unwrap();
        let after_resize = ensure_thumbnail(&src, &cache).unwrap();
        assert_ne!(after_resize, first);
        assert_eq!(thumb_dims(&after_resize).0, THUMB_MAX_EDGE);

        // サイズは同じで mtime だけ進める（秒精度なので 10 秒進める）→ また別パス。
        let bumped = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
        std::fs::File::options()
            .write(true)
            .open(&src)
            .unwrap()
            .set_modified(bumped)
            .unwrap();
        let after_touch = ensure_thumbnail(&src, &cache).unwrap();
        assert_ne!(after_touch, after_resize);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eight_threads_on_the_same_source_all_succeed_with_one_path_and_no_tmp_leftovers() {
        let dir = workspace("same_source");
        let cache = dir.join("cache");
        let src = png_of_size(&dir, "shared.png", 900, 600);

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (src, cache) = (src.clone(), cache.clone());
                std::thread::spawn(move || ensure_thumbnail(&src, &cache))
            })
            .collect();
        let paths: Vec<PathBuf> = handles
            .into_iter()
            .map(|h| h.join().unwrap().expect("全員 Ok のはず"))
            .collect();

        assert!(paths.iter().all(|p| *p == paths[0]), "同一パス: {paths:?}");
        assert_eq!(
            thumb_dims(&paths[0]).0,
            THUMB_MAX_EDGE,
            "出力はデコードできる"
        );
        assert_eq!(leftover_tmp_files(&cache), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_requests_for_different_sources_finish_without_deadlock() {
        let dir = workspace("many_sources");
        let cache = dir.join("cache");
        let (tx, rx) = std::sync::mpsc::channel();
        for i in 0..8u32 {
            let src = png_of_size(&dir, &format!("s{i}.png"), 300 + i, 200);
            let (cache, tx) = (cache.clone(), tx.clone());
            std::thread::spawn(move || {
                let _ = tx.send(ensure_thumbnail(&src, &cache));
            });
        }
        drop(tx);
        let mut done = 0;
        while let Ok(result) = rx.recv_timeout(std::time::Duration::from_secs(60)) {
            result.expect("各サムネイルは成功するはず");
            done += 1;
        }
        assert_eq!(done, 8, "60 秒以内に全員が終わる（デッドロックしない）");
        assert_eq!(leftover_tmp_files(&cache), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_jpeg_fails_without_leaving_tmp_or_a_bogus_thumbnail() {
        let dir = workspace("truncated");
        let full = encode_jpeg(&noisy_image(300, 300));
        let cache = dir.join("cache");
        // ヘッダ直後で切れた本物の JPEG。デコードできないのでエラーになる。
        let src = dir.join("cut.jpg");
        std::fs::write(&src, &full[..full.len().min(200)]).unwrap();
        assert!(ensure_thumbnail(&src, &cache).is_err());
        assert_eq!(leftover_tmp_files(&cache), Vec::<String>::new());
        let produced = std::fs::read_dir(cache.join("thumbs"))
            .map(|rd| rd.count())
            .unwrap_or(0);
        assert_eq!(produced, 0, "失敗時にサムネイル本体も残さない");

        // 途中（半分）で切れた場合、デコーダが部分画像を返すかどうかは image crate の
        // 挙動次第。どちらでも「Ok なら読めるサムネイル、Err なら残骸なし」を守る。
        let half = dir.join("half.jpg");
        std::fs::write(&half, &full[..full.len() / 2]).unwrap();
        match ensure_thumbnail(&half, &cache) {
            Ok(thumb) => assert!(image::open(&thumb).is_ok(), "Ok なら読める JPEG"),
            Err(_) => assert_eq!(leftover_tmp_files(&cache), Vec::<String>::new()),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn japanese_spaced_and_emoji_paths_work() {
        let dir = workspace("unicode");
        let folder = dir.join("旅行 写真 🌸");
        std::fs::create_dir_all(&folder).unwrap();
        let src = png_of_size(&folder, "夕焼け 1 🌇.png", 320, 240);
        let thumb = ensure_thumbnail(&src, &dir.join("cache dir 🗂")).unwrap();
        assert_eq!(thumb_dims(&thumb).0, THUMB_MAX_EDGE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zero_byte_source_fails_without_writing() {
        let dir = workspace("zero");
        let src = dir.join("empty.jpg");
        std::fs::write(&src, b"").unwrap();
        let cache = dir.join("cache");
        assert!(ensure_thumbnail(&src, &cache).is_err());
        assert!(!cache.join("thumbs").exists() || leftover_tmp_files(&cache).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
