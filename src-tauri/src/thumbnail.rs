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
        return Ok(dest);
    }

    let _guard = GENERATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 待っている間に別呼び出しが作り終えているかもしれない。
    if dest.exists() {
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

/// `counter` を1つ進め、`interval` 枚ごとに `thumbs_dir` の合計が `max_bytes` 以下に
/// なるよう mtime の古いものから削除する。いま書いた `just_written` は消さない。
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

        // 2 回目は再生成せず同じファイルを返す（更新日時が変わらない）。
        let first_mtime = std::fs::metadata(&thumb).unwrap().modified().unwrap();
        let again = ensure_thumbnail(&src, &cache).unwrap();
        assert_eq!(again, thumb);
        assert_eq!(
            std::fs::metadata(&again).unwrap().modified().unwrap(),
            first_mtime
        );

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
}
