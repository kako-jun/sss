use image::{imageops::FilterType, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

/// 4K解像度用の最大サイズ
pub const MAX_WIDTH_4K: u32 = 3840;
pub const MAX_HEIGHT_4K: u32 = 2160;

/// EXIF情報
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    pub date_time: Option<String>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 画像情報
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub path: String,
    pub optimized_path: Option<String>, // 4K最適化された画像のパス（ある場合）
    pub is_video: bool,                 // 動画ファイルかどうか
    pub width: u32,
    pub height: u32,
    pub file_size: u64,
    pub exif: Option<ExifInfo>,
    pub display_count: i32,
    pub last_displayed: Option<String>,
    /// apply_exif_rotation 設定のスナップショット。回転はフロントの `image-orientation`
    /// CSS で行うため（#60 レビュー方針転換）、フロントがこの値を見て
    /// `from-image`（true）/`none`（false）を切り替える必要がある。
    pub apply_rotation: bool,
}

/// 画像を読み込み、apply_rotation=true かつ EXIF Orientation が存在する場合は回転・反転を適用する。
///
/// 回転処理は `DynamicImage::apply_orientation` に完全委譲する（#60）。
/// 旧実装は Orientation 5/7 を手動の rotate/flip 組み合わせで実装しており、
/// 5 は `rotate90().fliph()` が正しいところを `rotate90().flipv()` に、
/// 7 は `rotate270().fliph()` が正しいところを `rotate90().fliph()` にしてしまっていた。
/// image crate の実装に委譲することでこのクラスの誤りを構造的に排除する。
pub fn load_and_orient(
    image_path: &Path,
    apply_rotation: bool,
) -> Result<image::DynamicImage, String> {
    let mut img = image::open(image_path).map_err(|e| format!("Failed to open image: {e}"))?;

    if apply_rotation {
        if let Some(orientation) = read_exif_orientation(image_path) {
            img.apply_orientation(orientation);
        }
    }

    Ok(img)
}

/// 4K解像度を超えるかどうか（幅高さは回転適用後・表示向きのものを渡すこと）
fn needs_4k_resize(width: u32, height: u32) -> bool {
    width > MAX_WIDTH_4K || height > MAX_HEIGHT_4K
}

/// 画像を最適化（EXIF回転適用 + 4Kリサイズ）
///
/// 出力フォーマットは元画像の拡張子から決める（`cache_extension_for` と対で使うこと）。
/// PNG 原本は透過を保持するため PNG のまま、それ以外は JPEG (品質90%明示) で書き出す。
pub fn optimize_image_for_4k(image_path: &Path, apply_rotation: bool) -> Result<Vec<u8>, String> {
    let img = load_and_orient(image_path, apply_rotation)?;
    let (width, height) = img.dimensions();

    let resized_img = if needs_4k_resize(width, height) {
        img.resize(MAX_WIDTH_4K, MAX_HEIGHT_4K, FilterType::Lanczos3)
    } else {
        img
    };

    let mut buffer = Vec::new();
    if is_png_source(image_path) {
        resized_img
            .write_to(&mut std::io::Cursor::new(&mut buffer), ImageFormat::Png)
            .map_err(|e| format!("Failed to encode image: {e}"))?;
    } else {
        // 品質90%を明示（image crate のデフォルト書き出しは q75 相当のため、
        // コメント通りの90%にするには JpegEncoder を直接使う必要がある）
        let mut cursor = std::io::Cursor::new(&mut buffer);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
        resized_img
            .write_with_encoder(encoder)
            .map_err(|e| format!("Failed to encode image: {e}"))?;
    }

    Ok(buffer)
}

/// EXIF Orientationタグを読み取る（値が不正/未知/EXIF無しの場合は None）
fn read_exif_orientation(image_path: &Path) -> Option<image::metadata::Orientation> {
    let file = File::open(image_path).ok()?;
    let mut buf_reader = BufReader::new(file);
    let exif_reader = exif::Reader::new();
    let exif = exif_reader.read_from_container(&mut buf_reader).ok()?;
    let field = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?;
    let value = field.value.get_uint(0)?;
    image::metadata::Orientation::from_exif(u8::try_from(value).ok()?)
}

/// 90度/270度系（Orientation 5,6,7,8）は表示時に幅高さが入れ替わる
fn orientation_swaps_dimensions(orientation: image::metadata::Orientation) -> bool {
    use image::metadata::Orientation::{Rotate270, Rotate270FlipH, Rotate90, Rotate90FlipH};
    matches!(
        orientation,
        Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH
    )
}

/// 拡張子が png かどうか（透過保持のため PNG のまま書き出す判定に使う）
fn is_png_source(path: &Path) -> bool {
    ext_lower(path).as_deref() == Some("png")
}

/// アニメーションしうる形式（GIF/WebP）かどうか。
/// これらは静止フレーム化を避けるため常にキャッシュ対象外とし、原本をそのまま表示する。
fn is_animation_capable_format(path: &Path) -> bool {
    matches!(ext_lower(path).as_deref(), Some("gif") | Some("webp"))
}

/// WebView（Windows/Linux 含む）が直接表示できない形式かどうか（例: TIFF）。
/// これらは常にキャッシュ経由（JPEG/PNG へ変換）で表示する。
pub fn is_webview_unsupported_format(path: &Path) -> bool {
    matches!(ext_lower(path).as_deref(), Some("tiff") | Some("tif"))
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
}

/// 画像の基本情報（幅・高さ）を取得する。ヘッダのみを読み、フルデコードしない
/// （巨大画像でも高速・`Limits` 超過で (0,0) になる問題を回避する）。
/// 返す幅高さは EXIF Orientation 適用前（ファイル上の生の値）。
pub fn get_image_dimensions(image_path: &Path) -> Result<(u32, u32), String> {
    image::image_dimensions(image_path).map_err(|e| format!("Failed to read image dimensions: {e}"))
}

/// 表示時の幅高さを取得する（`apply_rotation` が true の場合、90/270度系の
/// Orientation なら幅高さを入れ替えて返す）。
pub fn get_display_dimensions(
    image_path: &Path,
    apply_rotation: bool,
) -> Result<(u32, u32), String> {
    let (width, height) = get_image_dimensions(image_path)?;

    if !apply_rotation {
        return Ok((width, height));
    }

    match read_exif_orientation(image_path) {
        Some(orientation) if orientation_swaps_dimensions(orientation) => Ok((height, width)),
        _ => Ok((width, height)),
    }
}

/// このパスがキャッシュ（最適化済みファイル）を必要とするか判定し、必要なら
/// 保存先のキャッシュファイルパス（拡張子込み）を返す。不要なら None（原本をそのまま表示）。
///
/// キャッシュが必要になる条件（いずれか）:
/// - WebView が直接表示できない形式（TIFF等）
/// - 表示サイズが 4K を超える
///
/// EXIF回転**だけ**が理由でキャッシュを作ることはしない（#60 レビュー方針転換）。
/// 回転はフロントの `image-orientation` CSS（apply_rotation設定に連動して
/// `from-image`/`none` を切替）で行い、原本をそのまま asset プロトコル経由で表示する。
/// ただし上記の理由で結局キャッシュが必要になった画像（4K超・TIFF等）は、
/// キャッシュ生成時に apply_rotation の値に従って画素を回転しEXIFなしで書き出す
/// （`optimize_image_for_4k` 参照。生成物にはEXIFが残らないため `from-image` を
/// 当てても二重回転しない）。
///
/// 4K超の判定はヘッダ上の生の幅高さ（回転前）で行う。WebView は原本をそのまま
/// デコードしてから CSS で回転を表示上適用するだけで、デコード時のメモリコストは
/// 回転の有無に関係ないため。
///
/// アニメーション可能な形式（GIF/WebP）は上記条件に関わらず常に対象外
/// （静止フレーム化によるアニメ潰れを避けるため）。
pub fn plan_cache_file(
    image_path: &Path,
    apply_rotation: bool,
    cache_dir: &Path,
) -> Option<PathBuf> {
    if is_animation_capable_format(image_path) {
        return None;
    }

    let unsupported_by_webview = is_webview_unsupported_format(image_path);

    let (width, height) = get_image_dimensions(image_path).unwrap_or((0, 0));
    let oversized = needs_4k_resize(width, height);

    if !(unsupported_by_webview || oversized) {
        return None;
    }

    let ext = if is_png_source(image_path) {
        "png"
    } else {
        "jpg"
    };
    // キャッシュキーには apply_rotation に加えて原本の mtime・サイズも含める
    // （原本が置き換わった場合に古いキャッシュを誤って使い回さないため）。
    let (mtime, size) = std::fs::metadata(image_path)
        .ok()
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            (mtime, m.len())
        })
        .unwrap_or((0, 0));
    let hash = format!(
        "{:x}",
        md5::compute(format!(
            "{}:{apply_rotation}:{mtime}:{size}",
            image_path.to_string_lossy()
        ))
    );
    Some(cache_dir.join(format!("{hash}.{ext}")))
}

/// EXIF情報を取得
pub fn get_exif_info(image_path: &Path) -> Result<ExifInfo, String> {
    let file = File::open(image_path).map_err(|e| format!("Failed to open file: {e}"))?;

    let mut buf_reader = BufReader::new(file);
    let exif_reader = exif::Reader::new();

    match exif_reader.read_from_container(&mut buf_reader) {
        Ok(exif) => {
            let mut info = ExifInfo {
                date_time: None,
                gps_latitude: None,
                gps_longitude: None,
                width: None,
                height: None,
            };

            // 撮影日時
            if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
                info.date_time = Some(field.display_value().to_string());
            }

            // GPS座標の取得
            // 緯度
            if let Some(lat_field) = exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY) {
                if let Some(lat_ref_field) =
                    exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY)
                {
                    if let Some(latitude) = parse_gps_coordinate(
                        &lat_field.value,
                        &lat_ref_field.display_value().to_string(),
                    ) {
                        info.gps_latitude = Some(latitude);
                    }
                }
            }

            // 経度
            if let Some(lon_field) = exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY) {
                if let Some(lon_ref_field) =
                    exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY)
                {
                    if let Some(longitude) = parse_gps_coordinate(
                        &lon_field.value,
                        &lon_ref_field.display_value().to_string(),
                    ) {
                        info.gps_longitude = Some(longitude);
                    }
                }
            }

            // 画像サイズ
            if let Some(field) = exif.get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY) {
                if let Some(width) = field.value.get_uint(0) {
                    info.width = Some(width);
                }
            }
            if let Some(field) = exif.get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY) {
                if let Some(height) = field.value.get_uint(0) {
                    info.height = Some(height);
                }
            }

            Ok(info)
        }
        Err(_) => {
            // EXIF情報がない場合は空の情報を返す
            Ok(ExifInfo {
                date_time: None,
                gps_latitude: None,
                gps_longitude: None,
                width: None,
                height: None,
            })
        }
    }
}

/// GPS座標をパースして10進数に変換
fn parse_gps_coordinate(value: &exif::Value, reference: &str) -> Option<f64> {
    // GPS座標は度・分・秒の3つの有理数で表現される
    if let exif::Value::Rational(coords) = value {
        if coords.len() >= 3 {
            // 0除算チェック（不正なEXIFデータ対策）
            if coords[0].denom == 0 || coords[1].denom == 0 || coords[2].denom == 0 {
                return None;
            }

            let degrees = coords[0].to_f64();
            let minutes = coords[1].to_f64();
            let seconds = coords[2].to_f64();

            let mut decimal = degrees + (minutes / 60.0) + (seconds / 3600.0);

            // 南緯または西経の場合は負の値にする
            // display_value()の出力が余分な空白や引用符を含む場合に備えてtrimする
            let reference_trimmed = reference.trim().trim_matches('"');
            if reference_trimmed == "S" || reference_trimmed == "W" {
                decimal = -decimal;
            }

            return Some(decimal);
        }
    }
    None
}

/// 動画ファイルかどうかを判定
/// 拡張子リストは scanner::VIDEO_EXTENSIONS を正本とする
pub fn is_video_file(path: &Path) -> bool {
    if let Some(extension) = path.extension() {
        let ext = extension.to_string_lossy().to_lowercase();
        crate::scanner::VIDEO_EXTENSIONS.contains(&ext.as_str())
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use exif::Rational;

    #[test]
    fn needs_4k_resize_boundary() {
        assert!(!needs_4k_resize(MAX_WIDTH_4K, MAX_HEIGHT_4K));
        assert!(needs_4k_resize(MAX_WIDTH_4K + 1, MAX_HEIGHT_4K));
        assert!(needs_4k_resize(MAX_WIDTH_4K, MAX_HEIGHT_4K + 1));
        assert!(!needs_4k_resize(100, 100));
    }

    #[test]
    fn gps_coordinate_sign_follows_hemisphere_reference() {
        // 35度40分0秒
        let coords = vec![
            Rational { num: 35, denom: 1 },
            Rational { num: 40, denom: 1 },
            Rational { num: 0, denom: 1 },
        ];
        let value = exif::Value::Rational(coords);
        let expected = 35.0 + 40.0 / 60.0;

        assert_eq!(parse_gps_coordinate(&value, "N"), Some(expected));
        assert_eq!(parse_gps_coordinate(&value, "E"), Some(expected));
        assert_eq!(parse_gps_coordinate(&value, "S"), Some(-expected));
        assert_eq!(parse_gps_coordinate(&value, "W"), Some(-expected));
    }

    #[test]
    fn gps_coordinate_rejects_zero_denominator() {
        let coords = vec![
            Rational { num: 35, denom: 0 },
            Rational { num: 40, denom: 1 },
            Rational { num: 0, denom: 1 },
        ];
        let value = exif::Value::Rational(coords);
        assert_eq!(parse_gps_coordinate(&value, "N"), None);
    }

    #[test]
    fn format_classification() {
        assert!(is_png_source(Path::new("a.png")));
        assert!(is_png_source(Path::new("a.PNG")));
        assert!(!is_png_source(Path::new("a.jpg")));

        assert!(is_animation_capable_format(Path::new("a.gif")));
        assert!(is_animation_capable_format(Path::new("a.webp")));
        assert!(!is_animation_capable_format(Path::new("a.png")));

        assert!(is_webview_unsupported_format(Path::new("a.tiff")));
        assert!(is_webview_unsupported_format(Path::new("a.tif")));
        assert!(!is_webview_unsupported_format(Path::new("a.jpg")));
    }

    /// EXIF Orientation を埋め込んだ最小 TIFF ブロックを組み立てる（テスト専用）。
    /// リトルエンディアン固定・IFD0 に Orientation(0x0112, SHORT, count=1) のみを持つ。
    fn build_exif_orientation_tiff(orientation: u8) -> Vec<u8> {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II"); // リトルエンディアン
        tiff.extend_from_slice(&42u16.to_le_bytes()); // TIFF マジックナンバー
        tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 へのオフセット
        tiff.extend_from_slice(&1u16.to_le_bytes()); // IFD0 エントリ数
        tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // タグ: Orientation
        tiff.extend_from_slice(&3u16.to_le_bytes()); // 型: SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes()); // 個数
        tiff.extend_from_slice(&(orientation as u16).to_le_bytes());
        tiff.extend_from_slice(&[0u8, 0u8]); // value フィールドを4バイトへパディング
        tiff.extend_from_slice(&0u32.to_le_bytes()); // 次の IFD オフセット（無し）
        tiff
    }

    /// Orientation を含む APP1 (Exif) セグメントを組み立てる（JPEG用）。
    fn build_exif_app1_segment(orientation: u8) -> Vec<u8> {
        let tiff = build_exif_orientation_tiff(orientation);
        let mut app1 = vec![0xFFu8, 0xE1];
        let content_len = (2 + 6 + tiff.len()) as u16;
        app1.extend_from_slice(&content_len.to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        app1
    }

    /// テスト用のベース画像（16x32、非正方形で4象限を別の色に塗る）。
    /// 非正方形にすることで、90/270度回転時の幅高さ入替を検証できる。
    fn base_test_image() -> image::DynamicImage {
        let mut img = image::RgbImage::new(16, 32);
        for y in 0..32u32 {
            for x in 0..16u32 {
                let color = match (x < 8, y < 16) {
                    (true, true) => [255, 0, 0],     // 左上: 赤
                    (false, true) => [0, 255, 0],    // 右上: 緑
                    (true, false) => [0, 0, 255],    // 左下: 青
                    (false, false) => [255, 255, 0], // 右下: 黄
                };
                img.put_pixel(x, y, image::Rgb(color));
            }
        }
        image::DynamicImage::ImageRgb8(img)
    }

    /// EXIF Orientation を埋め込んだ小さな JPEG フィクスチャをディレクトリに書き出す（数KB）。
    ///
    /// 戻り値の `DynamicImage` は JPEG 圧縮を経た後（無回転）の画素データ。
    /// 期待値の算出はこれを基準にする必要がある（生の `base_test_image()` と比較すると
    /// JPEG の非可逆圧縮によるわずかな誤差で `assert_eq!` が失敗するため）。
    fn write_test_jpeg(dir: &Path, name: &str, orientation: u8) -> (PathBuf, image::DynamicImage) {
        let base = base_test_image();
        let mut jpeg_bytes = Vec::new();
        base.write_to(
            &mut std::io::Cursor::new(&mut jpeg_bytes),
            ImageFormat::Jpeg,
        )
        .expect("failed to encode base fixture jpeg");

        let decoded_base =
            image::load_from_memory(&jpeg_bytes).expect("failed to decode base fixture jpeg");

        // SOI (FFD8) の直後に自前の APP1(Exif) セグメントを差し込む
        let mut out = Vec::new();
        out.extend_from_slice(&jpeg_bytes[0..2]);
        out.extend_from_slice(&build_exif_app1_segment(orientation));
        out.extend_from_slice(&jpeg_bytes[2..]);

        let path = dir.join(name);
        std::fs::write(&path, &out).expect("failed to write fixture jpeg");
        (path, decoded_base)
    }

    /// 4色に塗った象限のうちどれか（サンプル点の分類に使う）。
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    enum Quadrant {
        Red,
        Green,
        Blue,
        Yellow,
    }

    /// stored 座標 (sx,sy) が `base_test_image()`（W=16,H=32）のどの象限かを返す。
    fn stored_quadrant(sx: u32, sy: u32) -> Quadrant {
        match (sx < 8, sy < 16) {
            (true, true) => Quadrant::Red,
            (false, true) => Quadrant::Green,
            (true, false) => Quadrant::Blue,
            (false, false) => Quadrant::Yellow,
        }
    }

    /// EXIF Orientation の定義（ExifTool/impulseadventure が示す標準的な幾何変換）から
    /// 独立に導出した「表示座標(dx,dy) → 元画像の格納座標(sx,sy)」の逆写像。
    ///
    /// image crate の `rotate90()`/`fliph()` 等を呼んで期待値を作ると、実装のバグを
    /// 実装自身でなぞって検証してしまう（#60 レビュー指摘）。ここでは EXIF 仕様が
    /// 定義する幾何操作（水平反転・180度回転・垂直反転・転置・90度回転・反転置・
    /// 270度回転）の数式を直接書き下し、image crate の実装を経由せずに期待値を得る。
    ///
    /// 導出（W=元画像幅, H=元画像高さ。転置系は表示サイズが H×W になる）:
    /// - 1 無変換:            (sx,sy) = (dx, dy)
    /// - 2 水平反転:          (sx,sy) = (W-1-dx, dy)
    /// - 3 180度回転:         (sx,sy) = (W-1-dx, H-1-dy)
    /// - 4 垂直反転:          (sx,sy) = (dx, H-1-dy)
    /// - 5 転置(主対角線反転): (sx,sy) = (dy, dx)                　※水平反転+270度回転と等価
    /// - 6 90度時計回り回転:   (sx,sy) = (dy, H-1-dx)
    /// - 7 反転置(反対角線反転):(sx,sy) = (W-1-dy, H-1-dx)         ※水平反転+90度回転と等価
    /// - 8 270度時計回り回転:  (sx,sy) = (W-1-dy, dx)
    fn stored_coord_for_display(orientation: u8, w: u32, h: u32, dx: u32, dy: u32) -> (u32, u32) {
        match orientation {
            1 => (dx, dy),
            2 => (w - 1 - dx, dy),
            3 => (w - 1 - dx, h - 1 - dy),
            4 => (dx, h - 1 - dy),
            5 => (dy, dx),
            6 => (dy, h - 1 - dx),
            7 => (w - 1 - dy, h - 1 - dx),
            8 => (w - 1 - dy, dx),
            _ => unreachable!("orientation must be 1..=8"),
        }
    }

    /// 実測ピクセルが期待象限の色に十分近いか（JPEG非可逆圧縮の誤差を許容）。
    fn color_matches_quadrant(actual: image::Rgb<u8>, expected: Quadrant, tol: i32) -> bool {
        let [er, eg, eb] = match expected {
            Quadrant::Red => [255u8, 0, 0],
            Quadrant::Green => [0, 255, 0],
            Quadrant::Blue => [0, 0, 255],
            Quadrant::Yellow => [255, 255, 0],
        };
        let [ar, ag, ab] = actual.0;
        (ar as i32 - er as i32).abs() <= tol
            && (ag as i32 - eg as i32).abs() <= tol
            && (ab as i32 - eb as i32).abs() <= tol
    }

    /// Orientation 1〜8 それぞれについて、EXIF 仕様の幾何定義から独立に導出した
    /// 期待象限位置（`stored_coord_for_display`）と実際の変換結果を象限サンプル点で
    /// 比較する（#60 レビュー must8: image crate の rotate/flip 関数を呼んで期待値を
    /// 作らない）。90/270度系で幅高さが入れ替わることも併せて検証する。
    #[test]
    fn orientation_1_to_8_matches_exif_geometric_definition() {
        const W: u32 = 16;
        const H: u32 = 32;

        let dir =
            std::env::temp_dir().join(format!("sss_orientation_fixture_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        for orientation in 1u8..=8 {
            let (path, _base) = write_test_jpeg(&dir, &format!("o{orientation}.jpg"), orientation);

            let img = load_and_orient(&path, true).expect("decode + orient should succeed");
            let (disp_w, disp_h) = img.dimensions();

            let (expected_w, expected_h) = if matches!(orientation, 5..=8) {
                (H, W)
            } else {
                (W, H)
            };
            assert_eq!(
                (disp_w, disp_h),
                (expected_w, expected_h),
                "orientation {orientation}: 表示サイズが期待値と不一致"
            );

            // get_display_dimensions もヘッダのみで同じ幅高さ入替を報告するはず
            let display_dims = get_display_dimensions(&path, true).expect("display dims");
            assert_eq!(display_dims, (expected_w, expected_h));

            let rgb = img.to_rgb8();

            // 各表示象限のサンプル点（境界から十分離し、JPEG圧縮の滲みを避ける）
            let quarter_w = disp_w / 4;
            let quarter_h = disp_h / 4;
            let sample_points = [
                ("top-left", quarter_w, quarter_h),
                ("top-right", disp_w - 1 - quarter_w, quarter_h),
                ("bottom-left", quarter_w, disp_h - 1 - quarter_h),
                (
                    "bottom-right",
                    disp_w - 1 - quarter_w,
                    disp_h - 1 - quarter_h,
                ),
            ];

            for (label, dx, dy) in sample_points {
                let (sx, sy) = stored_coord_for_display(orientation, W, H, dx, dy);
                let expected_quadrant = stored_quadrant(sx, sy);
                let actual = *rgb.get_pixel(dx, dy);
                assert!(
                    color_matches_quadrant(actual, expected_quadrant, 20),
                    "orientation {orientation} の {label} (dx={dx},dy={dy}): \
                     期待 {expected_quadrant:?} だが実測 {actual:?}"
                );
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_display_dimensions_without_rotation_keeps_raw_dims() {
        let dir =
            std::env::temp_dir().join(format!("sss_orientation_norotate_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Orientation 6 (90度回転が必要) でも apply_rotation=false なら入れ替えない
        let (path, _) = write_test_jpeg(&dir, "o6.jpg", 6);
        assert_eq!(
            get_display_dimensions(&path, false).expect("dims"),
            (16, 32)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_cache_file_skips_animation_capable_formats() {
        assert_eq!(
            plan_cache_file(
                Path::new("/tmp/does-not-matter.gif"),
                true,
                Path::new("/tmp/cache")
            ),
            None
        );
        assert_eq!(
            plan_cache_file(
                Path::new("/tmp/does-not-matter.webp"),
                true,
                Path::new("/tmp/cache")
            ),
            None
        );
    }

    #[test]
    fn plan_cache_file_forces_cache_for_webview_unsupported_format() {
        // TIFF は存在しない/回転不要でも WebView 非対応のため必ずキャッシュ対象
        // (get_display_dimensions がエラーでも (0,0) 扱いになり、他条件がFalseでも
        // unsupported_by_webview が true なのでキャッシュ対象になることを確認)
        let plan = plan_cache_file(
            Path::new("/tmp/does-not-exist.tiff"),
            false,
            Path::new("/tmp/cache"),
        );
        assert!(plan.is_some());
        assert!(plan.unwrap().extension().and_then(|e| e.to_str()) == Some("jpg"));
    }

    #[test]
    fn plan_cache_file_none_when_no_rotation_size_or_format_reason() {
        let dir = std::env::temp_dir().join(format!("sss_plan_cache_none_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Orientation 1（無回転）・4K未満・JPEG形式 → キャッシュ不要
        let (path, _) = write_test_jpeg(&dir, "o1.jpg", 1);
        assert_eq!(plan_cache_file(&path, true, &dir.join("cache")), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #60 レビュー方針転換: 回転は常にフロントの CSS（`image-orientation`）で行うため、
    /// EXIF回転が必要というだけではキャッシュを作らない（4K超でも TIFF等でもない限り）。
    /// apply_rotation の true/false どちらでも結果は変わらない。
    #[test]
    fn plan_cache_file_ignores_rotation_need_regardless_of_apply_rotation_setting() {
        let dir = std::env::temp_dir().join(format!(
            "sss_plan_cache_rotation_only_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Orientation 6 は90度回転が必要（16x32 が回転後32x16、いずれも4K未満・JPEG形式）
        let (path, _) = write_test_jpeg(&dir, "o6.jpg", 6);
        assert_eq!(
            plan_cache_file(&path, true, &dir.join("cache")),
            None,
            "回転のみが理由ではキャッシュ対象にならないはず（apply_rotation=true）"
        );
        assert_eq!(
            plan_cache_file(&path, false, &dir.join("cache")),
            None,
            "回転のみが理由ではキャッシュ対象にならないはず（apply_rotation=false）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// キャッシュキーには apply_rotation・mtime・サイズを含める（nit: 原本が
    /// 置き換わった場合に古いキャッシュを誤って使い回さないため）。
    /// 4K超で結局キャッシュ対象になるケースを使い、apply_rotation違いで
    /// 別のキャッシュファイルになることを確認する。
    #[test]
    fn plan_cache_file_key_varies_with_apply_rotation() {
        let dir = std::env::temp_dir().join(format!("sss_plan_cache_key_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let oversized = image::DynamicImage::ImageRgb8(image::RgbImage::new(MAX_WIDTH_4K + 1, 4));
        let path = dir.join("big.jpg");
        std::fs::write(&path, encode(&oversized, ImageFormat::Jpeg)).unwrap();

        let plan_true = plan_cache_file(&path, true, &dir.join("cache")).expect("4K超なので Some");
        let plan_false =
            plan_cache_file(&path, false, &dir.join("cache")).expect("4K超なので Some");
        assert_ne!(
            plan_true, plan_false,
            "apply_rotation違いは別キャッシュファイルになるはず"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 4K超のみが理由でキャッシュ対象になるケース（回転不要・WebView対応形式）。
    /// 拡張子ごとに出力フォーマットが分かれる（JPEGソース→jpg、PNGソース→png＝透過保持）
    /// ことも同時に検証する。
    #[test]
    fn plan_cache_file_some_when_oversized_only_and_extension_follows_source_format() {
        let dir =
            std::env::temp_dir().join(format!("sss_plan_cache_oversized_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 幅のみが4K超（3840を上回る）。高さは小さくして画素数を抑える。
        let oversized = image::DynamicImage::ImageRgb8(image::RgbImage::new(MAX_WIDTH_4K + 1, 4));

        let jpg_path = dir.join("big.jpg");
        std::fs::write(&jpg_path, encode(&oversized, ImageFormat::Jpeg)).unwrap();
        let jpg_plan = plan_cache_file(&jpg_path, true, &dir.join("cache"));
        assert!(jpg_plan.is_some(), "4K超のみでもキャッシュ対象になるはず");
        assert_eq!(
            jpg_plan.unwrap().extension().and_then(|e| e.to_str()),
            Some("jpg"),
            "JPEGソースはjpgでキャッシュされるはず"
        );

        let png_path = dir.join("big.png");
        std::fs::write(&png_path, encode(&oversized, ImageFormat::Png)).unwrap();
        let png_plan = plan_cache_file(&png_path, true, &dir.join("cache"));
        assert!(png_plan.is_some(), "4K超のみでもキャッシュ対象になるはず");
        assert_eq!(
            png_plan.unwrap().extension().and_then(|e| e.to_str()),
            Some("png"),
            "PNGソースは透過保持のためpngでキャッシュされるはず"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// テスト用: 画像を指定フォーマットでエンコードしたバイト列を返す。
    fn encode(img: &image::DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut buffer = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buffer), format)
            .expect("failed to encode test fixture");
        buffer
    }
}
